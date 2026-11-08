/**
 * FakeAgent: a scripted browser-node agent for gateway tests (plan §3.4).
 *
 * It dials a gateway with the real handshake (subprotocol, bearer token, node-name header, `hello`), waits
 * for `welcome`, acks every command and answers with a scripted result per `Cmd.kind`. It honours the
 * result-replay contract: a `cmdId` it has already finished is answered from its cache (last
 * RESULT_CACHE_SIZE) without running the script again, also across reconnects of the same instance.
 *
 * Cues for failure tests: a script step can drop the socket before/after the ack or after running (result
 * cached but never sent), stay silent (deadline tests), or be delayed. `drop()` drops the socket at any time.
 */
import {
  AGENT_PATH,
  type AgentMessage,
  type BrowserOutcome,
  CloseCode,
  type Cmd,
  type CmdKind,
  type CmdOf,
  type Command,
  type NodeEventKind,
  PROTOCOL_VERSION,
  type ProfileRef,
  RESULT_CACHE_SIZE,
  type Result,
  type ResultError,
  SUBPROTOCOL,
  type Seats,
  type Welcome,
  encodeAgentMessage,
  parseGatewayMessage,
} from '@threadline/shared';
import { WebSocket } from 'ws';
import { Recorder, delay } from './wait';

/** What a scripted command answers with. */
export interface ScriptedResult {
  outcome: BrowserOutcome;
  data?: unknown;
  error?: ResultError;
}

/** Special behaviours a script step can ask for instead of (or before) a result. */
export type Cue =
  /**
   * Drop the TCP connection (gateway sees 1006). `afterRun` runs the command (caching `result`, default
   * `{ outcome: 'ok' }`) but drops before sending it, so a retry with the same cmdId is answered by replay.
   * A script function's `beforeAck` is treated as `afterAck`, since functions run after the ack.
   */
  | { drop: 'beforeAck' | 'afterAck' | 'afterRun'; result?: ScriptedResult }
  /** Ack, then never answer (deadline tests). */
  | { silent: true }
  /** Wait, then answer with `result`. */
  | { delayMs: number; result: ScriptedResult };

export type Step<K extends CmdKind = CmdKind> =
  | ScriptedResult
  | Cue
  | ((cmd: CmdOf<K>, command: Command) => ScriptedResult | Cue | Promise<ScriptedResult | Cue>);

export type Script = { [K in CmdKind]?: Step<K> };

/** Kind-erased step, used internally once the kind is known to match. */
type AnyStep =
  | ScriptedResult
  | Cue
  | ((cmd: Cmd, command: Command) => ScriptedResult | Cue | Promise<ScriptedResult | Cue>);

export interface FakeAgentOptions {
  /** Gateway URL. A bare origin (`ws://host:port`) gets `/agent` appended. */
  url: string;
  node: string;
  token: string;
  agentVersion?: string;
  imageDigest?: string | null;
  maxProfiles?: number;
  seats?: Seats;
  running?: ProfileRef[];
  /** Per-kind results; kinds not listed answer `{ outcome: 'ok' }`. */
  script?: Script;
  /** Send `ack` for each command (default true). */
  ack?: boolean;
  /** Heartbeat interval: `true` (default) uses the welcome's `heartbeatSec`; a number is ms; false disables. */
  heartbeat?: boolean | number;
  /** Offer this subprotocol instead of `tl-node.v1` (null offers none). */
  subprotocol?: string | null;
}

/** The gateway closed the socket before `welcome` (e.g. 4401 bad token, 4409 duplicate). */
export class AgentClosedError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(`gateway closed the agent socket: ${code}${reason ? ` ${reason}` : ''}`);
    this.name = 'AgentClosedError';
  }
}

function isCue(x: ScriptedResult | Cue): x is Cue {
  return 'drop' in x || 'silent' in x || 'delayMs' in x;
}

export class FakeAgent {
  /** Every command received, including ones answered from the replay cache. */
  readonly commands = new Recorder<Command>();
  /** Every `result` frame sent. */
  readonly results = new Recorder<Result>();
  /** cmdIds answered from the replay cache. */
  readonly replays = new Recorder<string>();
  /** Every close of this agent's socket, with the code it saw. */
  readonly closes = new Recorder<{ code: number; reason: string }>();
  /** Welcome frames received (one per successful connect). */
  readonly welcomes = new Recorder<Welcome>();

  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly cache = new Map<string, Result>();
  private readonly once = new Map<CmdKind, AnyStep[]>();
  private script: Script;
  private running: ProfileRef[];
  private seats: Seats;

