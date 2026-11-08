/**
 * VNC relay (docs/plans/0001-infra-implementation.md §3.4, T24; ADR-0001 "VNC take-over").
 *
 * The node publishes no ports, so a human's view of a profile is built from two sockets that both end here:
 *
 *   web (custom server, T23) ──ws──▶ gateway /internal/vnc/<profileId>?session=…&exp=…&sig=…   (private network)
 *   node agent               ──ws──▶ gateway /vnc/<sessionId>?t=<token>                         (public, outbound from the node)
 *
 * 1. The web side upgrades `/internal/vnc/<profileId>`. The URL is signed with `GATEWAY_INTERNAL_SECRET`
 *    (see {@link signInternalVncUrl}); requests that came through Railway's public edge are refused, so the path
 *    is reachable on the private network only. The BrowserSession named by `session` must be the profile's open
 *    human session, and the profile's node must be connected.
 * 2. The gateway sends `vnc.open` with a one-time HMAC token valid {@link VNC_TOKEN_TTL_SEC} s and waits up to
 *    {@link VNC_DIAL_TIMEOUT_MS} for the agent to dial `/vnc/<sessionId>?t=<token>`.
 * 3. Only then is the web upgrade completed, and binary frames are piped both ways. Either side closing closes
 *    the other; so does the session ending (hand-back or `session.idle`) and gateway shutdown.
 *
 * The web side gets a plain HTTP status when the relay cannot be set up: 403 bad signature, 409 not the open
 * human session (or superseded by a newer viewer), 503 no node / node offline, 502 the agent refused, 504 the
 * agent did not dial in time.
 *
 * Session activity: the agent sends `session.activity` events while the human is typing or pointing. The relay
 * turns them (and connect/disconnect) into `session.log` audit rows on the BrowserSession, at most one per
 * {@link ACTIVITY_LOG_EVERY_MS}, which is what `session.idle` reads to end idle sessions.
 *
 * Tokens and signed URLs are never logged.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { audit, browsers, nodes } from '@threadline/db';
import { VNC_TOKEN_TTL_SEC } from '@threadline/shared';
import {
  INTERNAL_URL_MAX_TTL_SEC,
  INTERNAL_VNC_PREFIX,
  verifyInternalVncUrl,
} from '@threadline/shared/vnc-sign';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import type { log as rootLog } from '../log';
import type { GatewayContext, GatewayPlugin } from './index';

// ── constants ──

/** Web → gateway, private network only. */
export { INTERNAL_VNC_PREFIX } from '@threadline/shared/vnc-sign';
/** Agent → gateway, the agent's second outbound socket. */
export const VNC_UPSTREAM_PREFIX = '/vnc/';
/** How long the gateway waits for the agent to dial back after `vnc.open`. */
export const VNC_DIAL_TIMEOUT_MS = 10_000;
/** Longest lifetime a web-signed `/internal/vnc` URL may claim. */
export { INTERNAL_URL_MAX_TTL_SEC } from '@threadline/shared/vnc-sign';
/** At most one `session.log` activity row per session per this interval. */
export const ACTIVITY_LOG_EVERY_MS = 5 * 60_000;
/** How often open relays are checked against their BrowserSession (hand-back, idle end). */
export const SESSION_CHECK_EVERY_MS = 30_000;
/** Framebuffer updates can be large; one message may carry a whole screen. */
const MAX_FRAME_BYTES = 32 << 20;
/** Pause the sender when the receiver has this much queued, resume below the low mark. */
const HIGH_WATER = 4 << 20;
const LOW_WATER = 1 << 20;

/** Close codes the relay uses on its sockets (in addition to the peer's own codes, which are passed through). */
export const VncCloseCode = {
  sessionEnded: 4410,
  superseded: 4409,
  shutdown: 1001,
} as const;

