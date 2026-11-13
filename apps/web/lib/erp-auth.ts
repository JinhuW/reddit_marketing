/**
 * Sign-in with Recycle Servers ERP credentials. The ERP stays the only place passwords live: Threadline
 * forwards the email + password once to the ERP's login endpoint and keeps nothing but the email, name
 * and role it returns. The ERP refresh token minted by that login is revoked right away.
 */
import type { MemberRole } from '@threadline/shared';

export type ErpUser = { email: string; name: string; role: string };

export type ErpLoginResult =
  | { ok: true; user: ErpUser }
  | { ok: false; reason: 'invalid' | 'locked' | 'unavailable' };

export const erpConfigured = () => Boolean(process.env.ERP_API_URL);

/** ERP managers administer and approve; everyone else on the ERP joins as an Editor (no approval rights). */
export function memberRoleForErp(erpRole: string): { role: MemberRole; canApprove: boolean } {
  return erpRole === 'manager' ? { role: 'admin', canApprove: true } : { role: 'editor', canApprove: false };
}

/** Pulls `rt=<value>` out of the login response's Set-Cookie headers. */
export function refreshCookie(setCookies: string[]): string | null {
  for (const c of setCookies) {
    const m = /^rt=([^;]+)/.exec(c.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

export async function erpLogin(
  email: string,
  password: string,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<ErpLoginResult> {
  const base = (opts.baseUrl ?? process.env.ERP_API_URL ?? '').replace(/\/+$/, '');
  if (!base) return { ok: false, reason: 'unavailable' };
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Requested-By': 'recycle-erp' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (res.status === 400 || res.status === 401) return { ok: false, reason: 'invalid' };
  if (res.status === 429) return { ok: false, reason: 'locked' };
  if (!res.ok) return { ok: false, reason: 'unavailable' };

  const body = (await res.json().catch(() => null)) as {
    user?: { email?: unknown; name?: unknown; role?: unknown };
  } | null;
  const u = body?.user;
  if (typeof u?.email !== 'string' || !u.email) return { ok: false, reason: 'unavailable' };

  // Revoke the ERP session this login created; Threadline keeps its own.
  const rt = refreshCookie(res.headers.getSetCookie?.() ?? []);
  if (rt) {
    await f(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { 'X-Requested-By': 'recycle-erp', cookie: `rt=${rt}` },
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    }).catch(() => undefined);
  }

  return {
    ok: true,
    user: {
      email: u.email.toLowerCase(),
      name: typeof u.name === 'string' ? u.name : u.email,
      role: typeof u.role === 'string' ? u.role : '',
    },
  };
}
