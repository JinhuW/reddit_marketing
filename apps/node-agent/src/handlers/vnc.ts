/**
 * `vnc.open` (T24): open a pipe between the gateway and the profile container's websockify, see `../vnc.ts`.
 * Answers `ok` once both sockets are open; the pipe then lives until either side closes. While the human types
 * or points, the module sends throttled `session.activity` events, which the gateway turns into session log rows
 * for `session.idle`. One pipe per session: a newer `vnc.open` for the same session replaces the old pipe.
 */
import type { AgentEvent, AgentModule, ModuleContext } from '../registry';
import { VncError, type VncPipe, openVncPipe, websockifyUrl } from '../vnc';

export interface VncModuleOptions {
  /** Where the profile's websockify listens. Default `ws://tl-profile-<id>:6080/websockify`. */
  targetUrl?: (profileId: string) => string;
  /** At most one `session.activity` event per profile per this interval. Default 30 s. */
  activityEveryMs?: number;
  /** Cap on dialing each socket. Default 8 s (inside the gateway's 10 s wait). */
  dialTimeoutMs?: number;
}

export function createVncModule(opts: VncModuleOptions = {}): AgentModule & { pipes(): VncPipe[] } {
  const pipes = new Map<string, VncPipe>();
  const lastActivity = new Map<string, number>();
  let emit: (e: AgentEvent) => void = () => {};
  const activityEveryMs = opts.activityEveryMs ?? 30_000;

  return {
    name: 'vnc',
    pipes: () => [...pipes.values()],
    start(ctx: ModuleContext) {
      emit = (e) => ctx.emit(e);
    },
    async stop() {
      const all = [...pipes.values()];
      pipes.clear();
      for (const p of all) p.close(1001, 'agent stopping');
      await Promise.all(all.map((p) => p.closed));
    },
    handlers: {
      'vnc.open': async (cmd, ctx) => {
        const timeoutMs = Math.max(
          500,
          Math.min(opts.dialTimeoutMs ?? 8_000, ctx.deadlineAt - Date.now() - 250),
        );
        try {
          const targetUrl = (opts.targetUrl ?? websockifyUrl)(cmd.profileId);
          const pipe = await openVncPipe({
            gatewayUrl: ctx.config.gatewayUrl,
            profileId: cmd.profileId,
            sessionId: cmd.sessionId,
            upstreamUrl: cmd.upstreamUrl,
            token: cmd.token,
            targetUrl,
            timeoutMs,
            signal: ctx.signal,
            log: ctx.log,
            onInput: () => {
              const now = Date.now();
              if (now - (lastActivity.get(cmd.profileId) ?? 0) < activityEveryMs) return;
              lastActivity.set(cmd.profileId, now);
              emit({
                profileId: cmd.profileId,
                kind: 'session.activity',
                detail: { sessionId: cmd.sessionId },
              });
            },
          });
          const previous = pipes.get(cmd.sessionId);
          pipes.set(cmd.sessionId, pipe);
          previous?.close(4409, 'replaced by a newer viewer');
          void pipe.closed.then(() => {
            if (pipes.get(cmd.sessionId) === pipe) pipes.delete(cmd.sessionId);
          });
          return { outcome: 'ok', data: { sessionId: cmd.sessionId } };
        } catch (e) {
          const err = e instanceof VncError ? e : new VncError('vnc_target_unreachable', 'vnc pipe failed');
          ctx.log.warn({ profileId: cmd.profileId, code: err.code }, 'vnc.open failed');
          return { outcome: 'error', error: { code: err.code, message: err.message } };
        }
      },
    },
  };
}

export const vncModule = createVncModule();
