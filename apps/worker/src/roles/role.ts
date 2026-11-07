/**
 * Worker service roles (docs/plans/0001-infra-implementation.md §3.5, T10).
 * One image, two processes: `SERVICE_ROLE=core` (default) runs every non-browser queue; `SERVICE_ROLE=gateway`
 * runs the node gateway. Role modules are imported lazily so a gateway process never loads the core processors.
 */

export const SERVICE_ROLES = ['core', 'gateway'] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

/** What a started role hands back so the shared shutdown can stop it. */
export interface RoleHandle {
  role: ServiceRole;
  stop(): Promise<void>;
}

export class UnknownRoleError extends Error {
  constructor(readonly value: string) {
    super(`unknown SERVICE_ROLE "${value}"; expected one of: ${SERVICE_ROLES.join(', ')}`);
    this.name = 'UnknownRoleError';
  }
}

/** Unset or empty means `core`. Anything that is not a known role throws, so the process exits non-zero. */
export function resolveRole(value: string | undefined): ServiceRole {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return 'core';
  if ((SERVICE_ROLES as readonly string[]).includes(v)) return v as ServiceRole;
  throw new UnknownRoleError(value ?? '');
}

export async function startRole(role: ServiceRole): Promise<RoleHandle> {
  switch (role) {
    case 'core':
      return (await import('./core')).startCore();
    case 'gateway':
      return (await import('./gateway')).startGatewayRole();
  }
}

export interface ShutdownDeps {
  /** Runs after the role has stopped (or failed to stop), e.g. closing the Prisma pool. */
  finalize?: () => Promise<void>;
  exit?: (code: number) => void;
  onError?: (err: unknown) => void;
  /** Hard deadline: exit 1 if stopping takes longer than this. */
  timeoutMs?: number;
}

/**
 * Shared graceful shutdown for every role. Idempotent: a second signal while stopping does not stop twice.
 * Exits 0 when the role and finalizer both finish in time, 1 otherwise.
 */
export function createShutdown(handle: Pick<RoleHandle, 'stop'>, deps: ShutdownDeps = {}) {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = deps.timeoutMs ?? 25_000;
  let running: Promise<void> | undefined;

  return function shutdown(): Promise<void> {
    if (running) return running;
    running = (async () => {
      let code = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref?.();
      });
      const work = (async () => {
        try {
          await handle.stop();
        } catch (err) {
          code = 1;
          deps.onError?.(err);
        }
        try {
          await deps.finalize?.();
        } catch (err) {
          code = 1;
          deps.onError?.(err);
        }
        return 'done' as const;
      })();
      const r = await Promise.race([work, deadline]);
      clearTimeout(timer);
      if (r === 'timeout') {
        deps.onError?.(new Error(`shutdown did not finish within ${timeoutMs} ms`));
        code = 1;
      }
      exit(code);
    })();
    return running;
  };
}
