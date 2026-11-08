/**
 * Threadline worker entry point. `SERVICE_ROLE` picks what this process runs (docs/plans/0001-infra-implementation.md
 * §3.5): `core` (default) runs every non-browser queue in docs/PLAN.md §9; `gateway` runs the node gateway.
 * An unknown role exits non-zero before connecting to anything.
 */
import { log } from './log';
import { type RoleHandle, createShutdown, resolveRole, startRole } from './roles/role';

async function main() {
  const role = resolveRole(process.env.SERVICE_ROLE);
  log.info({ role }, 'worker starting');
  let handle: RoleHandle;
  try {
    handle = await startRole(role);
  } catch (err) {
    await disconnectDb();
    throw err;
  }
  const shutdown = createShutdown(handle, {
    finalize: disconnectDb,
    onError: (err) => log.error({ role, err }, 'shutdown error'),
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.on(sig, () => {
      log.info({ role, signal: sig }, 'worker stopping');
      void shutdown();
    });
  log.info({ role }, 'worker started');
}

async function disconnectDb() {
  const { prisma } = await import('@threadline/db');
  await prisma.$disconnect();
}

main().catch((e: unknown) => {
  log.error({ err: e }, 'worker failed to start');
  process.exit(1);
});
