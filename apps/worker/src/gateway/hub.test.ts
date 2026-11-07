/**
 * Integration: the gateway hub against the real (seeded) Postgres, with raw `ws` clients playing the agent
 * (T14's FakeAgent is not available in Wave 1). Each test registers its own node and deletes it afterwards.
 */
import { randomBytes } from 'node:crypto';
import { nodes, prisma } from '@threadline/db';
import {
  CloseCode,
  type Cmd,
  type GatewayMessage,
  type Hello,
  SUBPROTOCOL,
  encodeAgentMessage,
  parseGatewayMessage,
} from '@threadline/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type GatewayHandle, NodeError, startGateway } from './index';

let gw: GatewayHandle;
let base: string;
let workspaceId: string;
const created: string[] = [];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  workspaceId = (await prisma.workspace.findFirstOrThrow({ select: { id: true } })).id;
  gw = await startGateway({
    port: 0,
    host: '127.0.0.1',
    env: {},
    hub: {
      heartbeatSec: 1,
      offlineAfterMs: 1_200,
      ackTimeoutMs: 250,
      deadlineGraceMs: 0,
      helloTimeoutMs: 500,
    },
  });
  base = `127.0.0.1:${gw.port}`;
});

afterEach(() => {
  for (const s of sockets.splice(0)) s.terminate();
});

afterAll(async () => {
  await gw.stop();
  await prisma.browserNode.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

async function newNode() {
  const name = `t11-${randomBytes(4).toString('hex')}`;
  const token = randomBytes(24).toString('hex');
  const row = await nodes.register({ workspaceId, name, token });
  created.push(row.id);
  return { name, token, id: row.id };
}

interface Agent {
  ws: WebSocket;
  inbox: GatewayMessage[];
  next<T extends GatewayMessage['type']>(type: T, ms?: number): Promise<Extract<GatewayMessage, { type: T }>>;
  closed: Promise<{ code: number; reason: string }>;
  send(m: Parameters<typeof encodeAgentMessage>[0]): void;
}

function dial(opts: { name?: string; token?: string; protocol?: string }): Promise<Agent> {
  const headers: Record<string, string> = {};
  if (opts.name) headers['x-node-name'] = opts.name;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const ws = new WebSocket(`ws://${base}/agent`, opts.protocol ?? SUBPROTOCOL, { headers });
  sockets.push(ws);
  const inbox: GatewayMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (raw) => {
    const p = parseGatewayMessage(raw);
    if (!p.ok) throw new Error(p.error);
    inbox.push(p.msg);
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<{ code: number; reason: string }>((r) =>
    ws.on('close', (code, reason) => r({ code, reason: reason.toString() })),
  );
  const agent: Agent = {
    ws,
    inbox,
    closed,
    send: (m) => ws.send(encodeAgentMessage(m)),
    next: (type, ms = 2_000) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
        const check = () => {
          const i = inbox.findIndex((m) => m.type === type);
          if (i >= 0) {
            clearTimeout(t);
            resolve(inbox.splice(i, 1)[0] as never);
          } else waiters.push(check);
        };
        check();
      }),
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(agent));
    ws.once('error', reject);
    // A refused-after-open socket still opens first; a handshake failure rejects.
  });
}

const hello = (node: string, over: Partial<Hello> = {}): Hello => ({
  type: 'hello',
  node,
  agentVersion: '0.1.0-test',
  imageDigest: 'sha256:abc',
  maxProfiles: 4,
  seats: { inUse: 0, limit: 5 },
  running: [],
  ...over,
});

async function online(node: { name: string; token: string }) {
  const a = await dial(node);
  a.send(hello(node.name));
  await a.next('welcome');
  return a;
}

const until = async (fn: () => Promise<boolean> | boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
};

const stopCmd = (profileId = 'p1'): Cmd => ({ kind: 'profile.stop', profileId });
const audits = (nodeId: string) =>
  prisma.auditEvent.findMany({
    where: { targetId: nodeId },
    orderBy: { at: 'asc' },
    select: { action: true, meta: true },
  });

describe('gateway http', () => {
  it('serves /healthz and 404s other paths', async () => {
    const h = await fetch(`http://${base}/healthz`);
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ ok: true, role: 'gateway' });
    expect((await fetch(`http://${base}/nope`)).status).toBe(404);
  });

  it('refuses websocket upgrades on paths other than /agent', async () => {
    const ws = new WebSocket(`ws://${base}/other`, SUBPROTOCOL);
    sockets.push(ws);
    const err = await new Promise<Error>((r) => ws.once('error', r));
    expect(err.message).toMatch(/404/);
  });
});

