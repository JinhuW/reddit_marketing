/**
 * T24 agent side: `vnc.open` through the real Dispatcher, against a local stand-in for the gateway's
 * `/vnc/<sessionId>` endpoint and a fake websockify that greets like an RFB server and echoes.
 */
import type { AddressInfo } from 'node:net';
import type { AgentMessage, Command, Result } from '@threadline/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { Dispatcher } from './dispatch';
import { createVncModule } from './handlers/vnc';
import { SecretSet, createLogger } from './log';
import type { AgentEvent } from './registry';
import { StatusStore } from './status';
import { captureStream, sleep, testConfig } from './testing/helpers';
import { isRfbInput, resolveUpstream, websockifyUrl } from './vnc';

const GREETING = Buffer.from('RFB 003.008\n');
const TOKEN = '1999999999.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';

let vncServer: WebSocketServer;
let gwServer: WebSocketServer;
let vncPort: number;
let gwPort: number;
/** Sockets the fake gateway accepted on /vnc/*, with the URL they dialed. */
const gwConns: { ws: WebSocket; url: string; inbox: Buffer[]; closeCode?: number }[] = [];
const vncConns: { ws: WebSocket; protocol: string; closeCode?: number }[] = [];
let refuseGateway = 0;

const listen = (wss: WebSocketServer) =>
  new Promise<number>((r) => wss.once('listening', () => r((wss.address() as AddressInfo).port)));

beforeAll(async () => {
  vncServer = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/websockify',
    handleProtocols: (p) => (p.has('binary') ? 'binary' : false),
  });
  vncServer.on('connection', (ws) => {
    const c: (typeof vncConns)[number] = { ws, protocol: ws.protocol };
    ws.on('close', (code) => {
      c.closeCode = code;
    });
    vncConns.push(c);
    ws.send(GREETING); // before the agent has an upstream: must be buffered, not lost
    ws.on('message', (d, isBinary) => ws.send(d, { binary: isBinary }));
  });
  vncPort = await listen(vncServer);

  gwServer = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (_info, cb) => (refuseGateway ? cb(false, refuseGateway) : cb(true)),
  });
  gwServer.on('connection', (ws, req) => {
    const c: (typeof gwConns)[number] = { ws, url: req.url ?? '', inbox: [] };
    ws.on('message', (d) => c.inbox.push(Buffer.from(d as Buffer)));
    ws.on('close', (code) => {
      c.closeCode = code;
    });
    gwConns.push(c);
  });
  gwPort = await listen(gwServer);
});

afterEach(() => {
  refuseGateway = 0;
  for (const c of gwConns.splice(0)) c.ws.terminate();
  for (const c of vncConns.splice(0)) c.ws.terminate();
});

afterAll(async () => {
  await new Promise((r) => vncServer.close(r));
  await new Promise((r) => gwServer.close(r));
});

async function until<T>(f: () => T | undefined | false, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

function setup(opts: { target?: string; activityEveryMs?: number } = {}) {
  const secrets = new SecretSet();
  const config = testConfig(`ws://127.0.0.1:${gwPort}/agent`);
  const status = new StatusStore(config.maxProfiles);
  const logs = captureStream();
  const log = createLogger({ level: 'debug', secrets, destination: logs.stream });
  const mod = createVncModule({
    targetUrl: () => opts.target ?? `ws://127.0.0.1:${vncPort}/websockify`,
    activityEveryMs: opts.activityEveryMs ?? 60_000,
    dialTimeoutMs: 2_000,
  });
  const events: AgentEvent[] = [];
  mod.start?.({ config, log, secrets, status, emit: (e) => events.push(e) });
  const d = new Dispatcher({ handlers: mod.handlers, log, secrets, config, status });
  const sent: AgentMessage[] = [];
  const run = async (cmdId: string, sessionId = 'sess_1', upstreamHost = 'nodes.example.com') => {
    const c: Command = {
      type: 'command',
      cmdId,
      deadlineMs: 5_000,
      cmd: {
        kind: 'vnc.open',
        profileId: 'prof_1',
        sessionId,
        upstreamUrl: `wss://${upstreamHost}/vnc/${sessionId}?t=${TOKEN}`,
        token: TOKEN,
      },
    };
    await d.handle(c, (m) => {
      sent.push(m);
      return true;
    });
    return sent.filter((m): m is Result => m.type === 'result' && m.cmdId === cmdId).at(-1)!;
  };
  return { mod, run, events, logs };
}

describe('upstream and target URLs', () => {
  it('always dials GATEWAY_URL’s origin with the session path and token', () => {
    const r = resolveUpstream('wss://nodes.example.com/agent', {
      upstreamUrl: 'wss://evil.example.net/vnc/s1?t=x',
      sessionId: 's1',
      token: 'tok.abc',
    });
    expect(r).toEqual({ url: 'wss://nodes.example.com/vnc/s1?t=tok.abc', hostMatches: false });
    expect(
      resolveUpstream('wss://nodes.example.com', {
        upstreamUrl: 'wss://nodes.example.com/vnc/s1?t=x',
        sessionId: 's1',
        token: 't',
      }).hostMatches,
    ).toBe(true);
  });

  it('refuses an upstream that does not name the session, and odd ids', () => {
    const base = { upstreamUrl: 'wss://n/vnc/other?t=x', sessionId: 's1', token: 't' };
    expect(() => resolveUpstream('wss://n', base)).toThrow(/does not name the session/);
    expect(() => resolveUpstream('wss://n', { ...base, sessionId: '../agent' })).toThrow(/invalid session/);
    expect(() => websockifyUrl('x@evil.com')).toThrow(/invalid profile/);
    expect(websockifyUrl('prof_1')).toBe('ws://tl-profile-prof_1:6080/websockify');
  });

  it('counts only key and pointer messages as input', () => {
    expect(isRfbInput(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]))).toBe(true);
    expect(isRfbInput(Buffer.from([5, 0, 0, 10, 0, 20]))).toBe(true);
    expect(isRfbInput(Buffer.from([5, 0, 0, 10, 0, 20, 5, 1, 0, 10, 0, 20]))).toBe(true);
    expect(isRfbInput(Buffer.from([3, 1, 0, 0, 0, 0, 7, 128, 4, 56]))).toBe(false); // update request
    expect(isRfbInput(Buffer.from(GREETING))).toBe(false);
  });
});

