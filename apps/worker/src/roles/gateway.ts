/**
 * `SERVICE_ROLE=gateway`: the node gateway (docs/plans/0001-infra-implementation.md §3.4). It consumes the
 * `browser.<node>` queues and talks to node agents over WSS; it runs none of the core processors.
 * `startGateway()` is expected to resolve once the gateway is listening and to reject if it cannot start.
 */
import { startGateway } from '../gateway/index';
import type { RoleHandle } from './role';

/** Optional handle the gateway may resolve with so shutdown can close sockets and queue consumers. */
interface Closable {
  close(): Promise<void> | void;
}
const isClosable = (x: unknown): x is Closable =>
  typeof x === 'object' && x !== null && typeof (x as Closable).close === 'function';

export async function startGatewayRole(start: () => Promise<unknown> = startGateway): Promise<RoleHandle> {
  const started: unknown = await start();
  return {
    role: 'gateway',
    async stop() {
      if (isClosable(started)) await started.close();
    },
  };
}
