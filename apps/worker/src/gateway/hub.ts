/**
 * Gateway hub: one authenticated WebSocket per browser node (docs/plans/0001-infra-implementation.md §3.4).
 *
 * Lifecycle of a connection:
 *   upgrade → auth (4426 protocol version, 4401 token, 4409 name already connected) → `hello` (else 4400)
 *   → `nodes.markOnline` (writes `node.online`) → `welcome` → heartbeats … → close or 45 s of silence
 *   → `nodes.markOffline` (writes `node.offline`) and every in-flight command fails with `NodeDisconnected`.
 *
 * `hub.send(nodeName, cmd, { cmdId, deadlineMs })` resolves with the agent's `result`. It rejects with
 * `NodeNotConnected` (no ready socket), `NodeTimeout` (no `ack` within 2 s or no result before the deadline) or
 * `NodeDisconnected` (socket closed first); all three are retryable. `cmdId` is the BullMQ job id: the agent
 * replays a stored result for a `cmdId` it has already run, which is what makes a retry safe for posting.
 *
 * Frames are validated with the shared zod schemas on the way in and out. Command frames can carry decrypted
 * proxy credentials, so neither frames nor parse errors that could quote them are logged.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { nodes } from '@threadline/db';
import {
  ACK_TIMEOUT_MS,
  type AgentMessage,
  CloseCode,
  type Cmd,
  HEARTBEAT_SEC,
  MISSED_HEARTBEATS_OFFLINE,
  type NodeEvent,
  PROTOCOL_VERSION,
  type ProfileRef,
  type Result,
  type Seats,
  encodeGatewayMessage,
  parseAgentMessage,
} from '@threadline/shared';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { log as rootLog } from '../log';
import { type NodeRow, type VerifyToken, authenticate, pickSubprotocol } from './auth';

// ── errors ──

export type NodeErrorCode = 'NodeNotConnected' | 'NodeTimeout' | 'NodeDisconnected';

/** A command did not get a result from its node. Always retryable: the agent replays results by `cmdId`. */
export class NodeError extends Error {
  readonly retryable = true;
  constructor(
    readonly code: NodeErrorCode,
    readonly node: string,
    readonly cmdId: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = code;
  }
}

// ── public types ──

export interface NodeInfo {
  name: string;
  nodeId: string;
  workspaceId: string;
  agentVersion: string;
  imageDigest: string | null;
  maxProfiles: number;
  seats: Seats;
  running: ProfileRef[];
  connectedAt: Date;
  lastSeenAt: Date;
}

export interface OfflineInfo {
  name: string;
  nodeId: string;
  workspaceId: string;
  reason: OfflineReason;
}

export type OfflineReason = 'disconnected' | 'heartbeat_timeout' | 'protocol_error' | 'gateway_shutdown';

export interface HubEvents {
  /** After `hello`, `markOnline` and `welcome`: the node accepts commands. */
  online: [NodeInfo];
  /** After `markOffline`. In-flight commands have already been rejected. */
  offline: [OfflineInfo];
  heartbeat: [NodeInfo];
  /** Agent `event` frames (`container.exited`, `session.activity`, `needs_human`). */
  event: [{ node: string; nodeId: string; workspaceId: string; event: NodeEvent }];
}

export type NodeRepo = Pick<typeof nodes, 'markOnline' | 'markOffline' | 'recordHeartbeat'> & {
  verifyToken: VerifyToken;
};

export interface HubOptions {
  /** Sent in `welcome`. Default {@link HEARTBEAT_SEC}. */
  heartbeatSec?: number;
  /** Silence after which a node is offline. Default heartbeatSec × {@link MISSED_HEARTBEATS_OFFLINE} (45 s). */
  offlineAfterMs?: number;
  /** Default {@link ACK_TIMEOUT_MS}. */
  ackTimeoutMs?: number;
  /** How long an authenticated socket may wait before `hello`. Default 10 s. */
  helloTimeoutMs?: number;
  /** Network slack added to `deadlineMs` (the agent counts it from receipt). Default 1 s. */
  deadlineGraceMs?: number;
  repo?: NodeRepo;
  log?: typeof rootLog;
}

export interface SendOptions {
  /** The BullMQ job id. */
  cmdId: string;
  /** Time budget for the result, sent to the agent as is. */
  deadlineMs: number;
}

// ── internals ──

interface Pending {
  cmdId: string;
  promise: Promise<Result>;
  resolve: (r: Result) => void;
  reject: (e: Error) => void;
  ackTimer?: NodeJS.Timeout;
  deadlineTimer?: NodeJS.Timeout;
}

