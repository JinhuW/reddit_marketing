/**
 * Command dispatch (plan §3.4): ack at once, run the handler for `cmd.kind`, send exactly one result before the
 * deadline, and remember results so a retried `cmdId` is replayed instead of re-run.
 *
 * Replay rules:
 * - A `cmdId` that is still running is never started twice: a repeat (e.g. after a reconnect) waits for the run
 *   in progress and gets its result.
 * - Results are kept for the last {@link RESULT_CACHE_SIZE} `cmdId`s. Everything an `action.*` handler returns is
 *   kept, errors included: those commands post to Reddit and must never run twice for one job.
 *   Other kinds keep only non-error outcomes, so a BullMQ retry of a failed `profile.start` really retries.
 * - Reads that must be fresh ({@link uncached}: `profile.whoami`, `profile.signIn`) are never kept. Their cmdId
 *   may be fixed per profile (`bj-profile.whoami-<profileId>`), so a stored `loggedIn: false` would otherwise
 *   answer every later "I'm signed in" / "Sign in now" press.
 * - At the deadline the gateway gets a synthetic `error` (`deadline_exceeded`) and the handler's signal is
 *   aborted. That synthetic result is not cached; when the handler settles, its real result is cached, so a retry
 *   of a slow post replays `posted` rather than posting again.
 */
import {
  type AgentMessage,
  type CmdKind,
  type Command,
  RESULT_CACHE_SIZE,
  type Result,
} from '@threadline/shared';
import type { AgentConfig } from './config';
import type { Logger, SecretSet } from './log';
import type { Handler, HandlerMap, HandlerResult } from './registry';
import type { StatusStore } from './status';

export type Send = (msg: AgentMessage) => boolean;

export interface DispatcherOptions {
  handlers: HandlerMap;
  log: Logger;
  secrets: SecretSet;
  config: AgentConfig;
  status: StatusStore;
  cacheSize?: number;
  now?: () => number;
}

/** How much earlier than `deadlineMs` the agent reports, so the result reaches the gateway in time. */
export function guardMs(deadlineMs: number): number {
  return deadlineMs > 2_000 ? deadlineMs - 500 : Math.max(1, Math.floor(deadlineMs * 0.75));
}

const posts = (kind: CmdKind) => kind === 'action.submitComment' || kind === 'action.sendDm';
/** Kinds whose result is never stored: reads that are cheap to repeat and stale once returned. */
const uncached = (kind: CmdKind) => kind === 'profile.whoami' || kind === 'profile.signIn';

export class Dispatcher {
  private readonly cache = new Map<string, Result>();
  private readonly inflight = new Map<string, Promise<Result>>();
  private readonly cacheSize: number;
  private readonly now: () => number;

  constructor(private readonly opts: DispatcherOptions) {
    this.cacheSize = opts.cacheSize ?? RESULT_CACHE_SIZE;
    this.now = opts.now ?? Date.now;
  }

  /** Number of commands currently running. */
  get running(): number {
    return this.inflight.size;
  }

  cached(cmdId: string): Result | undefined {
    return this.cache.get(cmdId);
  }

  /**
   * Handle one `command` frame. `send` must write to whatever socket is current when it is called, so a result
   * that completes after a reconnect goes out on the new connection.
   */
  async handle(command: Command, send: Send): Promise<void> {
    const { cmdId, cmd, deadlineMs } = command;
    const log = this.opts.log.child({ cmdId, kind: cmd.kind });
    send({ type: 'ack', cmdId });

    const hit = this.cache.get(cmdId);
    if (hit) {
      log.info('replaying stored result');
      send(hit);
      return;
    }

    const running = this.inflight.get(cmdId);
    if (running) {
      log.info('command already running; waiting for its result');
      send(await running);
      return;
    }

    this.learnSecrets(command);
    const ac = new AbortController();
    const run = this.run(command, ac.signal, log);
    this.inflight.set(cmdId, run);

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), guardMs(deadlineMs));
    });
    const first = await Promise.race([run, deadline]);
    clearTimeout(timer);

    if (first === 'deadline') {
      log.warn({ deadlineMs }, 'deadline reached before the handler finished');
      ac.abort(new Error('deadline exceeded'));
      send({
        type: 'result',
        cmdId,
        outcome: 'error',
        error: { code: 'deadline_exceeded', message: `no result within ${deadlineMs} ms` },
      });
      void run.then((late) => log.info({ outcome: late.outcome }, 'handler finished after its deadline'));
      return;
    }
    send(first);
  }

  private async run(command: Command, signal: AbortSignal, log: Logger): Promise<Result> {
    const { cmdId, cmd, deadlineMs } = command;
    const handler = this.opts.handlers[cmd.kind] as Handler<typeof cmd.kind> | undefined;
    let out: HandlerResult;
    if (!handler) {
      out = { outcome: 'error', error: { code: 'no_handler', message: `no handler for ${cmd.kind}` } };
    } else {
      try {
        out = await handler(cmd as never, {
          cmdId,
          signal,
          deadlineAt: this.now() + deadlineMs,
          log,
          config: this.opts.config,
          status: this.opts.status,
          secrets: this.opts.secrets,
        });
      } catch (err) {
        log.error({ err }, 'handler threw');
        out = {
          outcome: 'error',
          error: { code: 'handler_error', message: err instanceof Error ? err.message : String(err) },
        };
      }
    }
    const result = this.toResult(cmdId, out);
    this.inflight.delete(cmdId);
    if (!uncached(cmd.kind) && (result.outcome !== 'error' || posts(cmd.kind))) this.remember(result);
    log.info({ outcome: result.outcome, code: result.error?.code }, 'command finished');
    return result;
  }

  private toResult(cmdId: string, out: HandlerResult): Result {
    const s = this.opts.secrets;
    const result: Result = { type: 'result', cmdId, outcome: out.outcome };
    if (out.data !== undefined) result.data = s.scrubDeep(out.data);
    if (out.error) result.error = { code: out.error.code, message: s.scrub(out.error.message) };
    return result;
  }

  private remember(result: Result): void {
    this.cache.delete(result.cmdId);
    this.cache.set(result.cmdId, result);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Secrets that arrive inside commands: proxy credentials and VNC tokens. */
  private learnSecrets({ cmd }: Command): void {
    if (cmd.kind === 'profile.start' && cmd.proxy) this.opts.secrets.add(cmd.proxy.password);
    if (cmd.kind === 'vnc.open') this.opts.secrets.add(cmd.token);
  }
}
