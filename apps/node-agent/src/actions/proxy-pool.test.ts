import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SecretSet, createLogger } from '../log';
import type { HandlerContext } from '../registry';
import { createProxyPoolHandlers, isPublicAddress } from './proxy-pool';
import { type TestProxy, startHttpProxy } from './testing/proxies';

const USER = 'tl-user';
const PASS = 'pool-pass-s3cret';
let echo: Server;
let echoUrl: string;
let proxy: TestProxy;

beforeAll(async () => {
  echo = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.startsWith('/geo'))
      res.end(
        JSON.stringify({ city: 'Boston', country: 'US', timezone: 'America/New_York', loc: '42.3,-71.0' }),
      );
    else res.end(JSON.stringify({ ip: '192.0.2.44' }));
  });
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  echoUrl = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  proxy = await startHttpProxy(USER, PASS);
});
afterAll(async () => {
  await proxy?.close();
  echo?.closeAllConnections();
  await new Promise<void>((r) => echo?.close(() => r()));
});

const ctx = (secrets = new SecretSet()) =>
  ({
    cmdId: 'c1',
    signal: new AbortController().signal,
    log: createLogger({ level: 'silent' }),
    secrets,
  }) as unknown as HandlerContext;
const spec = (password = PASS) =>
  ({ protocol: 'http', host: '127.0.0.1', port: proxy.port, username: USER, password }) as const;

describe('proxy.check', () => {
  it('reports the exit IP, latency, place and reachability through the proxy', async () => {
    const h = createProxyPoolHandlers({
      ipUrl: `${echoUrl}/ip`,
      geoUrl: `${echoUrl}/geo`,
      redditUrl: `${echoUrl}/robots.txt`,
    });
    const secrets = new SecretSet();
    const r = await h['proxy.check']!({ kind: 'proxy.check', proxyId: 'px1', proxy: spec() }, ctx(secrets));
    expect(r).toEqual({
      outcome: 'ok',
      data: {
        ip: '192.0.2.44',
        latencyMs: expect.any(Number),
        redditOk: true,
        geo: { city: 'Boston', country: 'US', timeZone: 'America/New_York', lat: 42.3, lon: -71 },
      },
    });
    expect(secrets.size).toBe(1); // the proxy password is scrubbed from logs
  });

  it('a wrong password is proxy_failed with a code and no credentials in the result', async () => {
    const h = createProxyPoolHandlers({ ipUrl: `${echoUrl}/ip` });
    const r = await h['proxy.check']!(
      { kind: 'proxy.check', proxyId: 'px1', proxy: spec('wrong-password') },
      ctx(),
    );
    expect(r).toMatchObject({ outcome: 'proxy_failed', error: { code: 'proxy_auth_failed' } });
    expect(JSON.stringify(r)).not.toContain('wrong-password');
  });
});

describe('proxy.rotate', () => {
  const rotate = (url: string, o: Parameters<typeof createProxyPoolHandlers>[0] = {}) =>
    createProxyPoolHandlers(o)['proxy.rotate']!({ kind: 'proxy.rotate', proxyId: 'px1', url }, ctx());

  it('calls a public link once and reports its status', async () => {
    const call = vi.fn(async () => 200);
    const r = await rotate('https://vendor.example/rotate?token=abc', {
      resolve: async () => ['203.0.113.10'],
      call,
    });
    expect(r).toEqual({ outcome: 'ok', data: { status: 200 } });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('never calls a link that points at the node’s own network', async () => {
    const call = vi.fn(async () => 200);
    for (const [url, addrs] of [
      ['http://127.0.0.1:2375/containers/json', []],
      ['http://192.168.1.1/admin', []],
      ['http://[::1]/x', []],
      ['https://rebind.example/rotate', ['203.0.113.10', '10.0.0.5']],
      ['http://metadata.example/latest', ['169.254.169.254']],
    ] as const) {
      const r = await rotate(url, { resolve: async () => [...addrs], call });
      expect(r).toMatchObject({ outcome: 'error', error: { code: 'private_address' } });
    }
    expect(await rotate('file:///etc/passwd', { call })).toMatchObject({ error: { code: 'bad_url' } });
    expect(call).not.toHaveBeenCalled();
  });

  it('reports a refusal or a dead link without echoing the link', async () => {
    const url = 'https://vendor.example/rotate?token=very-secret-token';
    const refused = await rotate(url, { resolve: async () => ['203.0.113.10'], call: async () => 403 });
    expect(refused).toMatchObject({ outcome: 'error', error: { code: 'rotate_refused' } });
    const dead = await rotate(url, {
      resolve: async () => ['203.0.113.10'],
      call: async () => {
        throw new Error(`connect failed ${url}`);
      },
    });
    expect(dead).toMatchObject({ outcome: 'error', error: { code: 'rotate_failed' } });
    expect(JSON.stringify([refused, dead])).not.toContain('very-secret-token');
  });
});

describe('isPublicAddress', () => {
  it('refuses loopback, private, link-local, CGNAT and non-addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.9', '169.254.169.254'])
      expect(isPublicAddress(a)).toBe(false);
    for (const a of [
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ])
      expect(isPublicAddress(a)).toBe(false);
    expect(isPublicAddress('not-an-ip')).toBe(false);
    for (const a of ['203.0.113.10', '8.8.8.8', '172.32.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8'])
      expect(isPublicAddress(a)).toBe(true);
  });
});
