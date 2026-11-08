/**
 * Integration (T24): the gateway's VNC relay against the real (seeded) Postgres. A raw `ws` client plays the node
 * agent: on `vnc.open` it dials the upstream URL and pipes it to a fake websockify that greets like an RFB server
 * and echoes. Another raw client plays the web custom server (T23) with a signed `/internal/vnc` URL.
 * The test registers its own node and human session and removes them afterwards.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { browsers, nodes, prisma } from '@threadline/db';
import {
  type Command,
  type GatewayMessage,
  SUBPROTOCOL,
  VNC_TOKEN_TTL_SEC,
  encodeAgentMessage,
  parseGatewayMessage,
} from '@threadline/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { type GatewayHandle, startGateway } from './index';
import {
  INTERNAL_VNC_PREFIX,
  createVncPlugin,
  dbVncRepo,
  signInternalVncUrl,
  signVncToken,
  verifyInternalVncUrl,
  verifyVncToken,
} from './vnc';

const SECRET = 'gateway-internal-secret-for-tests-0123456789';
const GREETING = Buffer.from('RFB 003.008\n');

let gw: GatewayHandle;
let base: string;
let websockify: WebSocketServer;
let websockifyPort: number;
let node: { id: string; name: string; token: string };
let profileId: string;
let previousNodeId: string | null;
let sessionId: string;
const sockets: WebSocket[] = [];
/** Tracks a client socket for teardown; handshake aborts are expected in these tests. */
const track = (ws: WebSocket) => {
  ws.on('error', () => {});
  sockets.push(ws);
  return ws;
};
const targetConns: { ws: WebSocket; closeCode?: number }[] = [];

/** How the fake agent answers `vnc.open`. */
type Mode = 'pipe' | 'silent' | 'refuse' | 'badToken';
let mode: Mode = 'pipe';
let agent: Awaited<ReturnType<typeof onlineAgent>> | null = null;

const until = async <T>(fn: () => Promise<T> | T, ms = 3_000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  websockify = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  websockify.on('connection', (ws) => {
    const c: (typeof targetConns)[number] = { ws };
    ws.on('close', (code) => {
      c.closeCode = code;
    });
    targetConns.push(c);
    ws.send(GREETING);
    ws.on('message', (d, isBinary) => ws.send(d, { binary: isBinary }));
  });
  await new Promise((r) => websockify.once('listening', r));
  websockifyPort = (websockify.address() as AddressInfo).port;

  gw = await startGateway({
    port: 0,
    host: '127.0.0.1',
    env: {},
    hub: { heartbeatSec: 5, ackTimeoutMs: 500, deadlineGraceMs: 0 },
    plugins: [
      createVncPlugin({
        env: { GATEWAY_INTERNAL_SECRET: SECRET },
        dialTimeoutMs: 1_000,
        activityLogEveryMs: 0,
        sessionCheckEveryMs: 100,
      }),
    ],
  });
  base = `127.0.0.1:${gw.port}`;

  const workspaceId = (await prisma.workspace.findFirstOrThrow({ select: { id: true } })).id;
  const name = `t24-${randomBytes(4).toString('hex')}`;
  const token = randomBytes(24).toString('hex');
  node = { ...(await nodes.register({ workspaceId, name, token })), token };

  // A profile with no open session; take it over as its account owner.
  const profile = await prisma.browserProfile.findFirstOrThrow({
    where: { workspaceId, accountId: { not: null }, sessions: { none: { endedAt: null } } },
    include: { account: { include: { owner: { include: { user: true } } } } },
  });
  if (!profile.account) throw new Error('seed profile has no account');
  profileId = profile.id;
  previousNodeId = profile.nodeId;
  await browsers.assignNode(workspaceId, profileId, node.id);
  const s = await browsers.startHumanSession({
    workspaceId,
    profileId,
    memberId: profile.account.ownerMemberId,
    memberName: profile.account.owner.user.name ?? 'Owner',
    reason: 'T24 relay test',
  });
  sessionId = s.id;
});

afterEach(async () => {
  mode = 'pipe';
  for (const s of sockets.splice(0)) s.terminate();
  for (const c of targetConns.splice(0)) c.ws.terminate();
  await prisma.browserSession.update({ where: { id: sessionId }, data: { endedAt: null } });
});

afterAll(async () => {
  agent?.ws.terminate();
  await gw.stop();
  await new Promise((r) => websockify.close(r));
  // AuditEvent is append-only, so the session and its log rows stay; the session is closed.
  await prisma.browserSession.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
  await prisma.browserProfile.update({ where: { id: profileId }, data: { nodeId: previousNodeId } });
  await prisma.browserNode.delete({ where: { id: node.id } });
  await prisma.$disconnect();
});