  constructor(readonly opts: FakeAgentOptions) {
    this.script = { ...opts.script };
    this.running = opts.running ?? [];
    this.seats = opts.seats ?? { inUse: 0, limit: null };
  }

  get node(): string {
    return this.opts.node;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Set the standing step for a kind. */
  setScript<K extends CmdKind>(kind: K, step: Step<K>): void {
    (this.script as Record<CmdKind, unknown>)[kind] = step;
  }

  /** Queue a one-shot step for the next command of `kind` (takes precedence over the standing script). */
  next<K extends CmdKind>(kind: K, step: Step<K>): void {
    const q = this.once.get(kind) ?? [];
    q.push(step as unknown as AnyStep);
    this.once.set(kind, q);
  }

  /** Shorthand: drop the socket on the next command of `kind`. */
  dropOn(
    kind: CmdKind,
    when: 'beforeAck' | 'afterAck' | 'afterRun' = 'afterAck',
    result?: ScriptedResult,
  ): void {
    this.next(kind, result ? { drop: when, result } : { drop: when });
  }

  setRunning(running: ProfileRef[]): void {
    this.running = running;
  }

  setSeats(seats: Seats): void {
    this.seats = seats;
  }

  /** Connect and complete hello/welcome. Rejects with AgentClosedError if the gateway refuses. */
  connect(opts: { timeoutMs?: number } = {}): Promise<Welcome> {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      return Promise.reject(new Error('testkit: FakeAgent is already connected'));
    }
    const url = new URL(this.opts.url);
    if (url.pathname === '/' || url.pathname === '') url.pathname = AGENT_PATH;
    const protocols = this.opts.subprotocol === null ? [] : [this.opts.subprotocol ?? SUBPROTOCOL];
    const ws = new WebSocket(url, protocols, {
      headers: { Authorization: `Bearer ${this.opts.token}`, 'X-Node-Name': this.opts.node },
      handshakeTimeout: opts.timeoutMs ?? 5_000,
    });
    this.ws = ws;
    return new Promise<Welcome>((resolve, reject) => {
      let welcomed = false;
      const timer = setTimeout(() => {
        if (!welcomed) {
          ws.terminate();
          reject(new Error('testkit: no welcome from gateway'));
        }
      }, opts.timeoutMs ?? 5_000);

      ws.on('open', () => {
        this.sendFrame({
          type: 'hello',
          node: this.opts.node,
          agentVersion: this.opts.agentVersion ?? '0.0.0-testkit',
          imageDigest: this.opts.imageDigest ?? null,
          maxProfiles: this.opts.maxProfiles ?? 8,
          seats: this.seats,
          running: this.running,
        });
      });
      ws.on('error', (err) => {
        if (!welcomed) {
          clearTimeout(timer);
          reject(err);
        }
      });
      ws.on('close', (code, reason) => {
        this.stopHeartbeat();
        this.closes.push({ code, reason: reason.toString() });
        if (!welcomed) {
          clearTimeout(timer);
          reject(new AgentClosedError(code, reason.toString()));
        }
      });
      ws.on('message', (raw, isBinary) => {
        const parsed = isBinary
          ? ({ ok: false, closeCode: CloseCode.protocolError, error: 'binary frame' } as const)
          : parseGatewayMessage(raw);
        if (!parsed.ok) {
          ws.close(parsed.closeCode, 'protocol error');
          return;
        }
        const msg = parsed.msg;
        if (msg.type === 'welcome') {
          if (welcomed) return;
          if (msg.protocol !== PROTOCOL_VERSION) {
            ws.close(CloseCode.protocolVersion, 'protocol version');
            return;
          }
          welcomed = true;
          clearTimeout(timer);
          this.welcomes.push(msg);
          this.startHeartbeat(msg.heartbeatSec);
          resolve(msg);
          return;
        }
        if (!welcomed) {
          ws.close(CloseCode.protocolError, 'command before welcome');
          return;
        }
        void this.onCommand(ws, msg);
      });
    });
  }