interface Conn {
  ws: WebSocket;
  node: NodeRow;
  state: 'awaiting_hello' | 'ready' | 'closed';
  info?: NodeInfo;
  /** `markOnline` committed for this socket, so its close must write `node.offline`. */
  markedOnline: boolean;
  lastSeen: number;
  pending: Map<string, Pending>;
  /** Serializes message handling and the final markOffline, so DB writes happen in arrival order. */
  chain: Promise<void>;
  helloTimer?: NodeJS.Timeout;
  offlineReason?: OfflineReason;
  done: Promise<void>;
  markDone: () => void;
}

/** RFC 6455 caps a close reason at 123 bytes; `ws` throws on longer ones. */
function closeReason(text: string): string {
  const buf = Buffer.from(text, 'utf8');
  return buf.length <= 123 ? text : `${buf.subarray(0, 120).toString('utf8').replace(/�+$/, '')}...`;
}

function safeClose(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, closeReason(reason));
  } catch {
    ws.terminate();
  }
}

export class Hub extends EventEmitter<HubEvents> {
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<string, Conn>();
  private readonly heartbeatSec: number;
  private readonly offlineAfterMs: number;
  private readonly ackTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly deadlineGraceMs: number;
  private readonly repo: NodeRepo;
  private readonly log: typeof rootLog;
  private readonly watchdog: NodeJS.Timeout;
  private stopping = false;

