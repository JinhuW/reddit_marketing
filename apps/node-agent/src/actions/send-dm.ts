/**
 * `action.sendDm`: open Reddit's message compose form, fill `to`, `subject` and the approved body, send, and read
 * the new message's fullname. DMs are the main browser-fallback case (PLAN §14); the approval gate is upstream.
 */
import type { CmdOf, PostedData } from '@threadline/shared';
import type { HandlerResult } from '../registry';
import { dm as sel } from './selectors';
import { ActionError, type Session, goto } from './session';
import { type ConfirmOptions, afterSubmit, needsHuman } from './submit-comment';
import { detectWall } from './walls';

export type SendDmCmd = CmdOf<'action.sendDm'>;

/** `u/name`, `/u/name` and `/user/name` → `name`. */
export function recipientName(to: string): string {
  return to.trim().replace(/^\/?(u|user)\//i, '');
}

export function composeUrl(redditOrigin: string): string {
  return new URL('/message/compose/', redditOrigin).toString();
}

export async function sendDm(
  session: Session,
  cmd: SendDmCmd,
  opts: ConfirmOptions & { redditOrigin: string },
): Promise<HandlerResult> {
  const { page } = session;
  await goto(session, composeUrl(opts.redditOrigin));
  const wall = await detectWall(page);
  if (wall) return needsHuman(session, wall, false);

  const form = page.locator(sel.form).first();
  if ((await form.count()) === 0) throw new ActionError('compose_not_found', 'no message compose form');
  await form.locator(sel.to).first().fill(recipientName(cmd.to));
  await form.locator(sel.subject).first().fill(cmd.subject);
  await form.locator(sel.text).first().fill(cmd.body);

  const failedBefore = await form.locator(sel.failed).count();
  // The send click is inside the wrapper: it can reject after the message went out (see submitComment).
  return afterSubmit(async () => {
    await form.locator(sel.send).first().click();
    const end = Date.now() + Math.min(opts.confirmTimeoutMs, session.stepTimeout());
    const sent = form.locator(sel.sent);
    while (Date.now() < end) {
      if ((await sent.count()) > 0) {
        const fullname = (await sent.first().getAttribute('data-message-id')) ?? '';
        if (/^t4_[a-z0-9]+$/i.test(fullname))
          return { outcome: 'posted', data: { fullname } satisfies PostedData };
      }
      const w = await detectWall(page);
      if (w) return needsHuman(session, w, true);
      if ((await form.locator(sel.failed).count()) > failedBefore) {
        const text = (await form.locator(sel.failed).last().innerText()).trim();
        throw new ActionError('submit_rejected', `Reddit rejected the message: ${text.slice(0, 200)}`);
      }
      await page.waitForTimeout(opts.pollMs ?? 150);
    }
    throw new ActionError('post_unconfirmed', 'sent, but Reddit did not confirm the message in time');
  });
}
