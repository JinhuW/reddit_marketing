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
  opts: { ipUrl: string; proxy: ProxySpec | null; signal: AbortSignal },
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
  try {
    const res = await fetchViaProxy(opts.ipUrl, opts.proxy, {
      timeoutMs: session.stepTimeout(),
      signal: opts.signal,
    });
    agentIp = parseIp(res.body);
    if (!agentIp)
      throw new ActionError('no_agent_ip', `IP echo answered ${res.status} without an IP from the agent`);
  } catch (err) {
    if (err instanceof ActionError) throw err;
    const code = err instanceof ProxyFetchError ? err.code : 'agent_fetch_failed';
    throw new ActionError(code, `agent request through the proxy failed: ${errMessage(err)}`, 'proxy_failed');
  }

  const data: TestProxyData = { pageIp, agentIp };
  return { outcome: 'ok', data };
}
