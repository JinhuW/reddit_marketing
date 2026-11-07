import 'server-only';
import { decrypt, encrypt } from '@threadline/shared/crypto';
import { z } from 'zod';

/** Reddit OAuth2 (authorization code, duration=permanent) — docs/PLAN.md §6. */
export const REDDIT_SCOPES = ['identity', 'read', 'submit', 'privatemessages', 'history', 'edit'] as const;
export const STATE_COOKIE = 'tl_reddit_state';
export const PENDING_COOKIE = 'tl_reddit_pending';
export const PENDING_TTL_S = 15 * 60;

export const redditConfigured = () =>
  Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);

const redirectUri = () =>
  process.env.REDDIT_REDIRECT_URI ??
  `${process.env.APP_URL ?? 'http://localhost:3000'}/api/auth/reddit/callback`;
const userAgent = () => process.env.REDDIT_USER_AGENT ?? 'threadline/0.1';

export function authorizeUrl(state: string) {
  const u = new URL('https://www.reddit.com/api/v1/authorize');
  u.searchParams.set('client_id', process.env.REDDIT_CLIENT_ID ?? '');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('duration', 'permanent');
  u.searchParams.set('scope', REDDIT_SCOPES.join(' '));
  return u.toString();
}

export async function exchangeCode(code: string) {
  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString(
    'base64',
  );
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent(),
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Reddit token exchange failed (${res.status})`);
  return z
    .object({ access_token: z.string(), refresh_token: z.string(), scope: z.string() })
    .parse(await res.json());
}

export async function fetchMe(accessToken: string) {
  const res = await fetch('https://oauth.reddit.com/api/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': userAgent() },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Reddit identity lookup failed (${res.status})`);
  return z
    .object({
      id: z.string(),
      name: z.string(),
      total_karma: z.number().optional(),
      link_karma: z.number().optional(),
      comment_karma: z.number().optional(),
      created_utc: z.number(),
    })
    .parse(await res.json());
}

/** Authorized-but-not-finished connection, kept in an encrypted httpOnly cookie between steps 1 and 4. */
export const Pending = z.object({
  memberId: z.string(),
  username: z.string(),
  redditId: z.string(),
  karma: z.number(),
  createdUtc: z.number(),
  /** already encrypted with APP_ENCRYPTION_KEY */
  refreshEnc: z.string(),
  scopes: z.array(z.string()),
  exp: z.number(),
});
export type Pending = z.infer<typeof Pending>;

export const sealPending = (p: Pending) => encrypt(JSON.stringify(p));
export function openPending(raw: string | undefined, memberId: string): Pending | null {
  if (!raw) return null;
  try {
    const p = Pending.parse(JSON.parse(decrypt(raw)));
    return p.memberId === memberId && p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}
