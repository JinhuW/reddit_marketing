/**
 * `SERVICE_ROLE=gateway`: the node gateway (docs/plans/0001-infra-implementation.md §3.4). It consumes the
 * `browser.<node>` queues and talks to node agents over WSS; it runs none of the core processors.
 * `startGateway()` is expected to resolve once the gateway is listening and to reject if it cannot start.
 */
import { startGateway } from '../gateway/index';
import type { RoleHandle } from './role';

/**
 * Optional handle the gateway may resolve with so shutdown can close sockets and queue consumers.
 * `startGateway()` resolves with a `GatewayHandle` exposing `stop()`; `close()` is accepted too.
 */
interface Closable {
  close(): Promise<void> | void;
}
interface Stoppable {
  stop(): Promise<void> | void;
}
const isClosable = (x: unknown): x is Closable =>
  typeof x === 'object' && x !== null && typeof (x as Closable).close === 'function';
const isStoppable = (x: unknown): x is Stoppable =>
  typeof x === 'object' && x !== null && typeof (x as Stoppable).stop === 'function';

export async function startGatewayRole(start: () => Promise<unknown> = startGateway): Promise<RoleHandle> {
  const started: unknown = await start();
  return {
    role: 'gateway',
    async stop() {
      if (isStoppable(started)) await started.stop();
      else if (isClosable(started)) await started.close();
    },
  };
}
