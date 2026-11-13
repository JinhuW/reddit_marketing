import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canLaunchChromium, startFakeCdpTarget } from '@threadline/node-testkit/fake-cdp';
import type { ProxySpec } from '@threadline/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../log';
import { SecretSet } from '../log';
import type { HandlerContext } from '../registry';
import { StatusStore } from '../status';
import { testConfig } from '../testing/helpers';
import { createActionHandlers } from './index';
import { ProxyFetchError, fetchViaProxy, openTunnel } from './proxy-fetch';
import { type TestProxy, launchCdpBrowser, startHttpProxy, startSocks5Proxy } from './testing/proxies';

const USER = 'tl-user';
const PASS = 'proxy-pass-s3cret';
const ECHO_IP = '192.0.2.44';

let echo: Server;
let echoUrl: string;
let http: TestProxy;
let socks: TestProxy;

beforeAll(async () => {
  echo = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ip: ECHO_IP, path: req.url }));
  });
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  echoUrl = `http://127.0.0.1:${(echo.address() as AddressInfo).port}/ip`;
  http = await startHttpProxy(USER, PASS);
  socks = await startSocks5Proxy(USER, PASS);
});

afterAll(async () => {
  await http?.close();
  await socks?.close();
  echo?.closeAllConnections();
  await new Promise<void>((r) => echo?.close(() => r()));
});

const httpProxy = (password = PASS): ProxySpec => ({
  protocol: 'http',
  host: '127.0.0.1',
  port: http.port,
  username: USER,
  password,
});
const socksProxy = (password = PASS): ProxySpec => ({
  protocol: 'socks5',
  host: '127.0.0.1',
  port: socks.port,
  username: USER,
  password,
});

async function rejection(p: Promise<unknown>): Promise<ProxyFetchError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProxyFetchError);
  return err as ProxyFetchError;
}

describe('fetchViaProxy (agent side of the connection test)', () => {
  it('goes through an HTTP proxy with basic auth', async () => {
    const from = http.hits.length;
    const res = await fetchViaProxy(echoUrl, httpProxy(), { timeoutMs: 5_000 });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ip).toBe(ECHO_IP);
    expect(http.hits.slice(from)).toEqual([expect.objectContaining({ kind: 'forward', authorized: true })]);
  });

  it('reports bad HTTP proxy credentials without echoing them', async () => {
    const err = await rejection(fetchViaProxy(echoUrl, httpProxy('wrong-pass'), { timeoutMs: 5_000 }));
    expect(err.code).toBe('proxy_auth_failed');
    expect(err.message).not.toContain('wrong-pass');
  });

  it('opens a CONNECT tunnel through an HTTP proxy', async () => {
    const { port } = new URL(echoUrl);
    const sock = await openTunnel(httpProxy(), '127.0.0.1', Number(port), 5_000);
    const text = await new Promise<string>((resolve, reject) => {
      let buf = '';
      sock.on('data', (c: Buffer) => {
        buf += c.toString();
      });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
      sock.write('GET /ip HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n');
    });
    expect(text).toMatch(/^HTTP\/1\.[01] 200/);
    expect(text).toContain(ECHO_IP);
    expect(http.hits.at(-1)).toMatchObject({ kind: 'connect', authorized: true });
  });

  it('refuses a CONNECT tunnel with bad credentials', async () => {
    const err = await rejection(openTunnel(httpProxy('nope-nope'), '127.0.0.1', 80, 5_000));
    expect(err.code).toBe('proxy_auth_failed');
  });

  it('goes through a SOCKS5 proxy with username/password auth', async () => {
    const from = socks.hits.length;
    const res = await fetchViaProxy(echoUrl, socksProxy(), { timeoutMs: 5_000 });
    expect(JSON.parse(res.body).ip).toBe(ECHO_IP);
    expect(socks.hits.slice(from)).toEqual([
      { kind: 'socks', target: `127.0.0.1:${new URL(echoUrl).port}`, authorized: true },
    ]);
  });

  it('reports bad SOCKS5 credentials', async () => {
    const err = await rejection(fetchViaProxy(echoUrl, socksProxy('bad-pass'), { timeoutMs: 5_000 }));
    expect(err.code).toBe('proxy_auth_failed');
  });

  it('reports an unreachable proxy', async () => {
    const err = await rejection(
      fetchViaProxy(echoUrl, { protocol: 'socks5', host: '127.0.0.1', port: 1 }, { timeoutMs: 2_000 }),
    );
    expect(err.code).toBe('proxy_unreachable');
  });
});

const available = await canLaunchChromium();

describe.skipIf(!available)('profile.testProxy through a credentialed proxy', { timeout: 60_000 }, () => {
  it('answers the proxy challenge over CDP Fetch.authRequired and reads both exit IPs', async () => {
    // The fixture site plays the IP echo; the browser reaches it only through the proxy.
    const site = await startFakeCdpTarget({ pageIp: '198.51.100.99' });
    const browser = await launchCdpBrowser([
      `--proxy-server=http://127.0.0.1:${http.port}`,
      '--proxy-bypass-list=<-loopback>',
    ]);
    try {
      const ctx = (): HandlerContext => ({
        cmdId: 'bj-profile.testProxy-p',
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 30_000,
        log: createLogger({ level: 'silent' }),
        config: testConfig(),
        status: new StatusStore(8),
        secrets: new SecretSet(),
      });
      const make = (password: string) =>
        createActionHandlers({
          cdpUrlFor: () => browser.cdpUrl,
          proxyFor: () => httpProxy(password),
          ipUrl: site.urls.ip,
          stepTimeoutMs: 8_000,
        });
      const cmd = { kind: 'profile.testProxy', profileId: 'p' } as const;

      const from = http.hits.length;
      const ok = await make(PASS)['profile.testProxy']!(cmd, ctx());
      expect(ok).toEqual({
        outcome: 'ok',
        data: { pageIp: '198.51.100.99', agentIp: '198.51.100.99', latencyMs: expect.any(Number) },
      });
      const hits = http.hits.slice(from);
      // Chromium first hits the proxy without credentials (407), then retries with the ones CDP supplied.
      expect(hits.some((h) => !h.authorized && /Chrome/.test(h.userAgent ?? ''))).toBe(true);
      expect(hits.some((h) => h.authorized && /Chrome/.test(h.userAgent ?? ''))).toBe(true);
      // The agent's own request went through the same proxy.
      expect(hits.some((h) => h.authorized && !/Chrome/.test(h.userAgent ?? ''))).toBe(true);

      const bad = await make('wrong-password')['profile.testProxy']!(cmd, ctx());
      expect(bad.outcome).toBe('proxy_failed');
      expect(bad.error?.code).toBe('proxy_auth_failed');
      expect(JSON.stringify(bad)).not.toContain('wrong-password');
    } finally {
      await browser.close();
      await site.close();
    }
  });
});