// ── the fake agent ──

async function onlineAgent() {
  const ws = new WebSocket(`ws://${base}/agent`, SUBPROTOCOL, {
    headers: { authorization: `Bearer ${node.token}`, 'x-node-name': node.name },
  });
  const commands: Command[] = [];
  const welcome = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const p = parseGatewayMessage(raw);
      if (!p.ok) throw new Error(p.error);
      const m: GatewayMessage = p.msg;
      if (m.type === 'welcome') return resolve();
      commands.push(m);
      void answer(ws, m);
    });
  });
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  ws.send(
    encodeAgentMessage({
      type: 'hello',
      node: node.name,
      agentVersion: '0.1.0-test',
      imageDigest: null,
      maxProfiles: 4,
      seats: { inUse: 0, limit: null },
      running: [],
    }),
  );
  await welcome;
  return { ws, commands };
}

const upstreams: { ws: WebSocket; closeCode?: number }[] = [];

async function answer(ws: WebSocket, m: Command) {
  ws.send(encodeAgentMessage({ type: 'ack', cmdId: m.cmdId }));
  const cmd = m.cmd;
  if (cmd.kind !== 'vnc.open') return;
  const result = (outcome: 'ok' | 'error', code?: string) =>
    ws.send(
      encodeAgentMessage({
        type: 'result',
        cmdId: m.cmdId,
        outcome,
        ...(code ? { error: { code, message: code } } : {}),
      }),
    );
  if (mode === 'silent') return;
  if (mode === 'refuse') return result('error', 'vnc_target_unreachable');
  const url =
    mode === 'badToken'
      ? cmd.upstreamUrl.replace(/t=[^&]+/, 't=1999999999.forged-token-xxxxxxxxxxxxxxxx')
      : cmd.upstreamUrl;
  const target = track(new WebSocket(`ws://127.0.0.1:${websockifyPort}/websockify`));
  const early: Buffer[] = [];
  const collect = (d: unknown) => early.push(Buffer.from(d as Buffer));
  target.on('message', collect);
  await new Promise((r) => target.once('open', r));
  const up = track(new WebSocket(url));
  const opened = await new Promise<boolean>((r) => {
    up.once('open', () => r(true));
    up.once('unexpected-response', (_q, res) => {
      upstreamRefusals.push(res.statusCode ?? 0);
      r(false);
    });
    up.once('error', () => r(false));
  });
  if (!opened) {
    target.close();
    return result('error', 'vnc_upstream_refused');
  }
  const u: (typeof upstreams)[number] = { ws: up };
  up.on('close', (code) => {
    u.closeCode = code;
    target.close(code === 1005 || code === 1006 ? 1000 : code);
  });
  target.on('close', (code) => up.close(code === 1005 || code === 1006 ? 1000 : code));
  upstreams.push(u);
  target.off('message', collect);
  for (const d of early.splice(0)) up.send(d);
  target.on('message', (d, b) => up.send(d, { binary: b }));
  up.on('message', (d, b) => target.send(d, { binary: b }));
  result('ok');
}
const upstreamRefusals: number[] = [];

// ── the fake web side ──

function viewerUrl(over: { sessionId?: string; now?: number; profileId?: string } = {}) {
  return `ws://${base}${signInternalVncUrl(SECRET, {
    profileId: over.profileId ?? profileId,
    sessionId: over.sessionId ?? sessionId,
    now: over.now,
  })}`;
}

function openViewer(url = viewerUrl(), headers: Record<string, string> = {}) {
  const ws = track(new WebSocket(url, { headers }));
  const inbox: Buffer[] = [];
  ws.on('message', (d) => inbox.push(Buffer.from(d as Buffer)));
  const state: { closeCode?: number } = {};
  ws.on('close', (code) => {
    state.closeCode = code;
  });
  const outcome = new Promise<{ open: true } | { open: false; status: number }>((resolve) => {
    ws.once('open', () => resolve({ open: true }));
    ws.once('unexpected-response', (_req, res) => resolve({ open: false, status: res.statusCode ?? 0 }));
    ws.once('error', () => resolve({ open: false, status: 0 }));
  });
  return { ws, inbox, outcome, state };
}

const sessionLogs = () =>
  prisma.auditEvent.findMany({ where: { sessionId, action: 'session.log' }, orderBy: { at: 'asc' } });

// ── tests ──

