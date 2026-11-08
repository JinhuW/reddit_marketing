import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { VNC_AUTHZ_HEADER } from './vnc-authz';
import {
  type Authorize,
  type VncProxyOptions,
  createVncProxy,
  routeAuthorizer,
  signGatewayVncUrl,
  verifyGatewayVncUrl,
  vncProfileIdFromUrl,
} from './vnc-proxy';

const SECRET = 'gateway-internal-secret-for-tests';
const GRANT = { workspaceId: 'ws_1', profileId: 'prof_1', memberId: 'mem_owner', sessionId: 'sess_1' };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

/** Stands in for T24's `/internal/vnc/<profileId>`: verifies the signature, then echoes every frame. */
async function fakeGateway(secret = SECRET) {
  const seen: { url: string; check: ReturnType<typeof verifyGatewayVncUrl> }[] = [];
  const sockets: WebSocket[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer((_req, res) => res.writeHead(404).end());
  http.on('upgrade', (req, socket, head) => {
    const check = verifyGatewayVncUrl(req.url ?? '', secret);
    seen.push({ url: req.url ?? '', check });
    if (!check.ok) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });
  const port = await listen(http);
  cleanup.push(() => {
    for (const s of sockets) s.terminate();
    wss.close();
    return closeServer(http);
  });
  return { url: `http://127.0.0.1:${port}`, seen, sockets };
}

async function webServer(opts: Partial<VncProxyOptions> & { authorize: Authorize }) {
  const proxy = createVncProxy({ gatewayUrl: undefined, secret: SECRET, connectTimeoutMs: 2000, ...opts });
  const http = createServer((_req, res) => res.writeHead(404).end());
  http.on('upgrade', (req, socket, head) => {
    if (!proxy.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const port = await listen(http);
  cleanup.push(() => {
    proxy.close();
    return closeServer(http);
  });
  return { port, origin: `http://127.0.0.1:${port}` };
}

/** Opens a client socket; resolves with the socket once open, or the HTTP status the upgrade was refused with. */
function dial(port: number, path: string, origin?: string) {
  return new Promise<{ ws: WebSocket; status?: undefined } | { ws?: undefined; status: number }>(
    (resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
      ws.once('open', () => resolve({ ws }));
      ws.once('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode ?? 0 });
        ws.terminate();
      });
      ws.once('error', () => resolve({ status: -1 }));
      cleanup.push(() => ws.terminate());
    },
  );
}

const nextMessage = (ws: WebSocket) =>
  new Promise<{ data: RawData; isBinary: boolean }>((resolve) =>
    ws.once('message', (data, isBinary) => resolve({ data, isBinary })),
  );
const closed = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({ code: 1006, reason: '' });
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
const allow: Authorize = async () => ({ ok: true, grant: GRANT });

describe('vncProfileIdFromUrl', () => {
  it('matches only /api/vnc/<id>', () => {
    expect(vncProfileIdFromUrl('/api/vnc/cmh0abc123')).toBe('cmh0abc123');
    expect(vncProfileIdFromUrl('/api/vnc/cmh0abc123?x=1')).toBe('cmh0abc123');
    expect(vncProfileIdFromUrl('/api/vnc/')).toBeNull();
    expect(vncProfileIdFromUrl('/api/vnc/a/b')).toBeNull();
    expect(vncProfileIdFromUrl('/api/vnc/..%2Fx')).toBeNull();
    expect(vncProfileIdFromUrl('/_next/webpack-hmr')).toBeNull();
  });
});

describe('gateway URL signature', () => {
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);
  const signed = () =>
    signGatewayVncUrl({
      gatewayUrl: 'http://node-gateway.railway.internal:8080',
      secret: SECRET,
      profileId: 'prof_1',
      sessionId: 'sess_1',
      nowMs: now,
    });

  it('targets /internal/vnc/<profileId> over ws and verifies with the same secret', () => {
    const url = new URL(signed());
    expect(url.protocol).toBe('ws:');
    expect(url.host).toBe('node-gateway.railway.internal:8080');
    expect(url.pathname).toBe('/internal/vnc/prof_1');
    expect(url.searchParams.get('session')).toBe('sess_1');
    expect(Number(url.searchParams.get('exp'))).toBe(now / 1000 + 60);
    expect(verifyGatewayVncUrl(url, SECRET, now)).toEqual({
      ok: true,
      profileId: 'prof_1',
      sessionId: 'sess_1',
    });
  });

  it('uses wss for an https gateway', () => {
    const url = signGatewayVncUrl({ gatewayUrl: 'https://nodes.example.com/', secret: SECRET, ...GRANT });
    expect(url.startsWith('wss://nodes.example.com/internal/vnc/prof_1?')).toBe(true);
  });

  it('refuses a wrong secret, a tampered field, an expired URL and a malformed one', () => {
    expect(verifyGatewayVncUrl(signed(), 'other-secret', now)).toMatchObject({
      ok: false,
      reason: 'bad signature',
    });
    const tampered = new URL(signed());
    tampered.searchParams.set('session', 'sess_2');
    expect(verifyGatewayVncUrl(tampered, SECRET, now)).toMatchObject({ ok: false, reason: 'bad signature' });
    const otherProfile = signed().replace('/internal/vnc/prof_1', '/internal/vnc/prof_2');
    expect(verifyGatewayVncUrl(otherProfile, SECRET, now)).toMatchObject({
      ok: false,
      reason: 'bad signature',
    });
    expect(verifyGatewayVncUrl(signed(), SECRET, now + 61_000)).toMatchObject({
      ok: false,
      reason: 'expired',
    });
    const noSig = new URL(signed());
    noSig.searchParams.delete('sig');
    expect(verifyGatewayVncUrl(noSig, SECRET, now)).toMatchObject({ ok: false, reason: 'malformed request' });
  });
});

describe('VNC upgrade', () => {
  it('refuses a Viewer or non-owner with 403 and never dials the gateway', async () => {
    const gw = await fakeGateway();
    const authorize = vi.fn<Authorize>(async () => ({ ok: false, status: 403 }));
    const web = await webServer({ gatewayUrl: gw.url, authorize });
    const r = await dial(web.port, '/api/vnc/prof_1', web.origin);
    expect(r.status).toBe(403);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0]?.[1]).toBe('prof_1');
    expect(gw.seen).toHaveLength(0);
  });

  it('refuses a signed-out request with 401', async () => {
    const gw = await fakeGateway();
    const web = await webServer({ gatewayUrl: gw.url, authorize: async () => ({ ok: false, status: 401 }) });
    expect((await dial(web.port, '/api/vnc/prof_1', web.origin)).status).toBe(401);
    expect(gw.seen).toHaveLength(0);
  });

  it('refuses a cross-site origin before authorizing', async () => {
    const gw = await fakeGateway();
    const authorize = vi.fn<Authorize>(allow);
    const web = await webServer({ gatewayUrl: gw.url, authorize });
    expect((await dial(web.port, '/api/vnc/prof_1', 'https://evil.example')).status).toBe(403);
    expect((await dial(web.port, '/api/vnc/prof_1')).status).toBe(403);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('accepts an allowed APP_URL origin', async () => {
    const gw = await fakeGateway();
    const web = await webServer({
      gatewayUrl: gw.url,
      authorize: allow,
      allowedOrigins: ['https://app.example.com'],
    });
    const r = await dial(web.port, '/api/vnc/prof_1', 'https://app.example.com');
    expect(r.ws).toBeDefined();
  });

  it('answers 503 when the gateway is not configured', async () => {
    const authorize = vi.fn<Authorize>(allow);
    const web = await webServer({ gatewayUrl: undefined, authorize });
    expect((await dial(web.port, '/api/vnc/prof_1', web.origin)).status).toBe(503);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('dials the gateway with a URL it verifies, then pipes binary and text frames both ways', async () => {
    const gw = await fakeGateway();
    const web = await webServer({ gatewayUrl: gw.url, authorize: allow });
    const r = await dial(web.port, '/api/vnc/prof_1', web.origin);
    if (!r.ws) throw new Error(`refused ${r.status}`);
    expect(gw.seen).toHaveLength(1);
    expect(gw.seen[0]?.check).toMatchObject({
      ok: true,
      profileId: 'prof_1',
      sessionId: 'sess_1',
    });

    const bytes = Buffer.from([0x52, 0x46, 0x42, 0x20, 0x00, 0xff, 0x10]);
    const echoed = nextMessage(r.ws);
    r.ws.send(bytes);
    const m = await echoed;
    expect(m.isBinary).toBe(true);
    expect(Buffer.from(m.data as Buffer).equals(bytes)).toBe(true);

    const text = nextMessage(r.ws);
    r.ws.send('hello');
    const t = await text;
    expect(t.isBinary).toBe(false);
    expect(t.data.toString()).toBe('hello');
  });

  it('closes the gateway side when the browser closes', async () => {
    const gw = await fakeGateway();
    const web = await webServer({ gatewayUrl: gw.url, authorize: allow });
    const r = await dial(web.port, '/api/vnc/prof_1', web.origin);
    if (!r.ws) throw new Error('refused');
    const upstream = gw.sockets[0];
    if (!upstream) throw new Error('gateway socket missing');
    const upstreamClosed = closed(upstream);
    r.ws.close(1000, 'bye');
    expect(await upstreamClosed).toEqual({ code: 1000, reason: 'bye' });
  });

  it('closes the browser side when the gateway closes, keeping the code', async () => {
    const gw = await fakeGateway();
    const web = await webServer({ gatewayUrl: gw.url, authorize: allow });
    const r = await dial(web.port, '/api/vnc/prof_1', web.origin);
    if (!r.ws) throw new Error('refused');
    const clientClosed = closed(r.ws);
    gw.sockets[0]?.close(4410, 'container stopped');
    expect(await clientClosed).toEqual({ code: 4410, reason: 'container stopped' });
  });

  it('closes the browser side when the gateway connection drops', async () => {
    const gw = await fakeGateway();
    const web = await webServer({ gatewayUrl: gw.url, authorize: allow });
    const r = await dial(web.port, '/api/vnc/prof_1', web.origin);
    if (!r.ws) throw new Error('refused');
    const clientClosed = closed(r.ws);
    gw.sockets[0]?.terminate();
    expect((await clientClosed).code).toBe(1000);
  });

  it('answers 502 when the gateway refuses the signature', async () => {
    const gw = await fakeGateway('a-different-secret');
    const web = await webServer({ gatewayUrl: gw.url, authorize: allow });
    expect((await dial(web.port, '/api/vnc/prof_1', web.origin)).status).toBe(502);
    expect(gw.seen[0]?.check).toMatchObject({ ok: false, reason: 'bad signature' });
  });

  it('answers 502 when the gateway is down', async () => {
    const web = await webServer({ gatewayUrl: 'http://127.0.0.1:1', authorize: allow });
    expect((await dial(web.port, '/api/vnc/prof_1', web.origin)).status).toBe(502);
  });

  it('leaves other upgrade paths alone', async () => {
    const proxy = createVncProxy({ gatewayUrl: 'http://x', secret: SECRET, authorize: allow });
    cleanup.push(() => proxy.close());
    const req = { url: '/_next/webpack-hmr', headers: {} } as IncomingMessage;
    // biome-ignore lint/suspicious/noExplicitAny: the socket is never touched for a foreign path
    expect(proxy.handleUpgrade(req, {} as any, Buffer.alloc(0))).toBe(false);
  });
});

describe('routeAuthorizer', () => {
  async function fakeRoute(status: number, body: unknown) {
    const calls: IncomingMessage[] = [];
    const http = createServer((req, res) => {
      calls.push(req);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    const port = await listen(http);
    cleanup.push(() => closeServer(http));
    return { port, calls };
  }
  const upgradeReq = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

  it('POSTs to the route with the key and the upgrade cookies, and returns the grant', async () => {
    const route = await fakeRoute(200, GRANT);
    const authorize = routeAuthorizer({ port: route.port, key: 'k'.repeat(64) });
    const r = await authorize(
      upgradeReq({
        cookie: 'authjs.session-token=abc',
        host: 'app.example.com',
        'x-forwarded-proto': 'https',
      }),
      'prof_1',
    );
    expect(r).toEqual({ ok: true, grant: GRANT });
    const call = route.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/api/vnc/prof_1');
    expect(call?.headers[VNC_AUTHZ_HEADER]).toBe('k'.repeat(64));
    expect(call?.headers.cookie).toBe('authjs.session-token=abc');
    expect(call?.headers.host).toBe('app.example.com');
    expect(call?.headers['x-forwarded-proto']).toBe('https');
  });

  it('passes refusals through and rejects a grant for another profile', async () => {
    const forbidden = await fakeRoute(403, { error: 'forbidden' });
    expect(await routeAuthorizer({ port: forbidden.port, key: 'k' })(upgradeReq({}), 'prof_1')).toEqual({
      ok: false,
      status: 403,
    });
    const wrong = await fakeRoute(200, { ...GRANT, profileId: 'prof_2' });
    expect(await routeAuthorizer({ port: wrong.port, key: 'k' })(upgradeReq({}), 'prof_1')).toEqual({
      ok: false,
      status: 502,
    });
  });
});
