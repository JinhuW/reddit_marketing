/**
 * Extension points for handler modules. Each module under `src/handlers/` exports one {@link AgentModule}
 * and is listed once in `src/handlers/index.ts`. Wave 2 tasks replace a stub module's body (keeping its export
 * name) without touching the core: T21 `profile.ts`, T22 `actions.ts`, T24 `vnc.ts`.
 */
import type {
  BrowserOutcome,
  CmdKind,
  CmdOf,
  NodeEvent,
  ProfileRef,
  ResultError,
  Seats,
} from '@threadline/shared';
import type { AgentConfig } from './config';
import type { Logger, SecretSet } from './log';
import type { StatusStore } from './status';

/** What a handler returns; dispatch wraps it into a `result` frame for the command's `cmdId`. */
export interface HandlerResult {
  outcome: BrowserOutcome;
  data?: unknown;
  error?: ResultError;
}

export interface HandlerContext {
  cmdId: string;
  /** Aborted when the command's deadline passes; long actions should stop at the next safe point. */
  signal: AbortSignal;
  /** Epoch ms (agent clock) by which the result is due. */
  deadlineAt: number;
  log: Logger;
  config: AgentConfig;
  status: StatusStore;
  /** Register a secret value seen at runtime so logs and results scrub it. */
  secrets: SecretSet;
}

export type Handler<K extends CmdKind> = (cmd: CmdOf<K>, ctx: HandlerContext) => Promise<HandlerResult>;
export type HandlerMap = { [K in CmdKind]?: Handler<K> };

/** Event fields as sent to the gateway, minus the `type` tag. */
export type AgentEvent = Omit<NodeEvent, 'type'>;

export interface ModuleContext {
  config: AgentConfig;
  log: Logger;
  secrets: SecretSet;
  status: StatusStore;
  /** Send a node event (`container.exited`, `session.activity`, `needs_human`); dropped while disconnected. */
  emit(event: AgentEvent): void;
}

export interface AgentModule {
  name: string;
  handlers: HandlerMap;
  /** Called once before the agent dials the gateway. */
  start?(ctx: ModuleContext): void | Promise<void>;
  /** Called once on shutdown, after the gateway socket is closed. */
  stop?(): void | Promise<void>;
}

/** Stub result for command kinds whose module has not landed yet. */
export function notImplemented<K extends CmdKind>(kind: K): Handler<K> {
  return async () => ({
    outcome: 'error',
    error: { code: 'not_implemented', message: `${kind} is not implemented on this agent yet` },
  });
}

/** Merge module handler maps; a kind claimed by two modules is a wiring bug. */
export function mergeHandlers(modules: readonly AgentModule[]): HandlerMap {
  const out: Record<string, unknown> = {};
  const owner: Record<string, string> = {};
  for (const m of modules) {
    for (const [kind, h] of Object.entries(m.handlers)) {
      if (!h) continue;
      if (owner[kind]) throw new Error(`handler for ${kind} registered by both ${owner[kind]} and ${m.name}`);
      owner[kind] = m.name;
      out[kind] = h;
    }
  }
  return out as HandlerMap;
}

export type { ProfileRef, Seats };