/** Headers Railway's public edge adds. Their presence means the request did not come over the private network. */
const EDGE_HEADERS = ['x-forwarded-for', 'x-real-ip', 'x-railway-edge', 'x-railway-request-id', 'forwarded'];

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ── signing: web → gateway ──
// One implementation shared with the web side: packages/shared/src/vnc-sign.ts.
export { signInternalVncUrl, verifyInternalVncUrl, type InternalCheck } from '@threadline/shared/vnc-sign';

function hmac(secret: string, message: string): Buffer {
  return createHmac('sha256', secret).update(message).digest();
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── signing: gateway → agent (the token inside `vnc.open`) ──

export interface VncTokenClaims {
  node: string;
  profileId: string;
  sessionId: string;
  /** Random per relay attempt: a token opens exactly one attempt. */
  nonce: string;
}

const tokenMessage = (c: VncTokenClaims, exp: number) =>
  `tl-vnc-agent.v1\n${c.node}\n${c.profileId}\n${c.sessionId}\n${c.nonce}\n${exp}`;

/** `<exp>.<base64url hmac>`; `exp` is unix seconds, {@link VNC_TOKEN_TTL_SEC} ahead. */
export function signVncToken(secret: string, claims: VncTokenClaims, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + VNC_TOKEN_TTL_SEC;
  return `${exp}.${hmac(secret, tokenMessage(claims, exp)).toString('base64url')}`;
}

export function verifyVncToken(
  secret: string,
  token: string,
  claims: VncTokenClaims,
  now = Date.now(),
): { ok: true } | { ok: false; reason: 'malformed' | 'bad signature' | 'expired' } {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{20,})$/.exec(token);
  if (!m) return { ok: false, reason: 'malformed' };
  const exp = Number(m[1]);
  if (!sameBytes(Buffer.from(m[2]!, 'base64url'), hmac(secret, tokenMessage(claims, exp))))
    return { ok: false, reason: 'bad signature' };
  if (exp < Math.floor(now / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true };
}

// ── data access ──

export interface VncSession {
  id: string;
  workspaceId: string;
  profileId: string;
  driver: string;
  startedByMemberId: string | null;
}

export interface VncRepo {
  /** The profile's open BrowserSession, if any. */
  openSession(profileId: string): Promise<VncSession | null>;
  /** The profile's account (null for a browser with no account, plan 0003) and node (with name). */
  profileNode(
    workspaceId: string,
    profileId: string,
  ): Promise<{ accountId: string | null; node: { name: string; workspaceId: string } | null } | null>;
  /** Appends a `session.log` row to the session (what `session.idle` reads). */
  logSession(entry: {
    session: VncSession;
    /** null for a browser with no account */
    accountId: string | null;
    text: string;
    kind: 'connected' | 'disconnected' | 'activity';
  }): Promise<void>;
}

export const dbVncRepo: VncRepo = {
  async openSession(profileId) {
    const s = await browsers.openSession(profileId);
    return s
      ? {
          id: s.id,
          workspaceId: s.workspaceId,
          profileId: s.profileId,
          driver: s.driver,
          startedByMemberId: s.startedByMemberId,
        }
      : null;
  },
  async profileNode(workspaceId, profileId) {
    const p = await browsers.getProfile(workspaceId, profileId);
    if (!p) return null;
    const n = p.nodeId ? await nodes.getById(p.nodeId) : null;
    return { accountId: p.accountId, node: n ? { name: n.name, workspaceId: n.workspaceId } : null };
  },
  async logSession({ session, accountId, text, kind }) {
    await audit.writeAudit({
      workspaceId: session.workspaceId,
      actorMemberId: session.startedByMemberId,
      action: 'session.log',
      targetType: 'BrowserSession',
      targetId: session.id,
      sessionId: session.id,
      accountId,
      meta: { text, vnc: kind },
    });
  },
};

// ── piping ──

type Sink = (data: RawData, isBinary: boolean) => void;

/** Buffers a socket's messages from the moment it opens until a sink is attached. */
function hold(ws: WebSocket): { release(sink: Sink): void } {
  const queue: [RawData, boolean][] = [];
  let sink: Sink | null = null;
  ws.on('message', (data, isBinary) => (sink ? sink(data, isBinary) : queue.push([data, isBinary])));
  return {
    release(s) {
      sink = s;
      for (const [d, b] of queue.splice(0)) s(d, b);
    },
  };
}

/** Codes a peer may legally send in a close frame; others (1005, 1006, 1015) are mapped. */
function forwardableCode(code: number): number {
  if (code === 1005) return 1000;
  if (code === 1006) return 1001;
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999))
    return code;
  return 1011;
}

