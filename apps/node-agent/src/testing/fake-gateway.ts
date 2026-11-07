/**
 * Minimal local gateway for agent tests, until `@threadline/node-testkit`'s FakeGateway (T14) is merged.
 * Accepts `tl-node.v1` sockets, records every parsed frame and the upgrade headers, and lets a test send
 * welcome/command frames or drop the socket.
 */
import type { AddressInfo } from 'node:net';
import {
  type AgentMessage,
  type Command,
  type GatewayMessage,
  HEARTBEAT_SEC,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  parseAgentMessage,
} from '@threadline/shared';
import { type WebSocket, WebSocketServer } from 'ws';

export interface Conn {
  ws: WebSocket;
  headers: Record<string, string | string[] | undefined>;
  protocol: string;
  frames: AgentMessage[];
  closed: Promise<{ code: number; reason: string }>;
}

export interface FakeGatewayOptions {
  /** Send `welcome` automatically after `hello`. */
  autoWelcome?: boolean;
  heartbeatSec?: number;
  protocol?: number;
}

export class FakeGateway {
  readonly conns: Conn[] = [];
  private readonly wss: WebSocketServer;
  private waiters: Array<() => void> = [];

  private constructor(
    wss: WebSocketServer,
    private readonly opts: FakeGatewayOptions,
  ) {
    this.wss = wss;
    wss.on('connection', (ws, req) => {
      const conn: Conn = {
        ws,
        headers: req.headers,
        protocol: ws.protocol,
        frames: [],
        closed: new Promise((resolve) =>
          ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
        ),
      };
      this.conns.push(conn);
      ws.on('message', (data) => {
        const parsed = parseAgentMessage(data);
        if (!parsed.ok) throw new Error(`agent sent an invalid frame: ${parsed.error}`);
        conn.frames.push(parsed.msg);
        if (parsed.msg.type === 'hello' && this.opts.autoWelcome !== false) {
          this.send(conn, {
            type: 'welcome',
            serverTime: Date.now(),
            heartbeatSec: this.opts.heartbeatSec ?? HEARTBEAT_SEC,
            protocol: this.opts.protocol ?? PROTOCOL_VERSION,
          });
        }
        this.notify();
      });
      this.notify();
    });
  }

  static async start(opts: FakeGatewayOptions = {}): Promise<FakeGateway> {
    const wss = new WebSocketServer({
      port: 0,
      path: '/agent',
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    return new FakeGateway(wss, opts);
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}/agent`;
  }

  get last(): Conn {
    const c = this.conns.at(-1);
    if (!c) throw new Error('no connection yet');
    return c;
  }

  send(conn: Conn, msg: GatewayMessage | Record<string, unknown>): void {
    conn.ws.send(JSON.stringify(msg));
  }

  command(conn: Conn, cmdId: string, cmd: Command['cmd'], deadlineMs = 5_000): void {
    this.send(conn, { type: 'command', cmdId, deadlineMs, cmd });
  }

  /** Resolve once `pred` holds, re-checked after every connection and frame. */
  async waitFor<T>(pred: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = pred();
      if (v) return v;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('FakeGateway.waitFor timed out');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 50));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  frames<T extends AgentMessage['type']>(conn: Conn, type: T): Extract<AgentMessage, { type: T }>[] {
    return conn.frames.filter((f): f is Extract<AgentMessage, { type: T }> => f.type === type);
  }

  /** Every frame of `type` across all connections. */
  allFrames<T extends AgentMessage['type']>(type: T): Extract<AgentMessage, { type: T }>[] {
    return this.conns.flatMap((c) => this.frames(c, type));
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private notify(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
}
