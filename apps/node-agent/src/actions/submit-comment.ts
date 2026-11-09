/**
 * `action.submitComment`: open the thread, find the composer under `parentFullname` (the post's top-level
 * composer, or a comment's Reply), type the approved body, submit, and read the new comment's fullname.
 *
 * The approval gate lives upstream: the gateway only sends this command for a Draft that is approved and has an
 * `approverMemberId` (plan §3.3, CLAUDE.md). This module posts exactly the body it was given, once.
 */
import type { CmdOf, PostedData } from '@threadline/shared';
import type { Locator } from 'playwright-core';
import type { HandlerResult } from '../registry';
import { type HumanOptions, humanClick, typeText } from './human';
import { comment as sel } from './selectors';
import { ActionError, type Session, goto } from './session';
import { type Wall, detectWall } from './walls';

export type SubmitCommentCmd = CmdOf<'action.submitComment'>;

export interface ConfirmOptions {
  /** How long to wait for Reddit to show the new item after submit. */
  confirmTimeoutMs: number;
  pollMs?: number;
  /** Pacing of clicks and typing; tests pass a no-op sleep. */
  human?: HumanOptions;
}

export async function submitComment(
  session: Session,
  cmd: SubmitCommentCmd,
  opts: ConfirmOptions,
): Promise<HandlerResult> {
  const { page } = session;
  const parent = cmd.parentFullname.toLowerCase();

  await goto(session, cmd.threadUrl);
  const wall = await detectWall(page);
  if (wall) return needsHuman(session, wall, false);

  let form: Locator;
  if (parent.startsWith('t3_')) {
    const host = page.locator(sel.topHost(parent));
    if ((await host.count()) === 0) throw new ActionError('composer_not_found', `no composer for ${parent}`);
    form = host.locator(sel.form).first();
    if (!(await form.isVisible())) await humanClick(page, host.locator(sel.topTrigger).first(), opts.human);
  } else {
    let target = page.locator(sel.byFullname(parent));
    if ((await target.count()) === 0) {
      // Deep or collapsed comment: its permalink renders it with the reply composer open.
      await goto(session, permalink(cmd.threadUrl, parent));
      const w = await detectWall(page);
      if (w) return needsHuman(session, w, false);
      target = page.locator(sel.byFullname(parent));
      if ((await target.count()) === 0)
        throw new ActionError('parent_not_found', `${parent} is not on the page`);
    }
    target = target.first();
    form = target.locator(sel.ownComposer);
    if ((await form.count()) === 0)
      await humanClick(page, target.locator(sel.replyButton).first(), opts.human);
    form = target.locator(sel.ownComposer).first();
  }

  await form.waitFor({ state: 'visible' });
  const box = form.locator(sel.textbox).first();
  await humanClick(page, box, opts.human);
  await typeText(page, cmd.body, opts.human);
  const submit = form.locator(sel.submit).first();
  await waitEnabled(submit, session.stepTimeout());

  const children = page.locator(sel.childrenOf(parent));
  const before = new Set(await fullnames(children));
  const errorsBefore = await form.locator(sel.error).count();

  // From the click on, the comment may exist on Reddit: a failure is "unconfirmed", never retried here. The click
  // itself is inside the wrapper because it can reject after the submit went out (a navigation it started outlived
  // the step timeout, or the deadline abort closed the browser mid-click).
  return afterSubmit(async () => {
    await humanClick(page, submit, opts.human);
    const end = Date.now() + Math.min(opts.confirmTimeoutMs, session.stepTimeout());
    while (Date.now() < end) {
      const fresh = (await fullnames(children)).find((f) => !before.has(f) && /^t1_[a-z0-9]+$/i.test(f));
      if (fresh) return { outcome: 'posted', data: { fullname: fresh } satisfies PostedData };
      const w = await detectWall(page);
      if (w) return needsHuman(session, w, true);
      if ((await form.locator(sel.error).count()) > errorsBefore) {
        const text = (await form.locator(sel.error).last().innerText()).trim();
        throw new ActionError('submit_rejected', `Reddit rejected the comment: ${text.slice(0, 200)}`);
      }
      await page.waitForTimeout(opts.pollMs ?? 150);
    }
    throw new ActionError('post_unconfirmed', 'submitted, but the new comment did not appear in time');
  });
}

/**
 * Runs the submit click and the confirmation step after it. Anything but a deliberate {@link ActionError} (a dropped CDP
 * connection, the deadline abort, a page crash) means we cannot tell whether Reddit kept the item.
 */
export async function afterSubmit(confirm: () => Promise<HandlerResult>): Promise<HandlerResult> {
  try {
    return await confirm();
  } catch (err) {
    if (err instanceof ActionError) throw err;
    throw new ActionError(
      'post_unconfirmed',
      `submitted, but confirmation failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    );
  }
}

/** `https://…/comments/<id>/<slug>/` + `<commentId>/`, without query or hash. */
export function permalink(threadUrl: string, commentFullname: string): string {
  const u = new URL(threadUrl);
  u.search = '';
  u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.pathname += `${commentFullname.replace(/^t1_/i, '')}/`;
  return u.toString();
}

export function needsHuman(session: Session, wall: Wall, submitted: boolean): HandlerResult {
  // The owner takes over over VNC and sees the wall in this tab.
  session.keepPage();
  return {
    outcome: 'needs_human',
    data: { wall, submitted },
    error: { code: `${wall}_wall`, message: `Reddit showed a ${wall} wall; a human has to take over` },
  };
}

/** The slice of a DOM element the page function uses (the package has no DOM lib). */
interface ThingEl {
  getAttribute(name: string): string | null;
}

async function fullnames(loc: Locator): Promise<string[]> {
  const ids: unknown = await loc.evaluateAll((els: ThingEl[]) =>
    els.map((e) => e.getAttribute('thingid') ?? ''),
  );
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

async function waitEnabled(loc: Locator, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await loc.isEnabled())) {
    if (Date.now() > end) throw new ActionError('submit_disabled', 'the submit button stayed disabled');
    await new Promise((r) => setTimeout(r, 50));
  }
}
