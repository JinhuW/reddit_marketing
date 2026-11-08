/**
 * `profile.whoami` (plan 0002): who is signed in to this profile's browser. A fresh tab in the profile's own
 * context (its cookies, its proxy) loads `<redditOrigin>/api/me.json`; the identity is read from the response and
 * the tab is closed.
 *
 * - 200 with `data.name` → `{ loggedIn: true, name, id, totalKarma, createdUtc }` (checked by `WhoamiData`).
 * - 401 / 403, a body without a name, or a redirect to the login page → `{ loggedIn: false }`.
 * - A captcha or verification wall → `needs_human` (the tab stays open for the take-over), like the other actions.
 *
 * Never log the response body or cookies: only the status code ever reaches an error message.
 */
import { type CmdOf, WhoamiData } from '@threadline/shared';
import type { HandlerResult } from '../registry';
import { ActionError, type Session, goto } from './session';
import { needsHuman } from './submit-comment';
import { detectWall } from './walls';

export type WhoamiCmd = CmdOf<'profile.whoami'>;

export function meUrl(redditOrigin: string): string {
  return new URL('/api/me.json', redditOrigin).toString();
}

const NOT_LOGGED_IN: WhoamiData = { loggedIn: false };

export async function whoami(
  session: Session,
  _cmd: WhoamiCmd,
  opts: { redditOrigin: string },
): Promise<HandlerResult> {
  const res = await goto(session, meUrl(opts.redditOrigin));
  const wall = await detectWall(session.page);
  if (wall === 'login') return ok(NOT_LOGGED_IN);
  if (wall) return needsHuman(session, wall, false);
  if (!res) throw new ActionError('whoami_no_response', 'me.json gave no response');

  const status = res.status();
  if (status === 401 || status === 403) return ok(NOT_LOGGED_IN);
  if (status !== 200) throw new ActionError('whoami_http_error', `me.json answered HTTP ${status}`);

  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new ActionError('whoami_unreadable', 'me.json did not return JSON');
  }
  return ok(parseMe(body));
}

/**
 * The identity in a `me.json` body. Reddit wraps it as `{ kind: 't2', data: {...} }`; a flat object is accepted
 * too. No `name` means nobody is signed in (a logged-out `me.json` is `{}`).
 */
export function parseMe(body: unknown): WhoamiData {
  const outer = isRecord(body) ? body : {};
  const d = isRecord(outer.data) ? outer.data : outer;
  if (typeof d.name !== 'string' || d.name === '') return NOT_LOGGED_IN;

  const candidate: Record<string, unknown> = {
    loggedIn: true,
    name: d.name,
    id: typeof d.id === 'string' ? d.id.replace(/^t2_/, '') : d.id,
  };
  if (typeof d.total_karma === 'number' && Number.isInteger(d.total_karma))
    candidate.totalKarma = d.total_karma;
  if (typeof d.created_utc === 'number' && d.created_utc >= 0) candidate.createdUtc = d.created_utc;

  const parsed = WhoamiData.safeParse(candidate);
  if (!parsed.success) throw new ActionError('whoami_unreadable', 'me.json did not carry a valid identity');
  return parsed.data;
}

function ok(data: WhoamiData): HandlerResult {
  return { outcome: 'ok', data };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
