import { timingSafeEqual } from 'node:crypto';

/**
 * In-process handshake between the custom server (server.ts) and the VNC route handler
 * (app/api/vnc/[profileId]/route.ts).
 *
 * The websocket upgrade is handled by server.ts, outside Next's request context, so it cannot call
 * `getCurrentMember()` itself. It replays the upgrade's cookies as a `POST /api/vnc/<profileId>` to its own
 * port, and the route handler does the session, role and take-over checks with the same code every page uses.
 * The POST is accepted only with this header carrying a random key that server.ts generates at boot and
 * keeps in the process environment; a plain `next dev` / `next start` has no key and the POST answers 404.
 */
export const VNC_AUTHZ_HEADER = 'x-tl-vnc-authorize';
export const VNC_AUTHZ_ENV = 'TL_VNC_AUTHORIZE_KEY';

/** What the route handler returns to server.ts when a member may open the profile's display. */
export interface VncGrant {
  workspaceId: string;
  profileId: string;
  memberId: string;
  /** The open human BrowserSession this connection belongs to. */
  sessionId: string;
}

/** Constant-time check of the header against the key server.ts set; false when no key is set. */
export function authorizeKeyMatches(presented: string | null | undefined, env = process.env): boolean {
  const expected = env[VNC_AUTHZ_ENV];
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
