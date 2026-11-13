/**
 * Plan 0004 phase 4: `profile.exportCookies` and `profile.clearData`, over the same CDP session as the other
 * actions. Cookie values are secrets: nothing here logs one, and they are deliberately NOT registered with the
 * secret scrubber, because the scrubber would then blank them out of the very result that has to carry them.
 */
import {
  type BrowserCookie,
  type CmdOf,
  EXPORT_COOKIES_MAX,
  type ExportCookiesData,
} from '@threadline/shared';
import type { HandlerContext, HandlerResult } from '../registry';
import { ActionError, type Session, errMessage } from './session';

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);

/** Every cookie of the profile's browser, in the shape `profile.signIn` imports. */
export async function exportCookies(
  session: Session,
  _cmd: CmdOf<'profile.exportCookies'>,
  ctx: Pick<HandlerContext, 'log'>,
): Promise<HandlerResult> {
  let raw: Awaited<ReturnType<ReturnType<Session['page']['context']>['cookies']>>;
  try {
    raw = await session.page.context().cookies();
  } catch (err) {
    throw new ActionError(
      'cookies_unreadable',
      `could not read the cookies: ${errMessage(err).split('\n')[0]}`,
    );
  }
  const cookies: BrowserCookie[] = [];
  for (const c of raw) {
    if (!c.name || !c.domain) continue;
    cookies.push({
      name: c.name.slice(0, 256),
      value: c.value.slice(0, 8192),
      domain: c.domain,
      path: c.path?.startsWith('/') ? c.path : '/',
      expires: c.expires > 0 ? Math.floor(c.expires) : -1,
      httpOnly: c.httpOnly === true,
      secure: c.secure === true,
      sameSite: SAME_SITE.has(c.sameSite) ? c.sameSite : 'Lax',
    });
    if (cookies.length >= EXPORT_COOKIES_MAX) break;
  }
  const truncated = raw.length > cookies.length && cookies.length >= EXPORT_COOKIES_MAX;
  ctx.log.info({ count: cookies.length, truncated }, 'cookies exported');
  const data: ExportCookiesData = { cookies, ...(truncated ? { truncated } : {}) };
  return { outcome: 'ok', data };
}

/** Clears cookies (every site is signed out) and / or the HTTP cache of the profile's browser. */
export async function clearData(
  session: Session,
  cmd: CmdOf<'profile.clearData'>,
  ctx: Pick<HandlerContext, 'log'>,
): Promise<HandlerResult> {
  const context = session.page.context();
  try {
    if (cmd.cookies) await context.clearCookies();
    if (cmd.cache) {
      const cdp = await context.newCDPSession(session.page);
      try {
        await cdp.send('Network.clearBrowserCache');
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    }
  } catch (err) {
    throw new ActionError(
      'clear_failed',
      `could not clear the browser data: ${errMessage(err).split('\n')[0]}`,
    );
  }
  ctx.log.info({ cookies: cmd.cookies, cache: cmd.cache }, 'browser data cleared');
  return { outcome: 'ok', data: { cookies: cmd.cookies, cache: cmd.cache } };
}