  constructor(opts: HubOptions = {}) {
    super();
    this.heartbeatSec = opts.heartbeatSec ?? HEARTBEAT_SEC;
    this.offlineAfterMs = opts.offlineAfterMs ?? this.heartbeatSec * MISSED_HEARTBEATS_OFFLINE * 1000;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
    this.deadlineGraceMs = opts.deadlineGraceMs ?? 1_000;
    this.repo = opts.repo ?? nodes;
    this.log = (opts.log ?? rootLog).child({ component: 'gateway.hub' });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 1 << 20,
      handleProtocols: (offered) => pickSubprotocol(offered),
    });
    const tick = Math.max(50, Math.min(1_000, Math.floor(this.offlineAfterMs / 4)));
    this.watchdog = setInterval(() => this.sweep(), tick);
    this.watchdog.unref();
  }

  /** Hand an HTTP upgrade for `/agent` to the hub. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.stopping) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.accept(ws, req);
    });
  }

  /** Ready (post-`hello`) nodes. */
  nodes(): NodeInfo[] {
    return [...this.conns.values()].flatMap((c) => (c.state === 'ready' && c.info ? [{ ...c.info }] : []));
  }

  isOnline(name: string): boolean {
    return this.conns.get(name)?.state === 'ready';
  }

  /** Sends a command and resolves with the agent's result. See the module comment for failure modes. */
  send(nodeName: string, cmd: Cmd, opts: SendOptions): Promise<Result> {
    const conn = this.conns.get(nodeName);
    if (!conn || conn.state !== 'ready')
      return Promise.reject(new NodeError('NodeNotConnected', nodeName, opts.cmdId, 'node is not connected'));

    // Same job id while the first send is still in flight: share its outcome, never send twice.
    const existing = conn.pending.get(opts.cmdId);
    if (existing) return existing.promise;

    let frame: string;
    try {
      frame = encodeGatewayMessage({ type: 'command', cmdId: opts.cmdId, deadlineMs: opts.deadlineMs, cmd });
    } catch (e) {
      // zod issues name paths, but a received literal could be a credential: report paths only.
      const issues = (e as { issues?: { path: (string | number)[] }[] }).issues;
      const where = issues?.map((i) => i.path.join('.')).join(', ') ?? 'unknown';
      return Promise.reject(new Error(`invalid command for ${nodeName} (${where})`));
    }

    let resolve!: (r: Result) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<Result>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const p: Pending = { cmdId: opts.cmdId, promise, resolve, reject };
    conn.pending.set(opts.cmdId, p);

    const fail = (code: NodeErrorCode, message: string) =>
      this.settle(conn, opts.cmdId, new NodeError(code, nodeName, opts.cmdId, message));
    p.ackTimer = setTimeout(
      () => fail('NodeTimeout', `no ack within ${this.ackTimeoutMs} ms`),
      this.ackTimeoutMs,
    );
    p.deadlineTimer = setTimeout(
      () => fail('NodeTimeout', `no result within ${opts.deadlineMs} ms`),
      opts.deadlineMs + this.deadlineGraceMs,
    );
    conn.ws.send(frame, (err) => {
      if (err) fail('NodeDisconnected', 'send failed');
    });
    this.log.info({ node: nodeName, cmdId: opts.cmdId, kind: cmd.kind }, 'command sent');
    return promise;
  }

  /** Closes every socket (1001), writes `node.offline` for each, and stops accepting connections. */
  async close(): Promise<void> {
    this.stopping = true;
    clearInterval(this.watchdog);
    const all = [...this.conns.values()];
    for (const c of all) {
      c.offlineReason ??= 'gateway_shutdown';
      safeClose(c.ws, 1001, 'gateway shutting down');
      setTimeout(() => c.ws.terminate(), 1_000).unref();
    }
    await Promise.all(all.map((c) => c.done));
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  // ── connection handling ──

  private async accept(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // Buffer frames that arrive while the token is being checked (agents send `hello` right after open).
    const early: { data: RawData; isBinary: boolean }[] = [];
    const slot: { conn?: Conn } = {};
    let closedEarly = false;
    ws.on('message', (data, isBinary) => {
      if (slot.conn) this.enqueue(slot.conn, data, isBinary);
      else early.push({ data, isBinary });
    });
    ws.on('error', (err) => this.log.warn({ err: err.message }, 'agent socket error'));
    ws.once('close', () => {
      closedEarly = !slot.conn;
    });

    let auth: Awaited<ReturnType<typeof authenticate>>;
    try {
      auth = await authenticate(req, ws.protocol, this.repo.verifyToken);
    } catch (e) {
      this.log.error({ err: (e as Error).message }, 'agent auth failed with an error');
      safeClose(ws, 1011, 'internal error');
      return;
    }
    if (closedEarly) return;
    if (!auth.ok) {
      this.log.warn(
        { code: auth.closeCode, reason: auth.reason, ip: req.socket.remoteAddress },
        'agent refused',
      );
      safeClose(ws, auth.closeCode, auth.reason);
      return;
    }
    const { node } = auth;
    // Synchronous from here to `conns.set`: no other socket can claim the name in between.
    if (this.conns.has(node.name)) {
      this.log.warn({ node: node.name }, 'agent refused: node already connected');
      safeClose(ws, CloseCode.duplicateNode, 'node already connected');
      return;
    }
    let markDone!: () => void;
    const done = new Promise<void>((r) => {
      markDone = r;
    });
    const c: Conn = {
      ws,
      node,
      state: 'awaiting_hello',
      markedOnline: false,
      lastSeen: Date.now(),
      pending: new Map(),
      chain: Promise.resolve(),
      done,
      markDone,
    };
    slot.conn = c;
    this.conns.set(node.name, c);
    c.helloTimer = setTimeout(() => this.protocolError(c, 'no hello'), this.helloTimeoutMs);
    ws.once('close', (code) => this.onClose(c, code));
    this.log.info({ node: node.name }, 'agent authenticated');
    for (const m of early.splice(0)) this.enqueue(c, m.data, m.isBinary);
  }

  private enqueue(conn: Conn, data: RawData, isBinary: boolean) {
    if (conn.state === 'closed') return;
    conn.chain = conn.chain
      .then(() => this.onMessage(conn, data, isBinary))
      .catch((e) => {
        this.log.error({ node: conn.node.name, err: (e as Error).message }, 'agent message handling failed');
        safeClose(conn.ws, 1011, 'internal error');
      });
  }

  private protocolError(conn: Conn, why: string) {
    if (conn.state === 'closed') return;
    this.log.warn({ node: conn.node.name, why }, 'agent protocol error');
    conn.offlineReason ??= 'protocol_error';
    safeClose(conn.ws, CloseCode.protocolError, why);
  }

  private async onMessage(conn: Conn, data: RawData, isBinary: boolean): Promise<void> {
    if (conn.state === 'closed') return;
    if (isBinary) return this.protocolError(conn, 'expected a text frame');
    const parsed = parseAgentMessage(data);
    if (!parsed.ok) return this.protocolError(conn, parsed.error);
    const msg: AgentMessage = parsed.msg;
    conn.lastSeen = Date.now();

    if (conn.state === 'awaiting_hello') {
      if (msg.type !== 'hello') return this.protocolError(conn, `expected hello, got ${msg.type}`);
      if (msg.node !== conn.node.name)
        return this.protocolError(conn, 'hello.node does not match X-Node-Name');
      clearTimeout(conn.helloTimer);
      const now = new Date();
      const row = await this.repo.markOnline(
        conn.node.id,
        {
          agentVersion: msg.agentVersion,
          imageDigest: msg.imageDigest,
          maxProfiles: msg.maxProfiles,
          seats: msg.seats,
        },
        now,
      );
      conn.markedOnline = true;
      if ((conn.state as Conn['state']) === 'closed') return; // closed while writing; onClose's markOffline runs next
      conn.info = {
        name: row.name,
        nodeId: row.id,
        workspaceId: row.workspaceId,
        agentVersion: msg.agentVersion,
        imageDigest: msg.imageDigest,
        maxProfiles: msg.maxProfiles,
        seats: msg.seats,
        running: msg.running,
        connectedAt: now,
        lastSeenAt: now,
      };
      conn.ws.send(
        encodeGatewayMessage({
          type: 'welcome',
          serverTime: Date.now(),
          heartbeatSec: this.heartbeatSec,
          protocol: PROTOCOL_VERSION,
        }),
      );
      conn.state = 'ready';
      this.log.info(
        { node: row.name, agentVersion: msg.agentVersion, running: msg.running.length },
        'node online',
      );
      this.emitSafe('online', { ...conn.info });
      return;
    }

    switch (msg.type) {
      case 'hello':
        return this.protocolError(conn, 'duplicate hello');
      case 'heartbeat': {
        const now = new Date();
        await this.repo.recordHeartbeat(conn.node.id, msg.seats, now);
        if (conn.info) {
          conn.info.seats = msg.seats;
          conn.info.running = msg.running;
          conn.info.lastSeenAt = now;
          this.emitSafe('heartbeat', { ...conn.info });
        }
        return;
      }
      case 'ack': {
        const p = conn.pending.get(msg.cmdId);
        if (p) {
          clearTimeout(p.ackTimer);
          p.ackTimer = undefined;
        }
        return;
      }
      case 'result': {
        if (!conn.pending.has(msg.cmdId)) {
          // Late result after a timeout, or a replay nobody waits for: the retry will get it again.
          this.log.info(
            { node: conn.node.name, cmdId: msg.cmdId, outcome: msg.outcome },
            'result for no command',
          );
          return;
        }
        this.settle(conn, msg.cmdId, msg);
        return;
      }
      case 'event':
        this.emitSafe('event', {
          node: conn.node.name,
          nodeId: conn.node.id,
          workspaceId: conn.node.workspaceId,
          event: msg,
        });
        return;
    }
  }

  private settle(conn: Conn, cmdId: string, outcome: Result | Error) {
    const p = conn.pending.get(cmdId);
    if (!p) return;
    conn.pending.delete(cmdId);
    clearTimeout(p.ackTimer);
    clearTimeout(p.deadlineTimer);
    if (outcome instanceof Error) {
      this.log.warn({ node: conn.node.name, cmdId, err: outcome.message }, 'command failed');
      p.reject(outcome);
    } else {
      this.log.info({ node: conn.node.name, cmdId, outcome: outcome.outcome }, 'command result');
      p.resolve(outcome);
    }
  }

  private onClose(conn: Conn, code: number) {
    conn.state = 'closed';
    clearTimeout(conn.helloTimer);
    if (this.conns.get(conn.node.name) === conn) this.conns.delete(conn.node.name);
    const reason = conn.offlineReason ?? 'disconnected';
    for (const cmdId of [...conn.pending.keys()])
      this.settle(
        conn,
        cmdId,
        new NodeError('NodeDisconnected', conn.node.name, cmdId, `socket closed (${code})`),
      );
    this.log.info({ node: conn.node.name, code, reason }, 'agent disconnected');
    // After any in-flight markOnline, so the audit trail reads online → offline.
    conn.chain = conn.chain
      .then(async () => {
        if (!conn.markedOnline) return;
        await this.repo.markOffline(conn.node.id, reason);
        this.emitSafe('offline', {
          name: conn.node.name,
          nodeId: conn.node.id,
          workspaceId: conn.node.workspaceId,
          reason,
        });
      })
      .catch((e) => this.log.error({ node: conn.node.name, err: (e as Error).message }, 'markOffline failed'))
      .finally(() => conn.markDone());
  }

  /** Watchdog: a node silent for `offlineAfterMs` (three heartbeats) is dropped and marked offline. */
  private sweep() {
    const now = Date.now();
    for (const conn of this.conns.values()) {
      if (conn.state !== 'ready' || now - conn.lastSeen <= this.offlineAfterMs) continue;
      this.log.warn({ node: conn.node.name, silentMs: now - conn.lastSeen }, 'heartbeats missed');
      conn.offlineReason ??= 'heartbeat_timeout';
      conn.ws.terminate(); // the peer is unresponsive; no close handshake
    }
  }

  private emitSafe<K extends keyof HubEvents>(event: K, ...args: HubEvents[K]) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: EventEmitter's generic emit signature does not narrow here
      (this.emit as any)(event, ...args);
    } catch (e) {
      this.log.error({ event, err: (e as Error).message }, 'hub listener threw');
    }
  }
}

export function createHub(opts?: HubOptions): Hub {
  return new Hub(opts);
}