export function closeQuietly(ws: WebSocket, code: number, reason = ''): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CLOSING) {
    setTimeout(() => ws.terminate(), 2_000).unref();
    return;
  }
  try {
    ws.close(forwardableCode(code), reason.slice(0, 120));
    setTimeout(() => ws.terminate(), 2_000).unref();
  } catch {
    ws.terminate();
  }
}

function forward(from: WebSocket, to: WebSocket, onFrame?: (data: RawData) => void): Sink {
  return (data, isBinary) => {
    if (to.readyState !== WebSocket.OPEN) return;
    onFrame?.(data);
    to.send(data, { binary: isBinary }, () => {
      if (from.isPaused && to.bufferedAmount < LOW_WATER) from.resume();
    });
    if (to.bufferedAmount > HIGH_WATER && !from.isPaused) from.pause();
  };
}

/** Pipes two open sockets; resolves when both are closed. Either side closing (or erroring) closes the other. */
function pipe(
  a: { ws: WebSocket; held: { release(s: Sink): void } },
  b: { ws: WebSocket; held: { release(s: Sink): void } },
): Promise<void> {
  const closed = (ws: WebSocket) =>
    ws.readyState === WebSocket.CLOSED
      ? Promise.resolve()
      : new Promise<void>((r) => ws.once('close', () => r()));
  const done = Promise.all([closed(a.ws), closed(b.ws)]).then(() => undefined);
  const wire = (x: WebSocket, y: WebSocket) => {
    x.once('close', (code, reason) => closeQuietly(y, code, reason.toString()));
    x.on('error', () => y.terminate());
  };
  wire(a.ws, b.ws);
  wire(b.ws, a.ws);
  a.held.release(forward(a.ws, b.ws));
  b.held.release(forward(b.ws, a.ws));
  // A side that closed before wiring.
  if (a.ws.readyState !== WebSocket.OPEN) closeQuietly(b.ws, 1001);
  if (b.ws.readyState !== WebSocket.OPEN) closeQuietly(a.ws, 1001);
  return done;
}

// ── relay plugin ──

export interface VncRelayOptions {
  /** Default `process.env` at start. Reads `GATEWAY_INTERNAL_SECRET`, `GATEWAY_PUBLIC_URL`, `RAILWAY_PUBLIC_DOMAIN`. */
  env?: NodeJS.ProcessEnv;
  /** Base the agent dials, e.g. `wss://nodes.example.com`. Default from env, else the local listening port. */
  publicUrl?: string;
  dialTimeoutMs?: number;
  activityLogEveryMs?: number;
  sessionCheckEveryMs?: number;
  /** Accept `/internal/vnc` requests that carry public-edge headers. Tests only. */
  allowPublicInternal?: boolean;
  repo?: VncRepo;
}

class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Dialing {
  claims: VncTokenClaims;
  token: string;
  resolve(v: { ws: WebSocket; held: { release(s: Sink): void } }): void;
  reject(e: RelayError): void;
}

interface Relay {
  session: VncSession;
  accountId: string | null;
  node: string;
  web: WebSocket;
  agent: WebSocket;
  lastLoggedAt: number;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function refuse(socket: Duplex, status: number) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

export function publicBaseUrl(env: NodeJS.ProcessEnv, port: number | null): string {
  const explicit = env.GATEWAY_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/^http/, 'ws').replace(/\/+$/, '');
  if (env.RAILWAY_PUBLIC_DOMAIN) return `wss://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return `ws://127.0.0.1:${port ?? 8080}`;
}