describe('vnc.open', () => {
  it('pipes bytes both ways, greeting included, and reports ok', async () => {
    const { run, mod } = setup();
    const result = await run('vnc-sess_1-a');
    expect(result).toMatchObject({ outcome: 'ok', data: { sessionId: 'sess_1' } });

    const gw = await until(() => gwConns[0]);
    expect(gw.url).toBe(`/vnc/sess_1?t=${TOKEN}`); // dialed the configured gateway, not nodes.example.com
    expect(vncConns[0]?.protocol).toBe('binary');
    await until(() => gw.inbox.length >= 1);
    expect(gw.inbox[0]).toEqual(GREETING);

    const payload = Buffer.from([1, 2, 3, 250, 0, 7]);
    gw.ws.send(payload);
    await until(() => gw.inbox.length >= 2);
    expect(gw.inbox[1]).toEqual(payload);
    expect(mod.pipes()).toHaveLength(1);
  });

  it('closes the container side when the gateway side closes, and the other way round', async () => {
    const { run, mod } = setup();
    await run('vnc-sess_1-b');
    const gw = await until(() => gwConns[0]);
    const target = await until(() => vncConns[0]);
    gw.ws.close(4410, 'session ended');
    expect(await until(() => target.closeCode)).toBe(4410);
    await until(() => mod.pipes().length === 0);

    await run('vnc-sess_1-c');
    const gw2 = await until(() => gwConns[1]);
    const target2 = await until(() => vncConns[1]);
    target2.ws.close(1000);
    expect(await until(() => gw2.closeCode)).toBe(1000);
    await until(() => mod.pipes().length === 0);
  });

  it('sends throttled session.activity events for keyboard and pointer input only', async () => {
    const { run, events } = setup({ activityEveryMs: 200 });
    await run('vnc-sess_1-d');
    const gw = await until(() => gwConns[0]);
    gw.ws.send(Buffer.from([3, 1, 0, 0, 0, 0, 7, 128, 4, 56])); // update request: not activity
    await sleep(50);
    expect(events).toHaveLength(0);
    gw.ws.send(Buffer.from([5, 0, 0, 10, 0, 20]));
    gw.ws.send(Buffer.from([5, 1, 0, 10, 0, 20]));
    await until(() => events.length === 1);
    await sleep(250);
    gw.ws.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]));
    await until(() => events.length === 2);
    expect(events[0]).toEqual({
      profileId: 'prof_1',
      kind: 'session.activity',
      detail: { sessionId: 'sess_1' },
    });
  });

  it('answers vnc_target_unreachable when the container display is down', async () => {
    const { run } = setup({ target: 'ws://127.0.0.1:1/websockify' });
    const r = await run('vnc-sess_1-e');
    expect(r).toMatchObject({ outcome: 'error', error: { code: 'vnc_target_unreachable' } });
    expect(gwConns).toHaveLength(0);
  });

  it('answers vnc_upstream_refused when the gateway refuses the token, without leaking it', async () => {
    refuseGateway = 403;
    const { run, logs } = setup();
    const r = await run('vnc-sess_1-f');
    expect(r).toMatchObject({ outcome: 'error', error: { code: 'vnc_upstream_refused' } });
    expect(r.error?.message).toContain('403');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(logs.text()).not.toContain(TOKEN);
    await until(() => vncConns[0]?.closeCode);
  });

  it('a newer vnc.open for the session replaces the pipe; stop closes everything', async () => {
    const { run, mod } = setup();
    await run('vnc-sess_1-g');
    const first = await until(() => gwConns[0]);
    await run('vnc-sess_1-h');
    expect(await until(() => first.closeCode)).toBe(4409);
    await until(() => mod.pipes().length === 1);
    const second = await until(() => gwConns[1]);
    await mod.stop?.();
    expect(await until(() => second.closeCode)).toBe(1001);
    expect(mod.pipes()).toHaveLength(0);
  });
});
