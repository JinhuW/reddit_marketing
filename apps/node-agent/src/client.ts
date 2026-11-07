/**
 * Outbound connection to the node gateway (plan §3.4). Dials `GATEWAY_URL` with subprotocol `tl-node.v1`, a bearer
 * token and `X-Node-Name`; sends `hello`, waits for `welcome`, then heartbeats every `heartbeatSec`. Reconnects
 * forever with full-jitter exponential backoff between 1 s and 30 s, reset after each `welcome`.
 */
import {
  type AgentMessage,
  CloseCode,
  NODE_NAME_HEADER,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  encodeAgentMessage,
  parseGatewayMessage,
} from '@threadline/shared';
import WebSocket from 'ws';
import type { AgentConfig } from './config';
import type { Dispatcher } from './dispatch';
import type { Logger } from './log';
import type { AgentEvent } from './registry';
import type { StatusStore } from './status';

export interface Backoff {
  minMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { minMs: 1_000, maxMs: 30_000 };

/** Delay before reconnect attempt `attempt` (0-based): uniform in [min, min(max, min·2^attempt)]. */
export function backoffDelay(
  attempt: number,
  b: Backoff = DEFAULT_BACKOFF,
  rand: () => number = Math.random,
) {
  const cap = Math.min(b.maxMs, b.minMs * 2 ** Math.min(attempt, 30));
  return Math.round(b.minMs + rand() * (cap - b.minMs));
}

export interface ClientOptions {
  config: AgentConfig;
  log: Logger;
  dispatcher: Dispatcher;
  status: StatusStore;
  backoff?: Backoff;
  random?: () => number;
  /** Close and reconnect if no `welcome` arrives this long after the socket opens. */
  welcomeTimeoutMs?: number;
}

type State = 'idle' | 'connecting' | 'open' | 'ready' | 'stopped';

export class GatewayClient {
  private ws: WebSocket | null = null;
  private state: State = 'idle';
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private welcomeTimer: NodeJS.Timeout | undefined;
  private lastPongAt = 0;
  private readonly log: Logger;
  /** Number of `welcome`s received; tests and metrics read it. */
  connections = 0;
  lastClose: { code: number; reason: string } | null = null;

  constructor(private readonly opts: ClientOptions) {
    this.log = opts.log.child({ component: 'client' });
  }

  get ready(): boolean {
    return this.state === 'ready';
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.connect();
  }

  /** Send a frame on the current socket. Returns false (and drops the frame) while disconnected. */
  send = (msg: AgentMessage): boolean => {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.log.debug({ type: msg.type }, 'not connected; frame dropped');
      return false;
    }
    ws.send(encodeAgentMessage(msg));
    return true;
  };

  sendEvent(event: AgentEvent): boolean {
    return this.send({ type: 'event', ...event });
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    clearTimeout(this.reconnectTimer);
    this.clearConnTimers();
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 2_000);
      ws.once('close', () => {
        clearTimeout(force);
        resolve();
      });
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close(1000, 'agent shutting down');
    });
  }

  private connect(): void {
    const { config } = this.opts;
    this.state = 'connecting';
    this.log.info({ url: config.gatewayUrl, attempt: this.attempt }, 'dialing gateway');
    const ws = new WebSocket(config.gatewayUrl, SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${config.nodeToken}`, [NODE_NAME_HEADER]: config.nodeName },
      handshakeTimeout: 10_000,
    });
    this.ws = ws;

    ws.on('open', () => {
      if (ws.protocol !== SUBPROTOCOL) {
        this.log.error({ protocol: ws.protocol }, 'gateway did not accept the subprotocol');
        ws.close(CloseCode.protocolError, 'subprotocol');
        return;
      }
      this.state = 'open';
      this.lastPongAt = Date.now();
      this.send({
        type: 'hello',
        node: config.nodeName,
        agentVersion: config.agentVersion,
        imageDigest: this.opts.status.imageDigest(),
        maxProfiles: config.maxProfiles,
        seats: this.opts.status.seats(),
        running: this.opts.status.running(),
      });
      this.welcomeTimer = setTimeout(() => {
        this.log.warn('no welcome from gateway; reconnecting');
        ws.close(CloseCode.protocolError, 'no welcome');
      }, this.opts.welcomeTimeoutMs ?? 10_000);
    });

    ws.on('pong', () => {
      this.lastPongAt = Date.now();
    });

    ws.on('message', (data, isBinary) => {
      if (ws !== this.ws) return;
      if (isBinary) {
        ws.close(CloseCode.protocolError, 'binary frame');
        return;
      }
      const parsed = parseGatewayMessage(data);
      if (!parsed.ok) {
        this.log.error({ error: parsed.error }, 'invalid frame from gateway');
        ws.close(parsed.closeCode, 'protocol error');
        return;
      }
      const msg = parsed.msg;
      if (msg.type === 'welcome') {
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.log.error({ protocol: msg.protocol }, 'gateway speaks another protocol version');
          ws.close(CloseCode.protocolVersion, 'protocol version');
          return;
        }
        clearTimeout(this.welcomeTimer);
        this.state = 'ready';
        this.attempt = 0;
        this.connections++;
        this.startHeartbeat(ws, msg.heartbeatSec);
        this.log.info({ heartbeatSec: msg.heartbeatSec }, 'connected to gateway');
        return;
      }
      void this.opts.dispatcher.handle(msg, this.send).catch((err) => {
        this.log.error({ err, cmdId: msg.cmdId }, 'dispatch failed');
      });
    });

    ws.on('unexpected-response', (_req, res) => {
      // The gateway refused the upgrade with plain HTTP (e.g. 401). Log the status only.
      this.log.error({ status: res.statusCode }, 'gateway refused the websocket upgrade');
      ws.terminate();
    });

    ws.on('error', (err) => {
      this.log.warn({ err }, 'gateway socket error');
    });

    ws.on('close', (code, reasonBuf) => {
      if (ws !== this.ws) return;
      this.clearConnTimers();
      this.ws = null;
      const reason = reasonBuf.toString();
      this.lastClose = { code, reason };
      if (code === CloseCode.badToken) this.log.error('gateway rejected the node token (4401)');
      else if (code === CloseCode.duplicateNode)
        this.log.error('another agent is connected with this node name (4409)');
      else if (code === CloseCode.protocolVersion) this.log.error('protocol version mismatch (4426)');
      else this.log.warn({ code, reason }, 'gateway connection closed');
      if (this.state === 'stopped') return;
      this.scheduleReconnect();
    });
  }

  private startHeartbeat(ws: WebSocket, heartbeatSec: number): void {
    clearInterval(this.heartbeatTimer);
    const everyMs = heartbeatSec * 1000;
    this.heartbeatTimer = setInterval(() => {
      // Half-open TCP: no pong for three intervals means the gateway is gone even if the socket says open.
      if (Date.now() - this.lastPongAt > everyMs * 3) {
        this.log.warn('gateway stopped answering pings; reconnecting');
        ws.terminate();
        return;
      }
      this.send({
        type: 'heartbeat',
        ts: Date.now(),
        running: this.opts.status.running(),
        seats: this.opts.status.seats(),
      });
      ws.ping();
    }, everyMs);
  }

  private clearConnTimers(): void {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.welcomeTimer);
  }

  private scheduleReconnect(): void {
    this.state = 'idle';
    const delay = backoffDelay(this.attempt, this.opts.backoff, this.opts.random);
    this.attempt++;
    this.log.info({ delayMs: delay }, 'reconnecting');
    this.reconnectTimer = setTimeout(() => {
      if (this.state === 'stopped') return;
      this.connect();
    }, delay);
  }
}