  /** Wait for a command (past or future), optionally of one kind. */
  waitForCommand(kind?: CmdKind, opts: { timeoutMs?: number; from?: number } = {}): Promise<Command> {
    return this.commands.waitFor((c) => kind === undefined || c.cmd.kind === kind, {
      ...opts,
      what: `command ${kind ?? '(any)'}`,
    });
  }

  /** Wait for the next close of the socket. */
  waitForClose(opts: { timeoutMs?: number } = {}): Promise<{ code: number; reason: string }> {
    return this.closes.waitFor(() => true, { ...opts, from: this.closes.items.length, what: 'socket close' });
  }

  sendHeartbeat(): void {
    this.sendFrame({ type: 'heartbeat', ts: Date.now(), running: this.running, seats: this.seats });
  }

  sendEvent(profileId: string, kind: NodeEventKind, detail?: unknown): void {
    this.sendFrame({ type: 'event', profileId, kind, ...(detail === undefined ? {} : { detail }) });
  }

  /** Put any text on the wire, bypassing validation (for the gateway's 4400 path). */
  sendRaw(text: string): void {
    this.mustSocket().send(text);
  }

  /** Drop the TCP connection without a close frame. */
  drop(): void {
    this.stopHeartbeat();
    this.ws?.terminate();
  }

  /** Close cleanly and wait for the close to complete. */
  async close(code = 1000, reason = ''): Promise<void> {
    this.stopHeartbeat();
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    const done = new Promise<void>((r) => ws.once('close', () => r()));
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws.close(code, reason);
    await done;
  }

  // ── internals ──

  private mustSocket(): WebSocket {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      throw new Error('testkit: FakeAgent is not connected');
    return this.ws;
  }

  private sendFrame(m: AgentMessage, ws: WebSocket | null = this.ws): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(encodeAgentMessage(m));
    return true;
  }

  private startHeartbeat(heartbeatSec: number): void {
    this.stopHeartbeat();
    const setting = this.opts.heartbeat ?? true;
    if (setting === false) return;
    const ms = setting === true ? heartbeatSec * 1000 : setting;
    this.heartbeatTimer = setInterval(() => {
      if (this.connected) this.sendHeartbeat();
    }, ms);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private takeStep(kind: CmdKind): AnyStep {
    const one = this.once.get(kind)?.shift();
    if (one) return one;
    return (this.script[kind] as unknown as AnyStep | undefined) ?? { outcome: 'ok' };
  }

  private remember(result: Result): void {
    this.cache.delete(result.cmdId);
    this.cache.set(result.cmdId, result);
    while (this.cache.size > RESULT_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async onCommand(ws: WebSocket, command: Command): Promise<void> {
    this.commands.push(command);
    const ack = () => {
      if (this.opts.ack ?? true) this.sendFrame({ type: 'ack', cmdId: command.cmdId }, ws);
    };

    const cached = this.cache.get(command.cmdId);
    if (cached) {
      ack();
      this.replays.push(command.cmdId);
      if (this.sendFrame(cached, ws)) this.results.push(cached);
      return;
    }

    const step = this.takeStep(command.cmd.kind);
    let answer: ScriptedResult | Cue;
    if (typeof step === 'function') {
      ack();
      try {
        answer = await step(command.cmd, command);
      } catch (err) {
        answer = {
          outcome: 'error',
          error: { code: 'script_error', message: err instanceof Error ? err.message : String(err) },
        };
      }
    } else {
      if ('drop' in step && step.drop === 'beforeAck') {
        ws.terminate();
        return;
      }
      ack();
      answer = step;
    }

    if (isCue(answer)) {
      if ('silent' in answer) return;
      if ('drop' in answer) {
        if (answer.drop === 'afterRun') {
          // The work "happened" (e.g. the comment was posted) but the result never reached the gateway.
          this.remember(this.toResult(command.cmdId, answer.result ?? { outcome: 'ok' }));
        }
        ws.terminate();
        return;
      }
      await delay(answer.delayMs);
      answer = answer.result;
    }

    const result = this.toResult(command.cmdId, answer);
    this.remember(result);
    if (this.sendFrame(result, ws)) this.results.push(result);
  }

  private toResult(cmdId: string, r: ScriptedResult): Result {
    return {
      type: 'result',
      cmdId,
      outcome: r.outcome,
      ...(r.data === undefined ? {} : { data: r.data }),
      ...(r.error === undefined ? {} : { error: r.error }),
    };
  }
}
