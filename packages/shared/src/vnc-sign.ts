/**
 * The one web → gateway VNC URL signature (server only: uses node:crypto). Both sides import it from here; they
 * used to carry their own copies, which drifted apart (web signed `tl-vnc.v1` in hex, the gateway checked
 * `tl-vnc-internal.v1` in base64url) and every VNC connection was refused with 403 "bad signature".
 *
 *   path  = /internal/vnc/<profileId>
 *   exp   = unix seconds, at most {@link INTERNAL_URL_MAX_TTL_SEC} ahead
 *   sig   = base64url(HMAC-SHA256(GATEWAY_INTERNAL_SECRET, "tl-vnc-internal.v1\n<profileId>\n<sessionId>\n<exp>"))
 *   query = ?session=<sessionId>&exp=<exp>&sig=<sig>
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const INTERNAL_VNC_PREFIX = '/internal/vnc/';
/** The longest an internal URL may stay valid; the web side signs right before it dials. */
export const INTERNAL_URL_MAX_TTL_SEC = 60;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function hmac(secret: string, message: string): Buffer {
  return createHmac('sha256', secret).update(message).digest();
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const internalMessage = (profileId: string, sessionId: string, exp: number) =>
  `tl-vnc-internal.v1\n${profileId}\n${sessionId}\n${exp}`;

/** Path and query (`/internal/vnc/<profileId>?session=…&exp=…&sig=…`) for one connection. */
export function signInternalVncUrl(
  secret: string,
  input: { profileId: string; sessionId: string; now?: number; ttlSec?: number },
): string {
  const exp = Math.floor((input.now ?? Date.now()) / 1000) + (input.ttlSec ?? INTERNAL_URL_MAX_TTL_SEC);
  const sig = hmac(secret, internalMessage(input.profileId, input.sessionId, exp)).toString('base64url');
  const q = new URLSearchParams({ session: input.sessionId, exp: String(exp), sig });
  return `${INTERNAL_VNC_PREFIX}${encodeURIComponent(input.profileId)}?${q}`;
}

export type InternalCheck =
  | { ok: true; profileId: string; sessionId: string }
  | { ok: false; status: 400 | 403; reason: string };

/** Verifies a URL signed with {@link signInternalVncUrl}. `url.pathname` must start with the prefix. */
export function verifyInternalVncUrl(secret: string, url: URL, now = Date.now()): InternalCheck {
  const profileId = decodeURIComponent(url.pathname.slice(INTERNAL_VNC_PREFIX.length));
  const sessionId = url.searchParams.get('session') ?? '';
  const expRaw = url.searchParams.get('exp') ?? '';
  const sig = url.searchParams.get('sig') ?? '';
  if (!ID_RE.test(profileId) || !ID_RE.test(sessionId) || !/^\d{1,12}$/.test(expRaw) || !sig)
    return { ok: false, status: 400, reason: 'malformed request' };
  const exp = Number(expRaw);
  const nowSec = Math.floor(now / 1000);
  const want = hmac(secret, internalMessage(profileId, sessionId, exp));
  if (!sameBytes(Buffer.from(sig, 'base64url'), want))
    return { ok: false, status: 403, reason: 'bad signature' };
  if (exp < nowSec) return { ok: false, status: 403, reason: 'expired' };
  if (exp - nowSec > INTERNAL_URL_MAX_TTL_SEC + 5)
    return { ok: false, status: 403, reason: 'expiry too far ahead' };
  return { ok: true, profileId, sessionId };
}