export class VncRelay {
  private readonly dialing = new Map<string, Dialing>();
  private readonly relays = new Map<string, Relay>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly log: typeof rootLog;
  private readonly repo: VncRepo;
  private readonly env: NodeJS.ProcessEnv;
  private readonly secret: string | null;
  private readonly dialTimeoutMs: number;
  private readonly activityEveryMs: number;
  private checkTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly ctx: GatewayContext,
    private readonly opts: VncRelayOptions = {},
  ) {
    this.log = ctx.log.child({ component: 'gateway.vnc' });
    this.repo = opts.repo ?? dbVncRepo;
    this.env = opts.env ?? process.env;
    const secret = this.env.GATEWAY_INTERNAL_SECRET;
    this.secret = secret && secret.length >= 16 ? secret : null;
    if (!this.secret)
      this.log.warn('GATEWAY_INTERNAL_SECRET is missing or shorter than 16 characters: VNC disabled');
    this.dialTimeoutMs = opts.dialTimeoutMs ?? VNC_DIAL_TIMEOUT_MS;
    this.activityEveryMs = opts.activityLogEveryMs ?? ACTIVITY_LOG_EVERY_MS;
  }

  start(): void {
    const { server, hub } = this.ctx;
    server.upgrade(INTERNAL_VNC_PREFIX, (req, socket, head, url) =>
      this.onWebUpgrade(req, socket, head, url),
    );
    server.upgrade(VNC_UPSTREAM_PREFIX, (req, socket, head, url) =>
      this.onAgentUpgrade(req, socket, head, url),
    );
    server.route(INTERNAL_VNC_PREFIX, (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(426, { 'content-type': 'application/json', upgrade: 'websocket' });
      res.end(JSON.stringify({ error: 'websocket upgrade required' }));
    });
    hub.on('event', ({ node, event }) => {
      if (event.kind === 'session.activity') this.onActivity(node, event.profileId);
    });
    hub.on('offline', ({ name }) => {
      for (const [id, d] of this.dialing)
        if (d.claims.node === name) {
          this.dialing.delete(id);
          d.reject(new RelayError(503, 'node went offline'));
        }
    });
    this.checkTimer = setInterval(
      () => void this.checkSessions(),
      this.opts.sessionCheckEveryMs ?? SESSION_CHECK_EVERY_MS,
    );
    this.checkTimer.unref();
  }

  /** Open relays (for tests and observability). */
  active(): { sessionId: string; profileId: string; node: string }[] {
    return [...this.relays.values()].map((r) => ({
      sessionId: r.session.id,
      profileId: r.session.profileId,
      node: r.node,
    }));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.checkTimer);
    for (const [id, d] of this.dialing) {
      this.dialing.delete(id);
      d.reject(new RelayError(503, 'gateway shutting down'));
    }
    const closing = [...this.relays.values()].flatMap((r) => [r.web, r.agent]);
    for (const ws of closing) closeQuietly(ws, VncCloseCode.shutdown, 'gateway shutting down');
    await Promise.all(
      closing.map((ws) =>
        ws.readyState === WebSocket.CLOSED
          ? undefined
          : new Promise<void>((r) => ws.once('close', () => r())),
      ),
    );
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  // ── web side ──

  private onWebUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
    if (this.stopping || !this.secret) return refuse(socket, 503);
    if (!this.opts.allowPublicInternal && EDGE_HEADERS.some((h) => req.headers[h] !== undefined))
      return refuse(socket, 404); // the internal path does not exist on the public domain
    const check = verifyInternalVncUrl(this.secret, url);
    if (!check.ok) {
      this.log.warn({ reason: check.reason }, 'vnc request refused');
      return refuse(socket, check.status);
    }
    this.connect(check.profileId, check.sessionId, req, socket, head).catch((e) => {
      const status = e instanceof RelayError ? e.status : 500;
      if (status === 500) this.log.error({ err: (e as Error).message }, 'vnc relay failed');
      else
        this.log.warn(
          { status, why: (e as Error).message, profileId: check.profileId },
          'vnc relay not opened',
        );
      refuse(socket, status);
    });
  }

  private async connect(
    profileId: string,
    sessionId: string,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const session = await this.repo.openSession(profileId);
    if (!session || session.id !== sessionId || session.driver !== 'human')
      throw new RelayError(409, 'not the open human session for this profile');
    const p = await this.repo.profileNode(session.workspaceId, profileId);
    if (!p?.node || p.node.workspaceId !== session.workspaceId)
      throw new RelayError(503, 'profile has no browser node');
    const node = p.node.name;
    if (!this.ctx.hub.isOnline(node)) throw new RelayError(503, 'browser node is offline');
    if (socket.destroyed) return;

    const claims: VncTokenClaims = { node, profileId, sessionId, nonce: randomBytes(9).toString('hex') };
    const token = signVncToken(this.secret!, claims);
    const agentSide = await this.dialAgent(claims, token, socket);
    if (socket.destroyed || this.stopping) {
      closeQuietly(agentSide.ws, 1001, 'viewer left');
      return;
    }
    let upgraded = false;
    // `ws` answers a malformed upgrade itself without calling back: do not leave the agent's socket open.
    socket.once('close', () => {
      if (!upgraded) closeQuietly(agentSide.ws, 1001, 'viewer left');
    });
    this.wss.handleUpgrade(req, socket, head, (web) => {
      upgraded = true;
      const held = hold(web);
      this.startRelay(session, p.accountId, node, { ws: web, held }, agentSide);
    });
  }

  private dialAgent(
    claims: VncTokenClaims,
    token: string,
    viewer: Duplex,
  ): Promise<{ ws: WebSocket; held: { release(s: Sink): void } }> {
    const { sessionId } = claims;
    const previous = this.dialing.get(sessionId);
    if (previous) {
      this.dialing.delete(sessionId);
      previous.reject(new RelayError(409, 'superseded by a newer viewer'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => fail(new RelayError(504, 'agent did not dial back in time')),
        this.dialTimeoutMs,
      );
      const onViewerGone = () => fail(new RelayError(499, 'viewer left'));
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        viewer.off('close', onViewerGone);
        if (this.dialing.get(sessionId) === entry) this.dialing.delete(sessionId);
      };
      const fail = (e: RelayError) => {
        if (settled) return;
        cleanup();
        reject(e);
      };
      const entry: Dialing = {
        claims,
        token,
        resolve: (v) => {
          if (settled) return closeQuietly(v.ws, 1001, 'relay abandoned');
          cleanup();
          resolve(v);
        },
        reject: fail,
      };
      this.dialing.set(sessionId, entry);
      viewer.once('close', onViewerGone);

      const base = this.opts.publicUrl ?? publicBaseUrl(this.env, this.listeningPort());
      const upstreamUrl = `${base}${VNC_UPSTREAM_PREFIX}${encodeURIComponent(sessionId)}?t=${encodeURIComponent(token)}`;
      this.ctx.hub
        .send(
          claims.node,
          { kind: 'vnc.open', profileId: claims.profileId, sessionId, upstreamUrl, token },
          { cmdId: `vnc-${sessionId}-${claims.nonce}`, deadlineMs: this.dialTimeoutMs },
        )
        .then((r) => {
          if (r.outcome !== 'ok')
            fail(new RelayError(502, `agent refused vnc.open (${r.error?.code ?? r.outcome})`));
        })
        .catch((e: Error) => fail(new RelayError(e.name === 'NodeTimeout' ? 504 : 503, e.message)));
    });
  }

  private listeningPort(): number | null {
    const a = this.ctx.server.http.address() as AddressInfo | null;
    return a && typeof a === 'object' ? a.port : null;
  }

  // ── agent side ──

  private onAgentUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
    if (this.stopping || !this.secret) return refuse(socket, 503);
    const sessionId = decodeURIComponent(url.pathname.slice(VNC_UPSTREAM_PREFIX.length));
    const token = url.searchParams.get('t') ?? '';
    const d = ID_RE.test(sessionId) ? this.dialing.get(sessionId) : undefined;
    if (!d) {
      this.log.warn({ ip: req.socket.remoteAddress }, 'vnc dial for no pending relay');
      return refuse(socket, 404);
    }
    const v = verifyVncToken(this.secret, token, d.claims);
    // The signature proves the claims; the exact-match binds the dial to this one attempt.
    if (!v.ok || !sameBytes(Buffer.from(token), Buffer.from(d.token))) {
      this.log.warn({ node: d.claims.node, reason: v.ok ? 'stale token' : v.reason }, 'vnc dial refused');
      return refuse(socket, 403);
    }
    this.dialing.delete(sessionId);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const held = hold(ws);
      d.resolve({ ws, held });
    });
  }

  // ── relays ──

  private startRelay(
    session: VncSession,
    accountId: string | null,
    node: string,
    web: { ws: WebSocket; held: { release(s: Sink): void } },
    agent: { ws: WebSocket; held: { release(s: Sink): void } },
  ) {
    const old = this.relays.get(session.id);
    if (old) {
      closeQuietly(old.web, VncCloseCode.superseded, 'replaced by a newer viewer');
      closeQuietly(old.agent, VncCloseCode.superseded, 'replaced by a newer viewer');
    }
    const relay: Relay = { session, accountId, node, web: web.ws, agent: agent.ws, lastLoggedAt: Date.now() };
    this.relays.set(session.id, relay);
    this.log.info({ node, profileId: session.profileId, sessionId: session.id }, 'vnc relay open');
    this.writeLog(relay, 'connected', 'Opened the remote display');
    void pipe(web, agent).then(() => {
      if (this.relays.get(session.id) === relay) this.relays.delete(session.id);
      this.log.info({ node, profileId: session.profileId, sessionId: session.id }, 'vnc relay closed');
      if (!this.stopping) this.writeLog(relay, 'disconnected', 'Closed the remote display');
    });
  }

  private onActivity(node: string, profileId: string) {
    for (const r of this.relays.values()) {
      if (r.node !== node || r.session.profileId !== profileId) continue;
      if (Date.now() - r.lastLoggedAt < this.activityEveryMs) continue;
      r.lastLoggedAt = Date.now();
      this.writeLog(r, 'activity', 'Active at the controls');
    }
  }

  private writeLog(r: Relay, kind: 'connected' | 'disconnected' | 'activity', text: string) {
    r.lastLoggedAt = Date.now();
    this.repo
      .logSession({ session: r.session, accountId: r.accountId, text, kind })
      .catch((e) =>
        this.log.error({ err: (e as Error).message, sessionId: r.session.id }, 'vnc session log failed'),
      );
  }

  /** Closes relays whose BrowserSession has ended (handed back, or ended by `session.idle`). */
  async checkSessions(): Promise<void> {
    for (const r of [...this.relays.values()]) {
      try {
        const open = await this.repo.openSession(r.session.profileId);
        if (open?.id === r.session.id) continue;
        this.log.info({ sessionId: r.session.id }, 'session ended: closing vnc relay');
        closeQuietly(r.web, VncCloseCode.sessionEnded, 'session ended');
        closeQuietly(r.agent, VncCloseCode.sessionEnded, 'session ended');
      } catch (e) {
        this.log.error({ err: (e as Error).message }, 'vnc session check failed');
      }
    }
  }
}

/** Gateway plugin: mount with `startGateway({ plugins: [createVncPlugin()] })`. */
export function createVncPlugin(opts: VncRelayOptions = {}): GatewayPlugin & { relay(): VncRelay | null } {
  let relay: VncRelay | null = null;
  return {
    name: 'vnc',
    relay: () => relay,
    start(ctx) {
      const r = new VncRelay(ctx, opts);
      relay = r;
      r.start();
      return () => r.stop();
    },
  };
}

export const vncPlugin = createVncPlugin();
