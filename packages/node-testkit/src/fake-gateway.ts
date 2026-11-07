/**
 * FakeGateway: a minimal stand-in for the node gateway (plan §3.4) for node-agent tests.
 *
 * It accepts agents on `/agent` with the `tl-node.v1` subprotocol, checks the bearer token and node name,
 * expects `hello`, answers `welcome`, then lets the test send commands and records everything the agent
 * says. Every frame in both directions goes through the shared zod schemas, so a fake that passes here
 * speaks the same wire format as the real hub.
 *
 * It is deliberately simpler than the real hub: no database, no heartbeat-based offline marking.
 */
import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AGENT_PATH,
  type AgentMessage,
  CloseCode,
  type Cmd,
  type Command,
  HEARTBEAT_SEC,
  type Hello,
  NODE_NAME_HEADER,
  NodeName,
  PROTOCOL_VERSION,
  type Result,
  SUBPROTOCOL,
  type Welcome,
  encodeGatewayMessage,
  parseAgentMessage,
} from '@threadline/shared';
import { type WebSocket, WebSocketServer } from 'ws';
import { Recorder } from './wait';

export interface FakeGatewayOptions {
  /** Port to listen on; 0 (default) picks a free one. */
  port?: number;
  host?: string;
  /**
   * Accepted tokens by node name. When omitted, any non-empty bearer token is accepted for any valid name.
   */
  tokens?: Record<string, string>;
  /** Fields to override in the `welcome` frame (e.g. `protocol: 2` to test the agent's 4426 path). */
  welcome?: Partial<Omit<Welcome, 'type'>>;
  /** Default `deadlineMs` for `send`. */
  deadlineMs?: number;
}

export interface AgentConnection {
  node: string;
  hello: Hello;
  socket: WebSocket;
  connectedAt: number;
  /** Resolves when the socket closes (code 1006 when the agent dropped it without a close frame). */
  closed: Promise<{ code: number; reason: string }>;
}

export interface ReceivedFrame {
  node: string;
  msg: AgentMessage;
  at: number;
}

export interface RejectedConnection {
  /** Node name from the header, if one was sent. */
  node: string | null;
  code: number;
  reason: string;
}

export type GatewayErrorCode = 'NodeTimeout' | 'NodeDisconnected';

/** Mirrors how the real gateway fails a job: both codes are retryable. */
export class FakeGatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    readonly cmdId: string,
  ) {
    super(`${code} for ${cmdId}`);
    this.name = 'FakeGatewayError';
  }
}

