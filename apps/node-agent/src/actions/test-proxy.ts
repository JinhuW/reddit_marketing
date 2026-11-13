/**
 * `profile.testProxy`: the exit IP seen from the page (a `fetch()` inside the profile's browser, so it goes through
 * the container's proxy exactly like Reddit traffic) and from the agent (its own request through the same proxy).
 * The gateway (T31) geolocates both and fails the test when they differ from what the proxy should give.
 */
import { isIP } from 'node:net';
import type { CmdOf, ProxySpec, TestProxyData } from '@threadline/shared';
import type { HandlerResult } from '../registry';
import { ProxyFetchError, fetchViaProxy } from './proxy-fetch';
import { ActionError, type Session, errMessage, goto } from './session';

export type TestProxyCmd = CmdOf<'profile.testProxy'>;

/** Default IP echo: answers `{"ip":"…"}` with `Access-Control-Allow-Origin: *`. */
export const DEFAULT_IP_URL = 'https://api.ipify.org?format=json';
/** Default geo lookup: answers `{ city, country, loc: "lat,lon", timezone }` for the caller's (the proxy's) IP. */
export const DEFAULT_GEO_URL = 'https://ipinfo.io/json';

export type ProxyGeo = NonNullable<TestProxyData['geo']>;

/**
 * Reads a geo answer. Accepts the ipinfo shape (`loc: "lat,lon"`, `timezone`) and the common
 * `latitude` / `longitude` / `timezone.id` variants; anything unreadable is left out.
 */
export function parseGeo(text: string): ProxyGeo | null {
  let j: Record<string, unknown>;
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object') return null;
    j = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
  const tzRaw =
    j.timezone && typeof j.timezone === 'object' ? (j.timezone as { id?: unknown }).id : j.timezone;
  let lat = typeof j.latitude === 'number' ? j.latitude : undefined;
  let lon = typeof j.longitude === 'number' ? j.longitude : undefined;
  if (typeof j.loc === 'string') {
    const [a, b] = j.loc.split(',').map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      lat = a;
      lon = b;
    }
  }
  const inRange = lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const geo: ProxyGeo = {
    city: str(j.city, 120),
    country: str(j.country_code, 80) ?? str(j.country, 80),
    timeZone: str(tzRaw, 64),
    ...(inRange ? { lat, lon } : {}),
  };
  for (const k of Object.keys(geo) as (keyof ProxyGeo)[]) if (geo[k] === undefined) delete geo[k];
  return Object.keys(geo).length ? geo : null;
}

/** First IPv4/IPv6 address in an echo body: `{"ip":"…"}` or plain text. */
export function parseIp(text: string): string | null {
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === 'object' && 'ip' in j && typeof j.ip === 'string' && isIP(j.ip.trim()))
      return j.ip.trim();
  } catch {
    // plain text
  }
  for (const t of text.split(/[\s,"{}]+/)) if (t && isIP(t)) return t;
  return null;
}

export async function testProxy(
  session: Session,
  _cmd: TestProxyCmd,
  opts: {
    ipUrl: string;
    proxy: ProxySpec | null;
    signal: AbortSignal;
    /** geo lookup through the proxy; null = skip */
    geoUrl?: string | null;
    /** checked for reachability through the proxy; null = skip */
    redditUrl?: string | null;
  },
): Promise<HandlerResult> {
  // Page side: load the echo origin, then fetch() from inside the page.
  await goto(session, opts.ipUrl);
  let pageText: string;
  try {
    pageText = await session.page.evaluate(async (u: string) => {
      const r = await fetch(u, { credentials: 'omit' });
      return `${r.status}\n${await r.text()}`;
    }, opts.ipUrl);
  } catch (err) {
    throw new ActionError(
      'page_fetch_failed',
      `fetch() in the page failed: ${errMessage(err).split('\n')[0]}`,
      'proxy_failed',
    );
  }
  const [status, ...rest] = pageText.split('\n');
  if (status === '407')
    throw new ActionError('proxy_auth_failed', 'proxy rejected the credentials', 'proxy_failed');
  const pageIp = parseIp(rest.join('\n'));
  if (!pageIp) throw new ActionError('no_page_ip', `IP echo answered ${status} without an IP from the page`);

  // Agent side: the same echo through the same proxy, from the node.
  let agentIp: string | null;
  const t0 = Date.now();
  let latencyMs: number;
  try {
    const res = await fetchViaProxy(opts.ipUrl, opts.proxy, {
      timeoutMs: session.stepTimeout(),
      signal: opts.signal,
    });
    latencyMs = Date.now() - t0;
    agentIp = parseIp(res.body);
    if (!agentIp)
      throw new ActionError('no_agent_ip', `IP echo answered ${res.status} without an IP from the agent`);
  } catch (err) {
    if (err instanceof ActionError) throw err;
    const code = err instanceof ProxyFetchError ? err.code : 'agent_fetch_failed';
    throw new ActionError(code, `agent request through the proxy failed: ${errMessage(err)}`, 'proxy_failed');
  }

  // Extras: never fail the test. A lookup that does not answer just leaves its field out.
  const extra = async (url: string) =>
    fetchViaProxy(url, opts.proxy, { timeoutMs: session.stepTimeout(), signal: opts.signal }).catch(
      () => null,
    );
  const [geoRes, redditRes] = await Promise.all([
    opts.geoUrl ? extra(opts.geoUrl) : null,
    opts.redditUrl ? extra(opts.redditUrl) : null,
  ]);
  const geo = geoRes && geoRes.status === 200 ? parseGeo(geoRes.body) : null;
  const data: TestProxyData = {
    pageIp,
    agentIp,
    latencyMs,
    ...(opts.redditUrl ? { redditOk: redditRes !== null && redditRes.status < 500 } : {}),
    ...(geo ? { geo } : {}),
  };
  return { outcome: 'ok', data };
}
