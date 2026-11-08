import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { startGatewayRole } from './gateway';
import { UnknownRoleError, createShutdown, resolveRole, startRole } from './role';

const startGateway = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../gateway/index', () => ({ startGateway }));

describe('resolveRole', () => {
  it('defaults to core when SERVICE_ROLE is unset or empty', () => {
    expect(resolveRole(undefined)).toBe('core');
    expect(resolveRole('')).toBe('core');
    expect(resolveRole('  ')).toBe('core');
  });

  it('accepts the known roles', () => {
    expect(resolveRole('core')).toBe('core');
    expect(resolveRole('gateway')).toBe('gateway');
    expect(resolveRole(' Gateway ')).toBe('gateway');
  });

  it('rejects anything else', () => {
    expect(() => resolveRole('node')).toThrow(UnknownRoleError);
    expect(() => resolveRole('core,gateway')).toThrow(/unknown SERVICE_ROLE "core,gateway"/);
  });
});

describe('gateway role', () => {
  it('starts the gateway and nothing from core', async () => {
    startGateway.mockClear();
    const handle = await startRole('gateway');
    expect(handle.role).toBe('gateway');
    expect(startGateway).toHaveBeenCalledOnce();
    const opts = (startGateway.mock.calls[0] as unknown[])[0] as { plugins: { name: string }[] };
    expect(opts.plugins.map((p) => p.name)).toEqual(['dispatch', 'vnc', 'browser.health']);
    await handle.stop();
  });

  it('propagates a gateway start failure', async () => {
    await expect(
      startGatewayRole(async () => {
        throw new Error('not implemented');
      }),
    ).rejects.toThrow('not implemented');
  });

  it('closes the gateway on stop when it returns a handle', async () => {
    const close = vi.fn(async () => {});
    const handle = await startGatewayRole(async () => ({ close }));
    await handle.stop();
    expect(close).toHaveBeenCalledOnce();
  });

  it('stops the gateway on stop when it returns a GatewayHandle', async () => {
    const stop = vi.fn(async () => {});
    const handle = await startGatewayRole(async () => ({ stop }));
    await handle.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('createShutdown', () => {
  it('stops the role, finalizes, exits 0, and only once on repeated signals', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown(
      { stop: async () => void order.push('stop') },
      { finalize: async () => void order.push('finalize'), exit },
    );
    await Promise.all([shutdown(), shutdown()]);
    expect(order).toEqual(['stop', 'finalize']);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still finalizes and exits 1 when stopping the role fails', async () => {
    const exit = vi.fn();
    const finalize = vi.fn(async () => {});
    const onError = vi.fn();
    await createShutdown(
      {
        stop: async () => {
          throw new Error('boom');
        },
      },
      { finalize, exit, onError },
    )();
    expect(finalize).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when stopping hangs past the deadline', async () => {
    const exit = vi.fn();
    await createShutdown({ stop: () => new Promise(() => {}) }, { exit, timeoutMs: 20 })();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('worker entry point', () => {
  it('exits non-zero on an unknown SERVICE_ROLE without starting anything', () => {
    const cwd = fileURLToPath(new URL('../..', import.meta.url));
    const r = spawnSync('node_modules/.bin/tsx', ['src/index.ts'], {
      cwd,
      env: { ...process.env, SERVICE_ROLE: 'bogus', LOG_LEVEL: 'info' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stdout).toContain('unknown SERVICE_ROLE');
    expect(r.stdout).not.toContain('worker started');
  });
});