describe('agent auth', () => {
  it('closes 4401 on a wrong token, without the node going online', async () => {
    const n = await newNode();
    const a = await dial({ name: n.name, token: 'wrong-token-0123456789' });
    a.send(hello(n.name));
    expect((await a.closed).code).toBe(CloseCode.badToken);
    expect((await nodes.getById(n.id))?.status).toBe('offline');
  });

  it('closes 4401 when the name or bearer token is missing', async () => {
    const n = await newNode();
    expect((await (await dial({ name: n.name })).closed).code).toBe(CloseCode.badToken);
    expect((await (await dial({ token: n.token })).closed).code).toBe(CloseCode.badToken);
  });

  it('closes 4401 when a valid token is presented for another node name', async () => {
    const a1 = await newNode();
    const b1 = await newNode();
    expect((await (await dial({ name: b1.name, token: a1.token })).closed).code).toBe(CloseCode.badToken);
  });

  it('closes 4426 on another protocol version', async () => {
    const n = await newNode();
    const a = await dial({ ...n, protocol: 'tl-node.v2' });
    expect((await a.closed).code).toBe(CloseCode.protocolVersion);
  });

  it('never puts the token in the close reason', async () => {
    const n = await newNode();
    const bad = `${n.token}x`;
    const { reason } = await (await dial({ name: n.name, token: bad })).closed;
    expect(reason).not.toContain(n.token);
  });
});

