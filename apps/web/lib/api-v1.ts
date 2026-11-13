import 'server-only';
// Plan 0004 phase 7: the browser management API (/api/v1). Bearer keys only (no session cookie), JSON in and
// out. A key acts as the member it belongs to, through the same permission functions the pages use. The API
// manages browsers and proxies; it has no route that posts, drives a page, opens a debugging port or returns a
// cookie, a proxy login or an account password.
import { apiKeys, browsers } from '@threadline/db';

export type ApiMember = NonNullable<Awaited<ReturnType<typeof apiKeys.verifyApiKey>>>;

/** Requests one key may make per minute (per web instance). */
export const API_RATE_PER_MIN = 120;
const windows = new Map<string, { start: number; count: number }>();

function limited(keyId: string, now: number): boolean {
  const w = windows.get(keyId);
  if (!w || now - w.start >= 60_000) {
    windows.set(keyId, { start: now, count: 1 });
    if (windows.size > 5000) for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
    return false;
  }
  w.count++;
  return w.count > API_RATE_PER_MIN;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
export const fail = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

/** Thrown by a handler to answer with an error. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Wraps a route: authenticates the key, applies the rate limit, and turns known errors into JSON. */
export function api<C>(handler: (me: ApiMember, req: Request, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
    if (!m?.[1]) return fail(401, 'unauthorized', 'Send the API key as "Authorization: Bearer <key>".');
    const me = await apiKeys.verifyApiKey(m[1]);
    if (!me) return fail(401, 'unauthorized', 'Unknown or revoked API key.');
    if (limited(me.keyId, Date.now()))
      return json(
        {
          error: { code: 'rate_limited', message: `At most ${API_RATE_PER_MIN} requests a minute per key.` },
        },
        429,
        { 'retry-after': '60' },
      );
    try {
      return await handler(me, req, ctx);
    } catch (e) {
      if (e instanceof ApiError) return fail(e.status, e.code, e.message);
      if (e instanceof browsers.BrowserManageError || e instanceof browsers.BrowserAssignError)
        return fail(400, 'invalid', e.message);
      throw e;
    }
  };
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = (await req.json()) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // not JSON
  }
  throw new ApiError(400, 'invalid', 'The body must be a JSON object.');
}

type Row = browsers.ProfileRow;
/** A browser as the API shows it. No cookie, login, password, fingerprint seed or encrypted field. */
export function browserJson(r: Row) {
  return {
    id: r.id,
    number: r.serial,
    name: r.name,
    status: r.status,
    group: r.group ? { id: r.group.id, name: r.group.name } : null,
    tags: r.tags.map((t) => t.name),
    notes: r.notes,
    startUrl: r.startUrl,
    account: r.account && !r.account.username.startsWith('pending-') ? r.account.username : null,
    proxy: r.proxy
      ? { id: r.proxy.id, protocol: r.proxy.protocol, host: r.proxy.host, port: r.proxy.port }
      : null,
    nodeId: r.nodeId,
    lastSessionAt: r.lastSessionAt,
    createdAt: r.createdAt,
  };
}
