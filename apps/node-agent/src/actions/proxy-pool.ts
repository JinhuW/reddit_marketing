/**
 * Pool proxy commands that need no browser (plan 0004 phase 3).
 * - `proxy.check`: the agent's own request through the proxy to an IP echo, timed, plus a geo lookup and
 *   reddit.com (the same extras as `profile.testProxy`).
 * - `proxy.rotate`: calls a mobile proxy's change-IP link from this node. The link is user input, so only
 *   http(s) links whose host resolves to public addresses are called: nothing on the node's own network.
 *
 * Proxy credentials and the link (it carries the vendor token) are registered as secrets and never logged.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { CmdOf, ProxyCheckData, ProxyRotateData, ProxySpec } from '@threadline/shared';
import type { HandlerContext, HandlerMap, HandlerResult } from '../registry';
import { ProxyFetchError, fetchViaProxy } from './proxy-fetch';
import { DEFAULT_GEO_URL, DEFAULT_IP_URL, parseGeo, parseIp } from './test-proxy';

export interface ProxyPoolOptions {
  ipUrl?: string;
  /** null = skip the geo lookup */
  geoUrl?: string | null;
  /** null = skip the reachability check */
  redditUrl?: string | null;
  timeoutMs?: number;
  /** test seam: how a hostname resolves */
  resolve?: (host: string) => Promise<string[]>;
  /** test seam: the request to the change-IP link */
  call?: (url: string, signal: AbortSignal) => Promise<number>;
}

const fail = (code: string, message: string, outcome: 'error' | 'proxy_failed' = 'error'): HandlerResult => ({
  outcome,
  error: { code, message },
});

/** Timed IP echo through the proxy, then the optional extras. Throws ProxyFetchError when the proxy fails. */
export async function probeProxy(
  proxy: ProxySpec,
  o: {
    ipUrl: string;
    geoUrl: string | null;
    redditUrl: string | null;
    timeoutMs: number;
    signal: AbortSignal;
  },
): Promise<ProxyCheckData | null> {
  const t0 = Date.now();
  const res = await fetchViaProxy(o.ipUrl, proxy, { timeoutMs: o.timeoutMs, signal: o.signal });
  const latencyMs = Date.now() - t0;
  const ip = parseIp(res.body);
  if (!ip) return null;
  const extra = (url: string) =>
    fetchViaProxy(url, proxy, { timeoutMs: o.timeoutMs, signal: o.signal }).catch(() => null);
  const [geoRes, redditRes] = await Promise.all([
    o.geoUrl ? extra(o.geoUrl) : null,
    o.redditUrl ? extra(o.redditUrl) : null,
  ]);
  const geo = geoRes && geoRes.status === 200 ? parseGeo(geoRes.body) : null;
  return {
    ip,
    latencyMs,
    ...(o.redditUrl ? { redditOk: redditRes !== null && redditRes.status < 500 } : {}),
    ...(geo ? { geo } : {}),
  };
}

/** Loopback, private, link-local, CGNAT, multicast and unspecified addresses: never called by `proxy.rotate`. */
export function isPublicAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const [a = 0, b = 0] = addr.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (v === 6) {
    const x = addr.toLowerCase();
    if (x === '::' || x === '::1') return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPublicAddress(mapped[1] ?? '');
    // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff')) return false;
    return true;
  }
  return false;
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);
const defaultCall = async (url: string, signal: AbortSignal) => {
  // No redirects: a public link must not bounce the request to an address the check above refused.
  const res = await fetch(url, { method: 'GET', redirect: 'manual', signal });
  await res.body?.cancel().catch(() => undefined);
  return res.status;
};

export function createProxyPoolHandlers(
  options: ProxyPoolOptions = {},
): Pick<HandlerMap, 'proxy.check' | 'proxy.rotate'> {
  const ipUrl = options.ipUrl ?? DEFAULT_IP_URL;
  // Same rule as the connection test: a custom echo (tests) gets no live extras unless asked for.
  const geoUrl = options.geoUrl !== undefined ? options.geoUrl : options.ipUrl ? null : DEFAULT_GEO_URL;
  const redditUrl =
    options.redditUrl !== undefined
      ? options.redditUrl
      : options.ipUrl
        ? null
        : 'https://www.reddit.com/robots.txt';
  const timeoutMs = options.timeoutMs ?? 15_000;
  const resolve = options.resolve ?? defaultResolve;
  const call = options.call ?? defaultCall;

  return {
    'proxy.check': async (cmd: CmdOf<'proxy.check'>, ctx: HandlerContext) => {
      ctx.secrets.add(cmd.proxy.password);
      try {
        const data = await probeProxy(cmd.proxy, { ipUrl, geoUrl, redditUrl, timeoutMs, signal: ctx.signal });
        if (!data) return fail('no_agent_ip', 'the IP echo answered without an IP');
        return { outcome: 'ok', data };
      } catch (err) {
        const code = err instanceof ProxyFetchError ? err.code : 'agent_fetch_failed';
        ctx.log.warn({ proxyId: cmd.proxyId, code }, 'proxy check failed');
        return fail(code, 'the request through the proxy failed', 'proxy_failed');
      }
    },
    'proxy.rotate': async (cmd: CmdOf<'proxy.rotate'>, ctx: HandlerContext) => {
      ctx.secrets.add(cmd.url);
      let u: URL;
      try {
        u = new URL(cmd.url);
      } catch {
        return fail('bad_url', 'the change-IP link is not a URL');
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:')
        return fail('bad_url', 'the change-IP link must be http or https');
      const host = u.hostname.replace(/^\[|\]$/g, '');
      let addrs: string[];
      try {
        addrs = isIP(host) ? [host] : await resolve(host);
      } catch {
        return fail('unresolvable', 'the change-IP link host does not resolve');
      }
      if (addrs.length === 0 || !addrs.every(isPublicAddress))
        return fail('private_address', 'the change-IP link points at a private address; not called');
      const timer = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        const status = await call(u.toString(), timer);
        const data: ProxyRotateData = { status };
        ctx.log.info({ proxyId: cmd.proxyId, status }, 'change-IP link called');
        return status >= 200 && status < 400
          ? { outcome: 'ok', data }
          : fail('rotate_refused', `the change-IP link answered ${status}`);
      } catch {
        return fail('rotate_failed', 'the change-IP link did not answer');
      }
    },
  };
}