interface Pending {
  node: string;
  resolve: (r: Result) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class FakeGateway {
  /** Every valid frame from every agent, in arrival order. */
  readonly received = new Recorder<ReceivedFrame>();
  /** Connections that completed hello/welcome. */
  readonly connections = new Recorder<AgentConnection>();
  /** Connections closed by the gateway during the handshake or for a protocol error. */
  readonly rejected = new Recorder<RejectedConnection>();
  /** Commands sent, in order. */
  readonly sent = new Recorder<{ node: string; command: Command; at: number }>();

  private readonly live = new Map<string, AgentConnection>();
  private readonly pending = new Map<string, Pending>();
  private rejectNextWith: { code: number; reason: string } | null = null;
  private seq = 0;

  private constructor(
    private readonly http: Server,
    private readonly wss: WebSocketServer,
    private readonly opts: FakeGatewayOptions,
    readonly url: string,
  ) {}

  static async start(opts: FakeGatewayOptions = {}): Promise<FakeGateway> {
    const http = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });
    const host = opts.host ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(opts.port ?? 0, host, () => resolve());
    });
    const { port } = http.address() as AddressInfo;
    const gw = new FakeGateway(http, wss, opts, `ws://${host}:${port}`);
    http.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path !== AGENT_PATH) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => gw.onConnection(ws, req));
    });
    return gw;
  }

  /** URL for an agent to dial: `ws://127.0.0.1:<port>/agent`. */
  get agentUrl(): string {
    return `${this.url}${AGENT_PATH}`;
  }

  isConnected(node: string): boolean {
    return this.live.has(node);
  }

  /** Number of completed handshakes so far for `node` (counts reconnects). */
  connectCount(node: string): number {
    return this.connections.items.filter((c) => c.node === node).length;
  }

  /** Wait for an agent's hello/welcome to complete. Pass `from` to wait for a reconnect. */
  waitForAgent(node?: string, opts: { timeoutMs?: number; from?: number } = {}): Promise<AgentConnection> {
    return this.connections.waitFor((c) => node === undefined || c.node === node, {
      ...opts,
      what: `agent ${node ?? '(any)'} to connect`,
    });
  }

  /** Wait for a frame of `type` from `node`. */
  waitForFrame<T extends AgentMessage['type']>(
    node: string,
    type: T,
    opts: {
      timeoutMs?: number;
      from?: number;
      match?: (m: Extract<AgentMessage, { type: T }>) => boolean;
    } = {},
  ): Promise<Extract<AgentMessage, { type: T }>> {
    return this.received
      .waitFor(
        (f) =>
          f.node === node &&
          f.msg.type === type &&
          (!opts.match || opts.match(f.msg as Extract<AgentMessage, { type: T }>)),
        { timeoutMs: opts.timeoutMs, from: opts.from, what: `${type} from ${node}` },
      )
      .then((f) => f.msg as Extract<AgentMessage, { type: T }>);
  }

  /** Frames of `type` received from `node` so far. */
  frames<T extends AgentMessage['type']>(node: string, type: T): Extract<AgentMessage, { type: T }>[] {
    return this.received.items
      .filter((f) => f.node === node && f.msg.type === type)
      .map((f) => f.msg as Extract<AgentMessage, { type: T }>);
  }

  /** Close the next incoming connection right after the upgrade with this code (e.g. 4401). */
  rejectNext(code: number, reason = ''): void {
    this.rejectNextWith = { code, reason };
  }

  /**
   * Send a command and resolve with the agent's `result`. Rejects with `FakeGatewayError('NodeTimeout')`
   * after `deadlineMs`, or `FakeGatewayError('NodeDisconnected')` if the socket closes first (or the node
   * is not connected). Reuse a `cmdId` to test the agent's result replay.
   */
  send(node: string, cmd: Cmd, opts: { cmdId?: string; deadlineMs?: number } = {}): Promise<Result> {
    this.seq += 1;
    const cmdId = opts.cmdId ?? `bj-${cmd.kind}-${this.seq}`;
    const deadlineMs = opts.deadlineMs ?? this.opts.deadlineMs ?? 30_000;
    const conn = this.live.get(node);
    if (!conn) return Promise.reject(new FakeGatewayError('NodeDisconnected', cmdId));
    if (this.pending.has(cmdId)) return Promise.reject(new Error(`testkit: ${cmdId} is already in flight`));
    const command: Command = { type: 'command', cmdId, deadlineMs, cmd };
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        reject(new FakeGatewayError('NodeTimeout', cmdId));
      }, deadlineMs);
      this.pending.set(cmdId, { node, resolve, reject, timer });
      conn.socket.send(encodeGatewayMessage(command));
      this.sent.push({ node, command, at: Date.now() });
    });
  }

  /** Put any text on the wire to `node`, bypassing validation (for protocol-error tests). */
  sendRaw(node: string, text: string): void {
    this.mustGet(node).socket.send(text);
  }

  /** Close `node`'s socket with a close frame. */
  disconnect(node: string, code = 1000, reason = ''): void {
    this.mustGet(node).socket.close(code, reason);
  }

  /** Drop `node`'s TCP connection without a close frame (the agent sees 1006). */
  terminate(node: string): void {
    this.mustGet(node).socket.terminate();
  }

  async close(): Promise<void> {
    for (const c of this.live.values()) c.socket.terminate();
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // ── internals ──

  private mustGet(node: string): AgentConnection {
    const c = this.live.get(node);
    if (!c) throw new Error(`testkit: node ${node} is not connected`);
    return c;
  }

  private reject(ws: WebSocket, node: string | null, code: number, reason: string): void {
    this.rejected.push({ node, code, reason });
    ws.close(code, reason);
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const nameHeader = req.headers[NODE_NAME_HEADER];
    const node = typeof nameHeader === 'string' ? nameHeader : null;
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';

    if (this.rejectNextWith) {
      const { code, reason } = this.rejectNextWith;
      this.rejectNextWith = null;
      this.reject(ws, node, code, reason);
      return;
    }
    if (ws.protocol !== SUBPROTOCOL) {
      this.reject(ws, node, CloseCode.protocolVersion, 'unsupported subprotocol');
      return;
    }
    if (!node || !NodeName.safeParse(node).success || !token) {
      this.reject(ws, node, CloseCode.badToken, 'bad token');
      return;
    }
    const expected = this.opts.tokens?.[node];
    if (this.opts.tokens && expected !== token) {
      this.reject(ws, node, CloseCode.badToken, 'bad token');
      return;
    }
    if (this.live.has(node)) {
      this.reject(ws, node, CloseCode.duplicateNode, 'node already connected');
      return;
    }

    let conn: AgentConnection | null = null;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => {
        if (conn && this.live.get(node) === conn) {
          this.live.delete(node);
          for (const [cmdId, p] of this.pending) {
            if (p.node !== node) continue;
            clearTimeout(p.timer);
            this.pending.delete(cmdId);
            p.reject(new FakeGatewayError('NodeDisconnected', cmdId));
          }
        }
        resolve({ code, reason: reason.toString() });
      });
    });

    ws.on('message', (raw, isBinary) => {
      const parsed = isBinary
        ? ({ ok: false, closeCode: CloseCode.protocolError, error: 'binary frame' } as const)
        : parseAgentMessage(raw);
      if (!parsed.ok) {
        this.reject(ws, node, parsed.closeCode, parsed.error.slice(0, 120));
        return;
      }
      const msg = parsed.msg;
      if (!conn) {
        if (msg.type !== 'hello' || msg.node !== node) {
          this.reject(ws, node, CloseCode.protocolError, 'expected hello');
          return;
        }
        // A second socket may have completed its hello while this one waited.
        if (this.live.has(node)) {
          this.reject(ws, node, CloseCode.duplicateNode, 'node already connected');
          return;
        }
        conn = { node, hello: msg, socket: ws, connectedAt: Date.now(), closed };
        this.live.set(node, conn);
        this.received.push({ node, msg, at: Date.now() });
        ws.send(
          encodeGatewayMessage({
            type: 'welcome',
            serverTime: Date.now(),
            heartbeatSec: HEARTBEAT_SEC,
            protocol: PROTOCOL_VERSION,
            ...this.opts.welcome,
          }),
        );
        this.connections.push(conn);
        return;
      }
      if (msg.type === 'hello') {
        this.reject(ws, node, CloseCode.protocolError, 'duplicate hello');
        return;
      }
      this.received.push({ node, msg, at: Date.now() });
      if (msg.type === 'result') {
        const p = this.pending.get(msg.cmdId);
        if (p && p.node === node) {
          clearTimeout(p.timer);
          this.pending.delete(msg.cmdId);
          p.resolve(msg);
        }
      }
    });
  }
}