describe('hello and node status', () => {
  it('welcomes a valid hello, marks the node online and writes node.online', async () => {
    const n = await newNode();
    const a = await dial(n);
    a.send(hello(n.name, { running: [{ profileId: 'p1', startedAt: 1 }] }));
    const w = await a.next('welcome');
    expect(w).toMatchObject({ heartbeatSec: 1, protocol: 1 });
    const row = await nodes.getById(n.id);
    expect(row).toMatchObject({
      status: 'online',
      agentVersion: '0.1.0-test',
      maxProfiles: 4,
      seatsLimit: 5,
    });
    expect((await audits(n.id)).map((x) => x.action)).toEqual(['node.online']);
    expect(gw.hub.isOnline(n.name)).toBe(true);
    expect(gw.hub.nodes().find((x) => x.name === n.name)?.running).toEqual([
      { profileId: 'p1', startedAt: 1 },
    ]);
  });

  it('accepts hello sent before auth finished (buffered frames)', async () => {
    const n = await newNode();
    const headers = { 'x-node-name': n.name, authorization: `Bearer ${n.token}` };
    const ws = new WebSocket(`ws://${base}/agent`, SUBPROTOCOL, { headers });
    sockets.push(ws);
    const welcome = new Promise((r) => ws.once('message', r));
    ws.once('open', () => ws.send(encodeAgentMessage(hello(n.name))));
    await welcome;
    expect(gw.hub.isOnline(n.name)).toBe(true);
  });

  it('closes 4409 for a second socket with the same node name and keeps the first', async () => {
    const n = await newNode();
    const first = await online(n);
    const second = await dial(n);
    expect((await second.closed).code).toBe(CloseCode.duplicateNode);
    expect(gw.hub.isOnline(n.name)).toBe(true);
    first.send({ type: 'heartbeat', ts: Date.now(), running: [], seats: { inUse: 0, limit: 5 } });
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('closes 4400 when hello.node differs from X-Node-Name', async () => {
    const n = await newNode();
    const a = await dial(n);
    a.send(hello('someone-else'));
    expect((await a.closed).code).toBe(CloseCode.protocolError);
  });

  it('closes 4400 on an unknown frame type, a non-JSON frame or a heartbeat before hello', async () => {
    const n = await newNode();
    const a = await online(n);
    a.ws.send(JSON.stringify({ type: 'bogus' }));
    expect((await a.closed).code).toBe(CloseCode.protocolError);
    await until(async () => (await nodes.getById(n.id))?.status === 'offline');

    const b = await dial(n);
    b.ws.send('not json');
    expect((await b.closed).code).toBe(CloseCode.protocolError);

    const c = await dial(n);
    c.send({ type: 'heartbeat', ts: Date.now(), running: [], seats: { inUse: 0, limit: null } });
    expect((await c.closed).code).toBe(CloseCode.protocolError);
  });

  it('closes 4400 when no hello arrives in time', async () => {
    const n = await newNode();
    const a = await dial(n);
    expect((await a.closed).code).toBe(CloseCode.protocolError);
  });

  it('records heartbeats (seats, last seen) without audit rows', async () => {
    const n = await newNode();
    const a = await online(n);
    const before = (await nodes.getById(n.id))!.lastSeenAt!;
    await new Promise((r) => setTimeout(r, 20));
    a.send({ type: 'heartbeat', ts: Date.now(), running: [], seats: { inUse: 3, limit: 5 } });
    await until(async () => (await nodes.getById(n.id))?.seatsInUse === 3);
    expect((await nodes.getById(n.id))!.lastSeenAt!.getTime()).toBeGreaterThan(before.getTime());
    expect((await audits(n.id)).map((x) => x.action)).toEqual(['node.online']);
  });

  it('marks the node offline after missed heartbeats and writes node.offline', async () => {
    const n = await newNode();
    const offline = new Promise((r) => {
      const on = (info: { name: string }) => {
        if (info.name !== n.name) return;
        gw.hub.off('offline', on);
        r(info);
      };
      gw.hub.on('offline', on);
    });
    const a = await online(n);
    await a.closed; // the hub terminates the silent socket
    expect(await offline).toMatchObject({ name: n.name, reason: 'heartbeat_timeout' });
    expect((await nodes.getById(n.id))?.status).toBe('offline');
    const trail = await audits(n.id);
    expect(trail.map((x) => x.action)).toEqual(['node.online', 'node.offline']);
    expect(trail[1]!.meta).toMatchObject({ reason: 'heartbeat_timeout' });
  });

  it('keeps a node online while it heartbeats', async () => {
    const n = await newNode();
    const a = await online(n);
    const beat = setInterval(
      () => a.send({ type: 'heartbeat', ts: Date.now(), running: [], seats: { inUse: 0, limit: 5 } }),
      100,
    );
    await new Promise((r) => setTimeout(r, 1_800));
    clearInterval(beat);
    expect(gw.hub.isOnline(n.name)).toBe(true);
  });

  it('marks the node offline when the socket closes, then online again on reconnect', async () => {
    const n = await newNode();
    const a = await online(n);
    a.ws.close();
    await until(async () => (await nodes.getById(n.id))?.status === 'offline');
    await online(n);
    expect((await nodes.getById(n.id))?.status).toBe('online');
    expect((await audits(n.id)).map((x) => x.action)).toEqual(['node.online', 'node.offline', 'node.online']);
  });

  it('forwards agent events', async () => {
    const n = await newNode();
    const a = await online(n);
    const ev = new Promise((r) => {
      const on = (e: { node: string }) => {
        if (e.node !== n.name) return;
        gw.hub.off('event', on);
        r(e);
      };
      gw.hub.on('event', on);
    });
    a.send({ type: 'event', profileId: 'p9', kind: 'needs_human', detail: { why: 'captcha' } });
    expect(await ev).toMatchObject({
      node: n.name,
      nodeId: n.id,
      event: { profileId: 'p9', kind: 'needs_human' },
    });
  });
});

describe('hub.send', () => {
  it('resolves with the result after an ack', async () => {
    const n = await newNode();
    const a = await online(n);
    const pending = gw.hub.send(n.name, stopCmd(), { cmdId: 'bj-profile.stop-p1', deadlineMs: 2_000 });
    const c = await a.next('command');
    expect(c).toMatchObject({
      cmdId: 'bj-profile.stop-p1',
      deadlineMs: 2_000,
      cmd: { kind: 'profile.stop' },
    });
    a.send({ type: 'ack', cmdId: c.cmdId });
    a.send({ type: 'result', cmdId: c.cmdId, outcome: 'ok' });
    expect(await pending).toMatchObject({ type: 'result', outcome: 'ok' });
  });

  it('rejects NodeNotConnected for an unknown or not-yet-hello node', async () => {
    const n = await newNode();
    await expect(gw.hub.send(n.name, stopCmd(), { cmdId: 'x1', deadlineMs: 1_000 })).rejects.toMatchObject({
      code: 'NodeNotConnected',
      retryable: true,
    });
    await dial(n); // authenticated, no hello yet
    await expect(gw.hub.send(n.name, stopCmd(), { cmdId: 'x2', deadlineMs: 1_000 })).rejects.toBeInstanceOf(
      NodeError,
    );
  });

  it('rejects NodeTimeout when no ack arrives within the ack window', async () => {
    const n = await newNode();
    await online(n);
    await expect(gw.hub.send(n.name, stopCmd(), { cmdId: 'noack', deadlineMs: 5_000 })).rejects.toMatchObject(
      {
        code: 'NodeTimeout',
        message: expect.stringMatching(/no ack/),
      },
    );
  });

  it('rejects NodeTimeout when the result misses the deadline, and ignores the late result', async () => {
    const n = await newNode();
    const a = await online(n);
    const pending = gw.hub.send(n.name, stopCmd(), { cmdId: 'slow', deadlineMs: 300 });
    const c = await a.next('command');
    a.send({ type: 'ack', cmdId: c.cmdId });
    await expect(pending).rejects.toMatchObject({
      code: 'NodeTimeout',
      message: expect.stringMatching(/result/),
    });
    a.send({ type: 'result', cmdId: 'slow', outcome: 'ok' });
    await new Promise((r) => setTimeout(r, 50));
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(gw.hub.isOnline(n.name)).toBe(true);
  });

  it('rejects NodeDisconnected when the socket closes mid-command', async () => {
    const n = await newNode();
    const a = await online(n);
    const pending = gw.hub.send(n.name, stopCmd(), { cmdId: 'mid', deadlineMs: 5_000 });
    const c = await a.next('command');
    a.send({ type: 'ack', cmdId: c.cmdId });
    await new Promise((r) => setTimeout(r, 20));
    a.ws.terminate();
    await expect(pending).rejects.toMatchObject({ code: 'NodeDisconnected', retryable: true });
  });

  it('shares one in-flight command for a repeated cmdId instead of sending twice', async () => {
    const n = await newNode();
    const a = await online(n);
    const p1 = gw.hub.send(n.name, stopCmd(), { cmdId: 'dup', deadlineMs: 2_000 });
    const p2 = gw.hub.send(n.name, stopCmd(), { cmdId: 'dup', deadlineMs: 2_000 });
    expect(p2).toBe(p1);
    const c = await a.next('command');
    a.send({ type: 'ack', cmdId: c.cmdId });
    a.send({ type: 'result', cmdId: c.cmdId, outcome: 'ok' });
    await p1;
    expect(a.inbox.filter((m) => m.type === 'command')).toHaveLength(0);
  });

  it('refuses an off-contract command without sending it or echoing its values', async () => {
    const n = await newNode();
    const a = await online(n);
    const bad = { kind: 'profile.start', profileId: 'p1', proxy: { password: 'hunter2' } } as unknown as Cmd;
    const err = await gw.hub.send(n.name, bad, { cmdId: 'bad', deadlineMs: 1_000 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('hunter2');
    await new Promise((r) => setTimeout(r, 50));
    expect(a.inbox).toHaveLength(0);
  });

  it('retry after a disconnect gets the replayed result; the agent runs the command once', async () => {
    // A minimal agent with the §3.4 result cache: it runs a command once per cmdId and replays after that.
    const n = await newNode();
    const cache = new Map<string, 'posted'>();
    let runs = 0;
    const agentFor = (a: Agent, dropBeforeResult: boolean) =>
      a.ws.on('message', (raw) => {
        const p = parseGatewayMessage(raw);
        if (!p.ok || p.msg.type !== 'command') return;
        const { cmdId } = p.msg;
        a.send({ type: 'ack', cmdId });
        if (!cache.has(cmdId)) {
          runs++;
          cache.set(cmdId, 'posted');
        }
        if (dropBeforeResult) return a.ws.terminate(); // posted, but the socket dies before the result
        a.send({ type: 'result', cmdId, outcome: cache.get(cmdId)!, data: { fullname: 't1_abc' } });
      });

    const cmd: Cmd = {
      kind: 'action.submitComment',
      profileId: 'p1',
      draftId: 'd1',
      threadUrl: 'https://www.reddit.com/r/x/comments/abc/t/',
      parentFullname: 't3_abc',
      body: 'hello',
    };
    const opts = { cmdId: 'bj-action.submitComment-d1', deadlineMs: 2_000 };

    const first = await online(n);
    agentFor(first, true);
    await expect(gw.hub.send(n.name, cmd, opts)).rejects.toMatchObject({ code: 'NodeDisconnected' });
    await until(() => !gw.hub.isOnline(n.name));

    const second = await online(n);
    agentFor(second, false);
    const r = await gw.hub.send(n.name, cmd, opts);
    expect(r).toMatchObject({ outcome: 'posted', data: { fullname: 't1_abc' } });
    expect(runs).toBe(1);
  });
});