describe('signing', () => {
  it('internal URLs: valid, tampered, expired, too far ahead', () => {
    const now = Date.now();
    const path = signInternalVncUrl(SECRET, { profileId: 'p1', sessionId: 's1', now });
    const url = new URL(path, 'http://gw');
    expect(verifyInternalVncUrl(SECRET, url, now)).toEqual({ ok: true, profileId: 'p1', sessionId: 's1' });
    const other = new URL(url);
    other.searchParams.set('session', 's2');
    expect(verifyInternalVncUrl(SECRET, other, now)).toMatchObject({ ok: false, status: 403 });
    expect(verifyInternalVncUrl('another-secret-0123456789', url, now)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(verifyInternalVncUrl(SECRET, url, now + 61_000)).toMatchObject({ ok: false, reason: 'expired' });
    const far = new URL(
      signInternalVncUrl(SECRET, { profileId: 'p1', sessionId: 's1', now, ttlSec: 3600 }),
      'http://gw',
    );
    expect(verifyInternalVncUrl(SECRET, far, now)).toMatchObject({
      ok: false,
      reason: 'expiry too far ahead',
    });
    expect(verifyInternalVncUrl(SECRET, new URL(`${INTERNAL_VNC_PREFIX}p1`, 'http://gw'), now)).toMatchObject(
      {
        ok: false,
        status: 400,
      },
    );
  });

  it('agent tokens are bound to node, profile, session and nonce, and expire after 60 s', () => {
    const claims = { node: 'browser-1', profileId: 'p1', sessionId: 's1', nonce: 'n1' };
    const now = Date.now();
    const t = signVncToken(SECRET, claims, now);
    expect(verifyVncToken(SECRET, t, claims, now)).toEqual({ ok: true });
    expect(verifyVncToken(SECRET, t, { ...claims, nonce: 'n2' }, now)).toEqual({
      ok: false,
      reason: 'bad signature',
    });
    expect(verifyVncToken(SECRET, t, { ...claims, node: 'browser-2' }, now)).toMatchObject({ ok: false });
    expect(verifyVncToken(SECRET, t, claims, now + (VNC_TOKEN_TTL_SEC + 1) * 1000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyVncToken(SECRET, 'garbage', claims, now)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('relay', () => {
  beforeAll(async () => {
    agent = await onlineAgent();
  });

  it('round-trips bytes between the viewer and the profile display, and logs the connection', async () => {
    const v = openViewer();
    expect(await v.outcome).toEqual({ open: true });
    await until(() => v.inbox.length >= 1);
    expect(v.inbox[0]).toEqual(GREETING); // sent by websockify before the viewer was attached
    const bytes = Buffer.from([3, 0, 0, 0, 0, 0, 4, 0, 3, 0, 255, 1]);
    v.ws.send(bytes);
    await until(() => v.inbox.length >= 2);
    expect(v.inbox[1]).toEqual(bytes);

    const cmd = agent!.commands.at(-1)!;
    expect(cmd.cmd).toMatchObject({ kind: 'vnc.open', profileId, sessionId });
    expect(cmd.cmdId).toMatch(new RegExp(`^vnc-${sessionId}-[0-9a-f]+$`));
    expect(cmd.cmd.kind === 'vnc.open' && cmd.cmd.upstreamUrl).toMatch(
      new RegExp(`^ws://${base}/vnc/${sessionId}\\?t=\\d+\\.`),
    );
    const row = await until(async () =>
      (await sessionLogs()).find((r) => (r.meta as { vnc?: string }).vnc === 'connected'),
    );
    expect(row).toMatchObject({ targetType: 'BrowserSession', targetId: sessionId });
  });

  it('viewer closing tears down the agent pipe and the display socket', async () => {
    const v = openViewer();
    await v.outcome;
    const target = await until(() => targetConns.at(-1));
    v.ws.close(1000);
    expect(await until(() => target.closeCode)).toBe(1000);
    await until(async () =>
      (await sessionLogs()).some((r) => (r.meta as { vnc?: string }).vnc === 'disconnected'),
    );
  });

  it('agent side closing closes the viewer with the same code', async () => {
    const v = openViewer();
    await v.outcome;
    const target = await until(() => targetConns.at(-1));
    target.ws.close(4000, 'display gone');
    expect(await until(() => v.state.closeCode)).toBe(4000);
  });

  it('agent session.activity events become session log rows', async () => {
    const v = openViewer();
    await v.outcome;
    agent!.ws.send(encodeAgentMessage({ type: 'event', profileId, kind: 'session.activity' }));
    await until(async () =>
      (await sessionLogs()).some((r) => (r.meta as { vnc?: string }).vnc === 'activity'),
    );
  });

  it('ending the session (hand-back or idle) closes the relay', async () => {
    const v = openViewer();
    await v.outcome;
    await prisma.browserSession.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    expect(await until(() => v.state.closeCode)).toBe(4410);
  });

  it('refuses bad, expired and public requests from the web side', async () => {
    const bad = viewerUrl().replace(/sig=[^&]+/, 'sig=AAAA');
    expect(await openViewer(bad).outcome).toEqual({ open: false, status: 403 });
    expect(await openViewer(viewerUrl({ now: Date.now() - 120_000 })).outcome).toEqual({
      open: false,
      status: 403,
    });
    expect(await openViewer(viewerUrl(), { 'x-forwarded-for': '203.0.113.9' }).outcome).toEqual({
      open: false,
      status: 404,
    });
    // Correctly signed, but not the profile's open human session.
    expect(await openViewer(viewerUrl({ sessionId: 'not-the-session' })).outcome).toEqual({
      open: false,
      status: 409,
    });
  });

  it('refuses an agent dial with a forged token, and one with no pending relay', async () => {
    mode = 'badToken';
    const before = upstreamRefusals.length;
    expect(await openViewer().outcome).toEqual({ open: false, status: 502 });
    expect(upstreamRefusals.slice(before)).toEqual([403]);

    const stray = track(
      new WebSocket(
        `ws://${base}/vnc/${sessionId}?t=${signVncToken(SECRET, { node: node.name, profileId, sessionId, nonce: 'x' })}`,
      ),
    );
    const status = await new Promise<number>((r) =>
      stray.once('unexpected-response', (_q, res) => r(res.statusCode ?? 0)),
    );
    expect(status).toBe(404);
  });

  it('answers 502 when the agent refuses and 504 when it never dials', async () => {
    mode = 'refuse';
    expect(await openViewer().outcome).toEqual({ open: false, status: 502 });
    mode = 'silent';
    const t0 = Date.now();
    expect(await openViewer().outcome).toEqual({ open: false, status: 504 });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('answers 503 when the profile’s node is offline', async () => {
    agent!.ws.close();
    await until(() => !gw.hub.isOnline(node.name));
    expect(await openViewer().outcome).toEqual({ open: false, status: 503 });
  });
});

describe('browsers with no account (plan 0003)', () => {
  it('profileNode reports no account and session logs carry accountId null', async () => {
    const workspaceId = (await prisma.workspace.findFirstOrThrow({ select: { id: true } })).id;
    const p = await prisma.browserProfile.create({
      data: { workspaceId, name: `t24-noacct-${randomBytes(3).toString('hex')}`, nodeId: node.id },
    });
    const s = await prisma.browserSession.create({
      data: { workspaceId, profileId: p.id, driver: 'human' },
    });
    try {
      expect(await dbVncRepo.profileNode(workspaceId, p.id)).toEqual({
        accountId: null,
        node: { name: node.name, workspaceId },
      });
      await dbVncRepo.logSession({
        session: { id: s.id, workspaceId, profileId: p.id, driver: 'human', startedByMemberId: null },
        accountId: null,
        text: 'Opened the remote display',
        kind: 'connected',
      });
      const ev = await prisma.auditEvent.findFirstOrThrow({
        where: { sessionId: s.id, action: 'session.log' },
      });
      expect(ev.accountId).toBeNull();
    } finally {
      // AuditEvent is append-only: end the session and park the profile instead of deleting them.
      await prisma.browserSession.update({ where: { id: s.id }, data: { endedAt: new Date() } });
      await parkInScratchWorkspace(p.id);
    }
  });
});

describe('web ↔ gateway signature contract', () => {
  it('the gateway accepts exactly what the web proxy signs (both use @threadline/shared/vnc-sign)', async () => {
    const { signGatewayVncUrl } = await import('../../../web/vnc-proxy');
    const now = Date.UTC(2026, 10, 8, 2, 0, 0);
    const signed = new URL(
      signGatewayVncUrl({
        gatewayUrl: 'http://node-gateway.railway.internal:8080',
        secret: SECRET,
        profileId: 'p1',
        sessionId: 's1',
        nowMs: now,
      }),
    );
    expect(
      verifyInternalVncUrl(SECRET, new URL(`${signed.pathname}${signed.search}`, 'http://gw'), now),
    ).toEqual({
      ok: true,
      profileId: 'p1',
      sessionId: 's1',
    });
  });
});

/** Moves a test-made browser out of the seeded workspace (AuditEvent is append-only, so it cannot be deleted). */
async function parkInScratchWorkspace(profileId: string) {
  const slug = `t00-ws-${randomBytes(4).toString('hex')}`;
  const ws = await prisma.workspace.create({ data: { name: 'Test', slug } });
  await prisma.browserProfile.update({
    where: { id: profileId },
    data: { nodeId: null, workspaceId: ws.id, createdByMemberId: null },
  });
}
