/**
 * Node gateway entry point (`SERVICE_ROLE=gateway`, docs/plans/0001-infra-implementation.md §3.4).
 *
 * Starts the HTTP server on `PORT` (default 8080) with `/healthz` and the authenticated agent WebSocket at
 * `/agent`. Wave 2 features (dispatch, VNC relay) attach as plugins: they get the hub and the server and return
 * an optional stop function. `stopGateway()` closes agent sockets (writing `node.offline`) and the server.
 */
import { nodes } from '@threadline/db';
import { log as rootLog } from '../log';
import { checkEnvTokens } from './auth';
import { type Hub, type HubOptions, createHub } from './hub';
import { type GatewayServer, createGatewayServer } from './server';

export { Hub, NodeError, type NodeErrorCode, type NodeInfo, type OfflineInfo } from './hub';
export type { GatewayServer } from './server';

export interface GatewayContext {
  hub: Hub;
  server: GatewayServer;
  log: typeof rootLog;
}

export interface GatewayPlugin {
  name: string;
  /** Called after the hub and server exist, before the port opens. May return a stop function. */
  start(ctx: GatewayContext): Promise<(() => Promise<void>) | undefined> | (() => Promise<void>) | undefined;
}

export interface GatewayOptions {
  port?: number;
  host?: string;
  plugins?: GatewayPlugin[];
  hub?: HubOptions;
  env?: NodeJS.ProcessEnv;
}

export interface GatewayHandle extends GatewayContext {
  port: number;
  stop(): Promise<void>;
}

let current: GatewayHandle | null = null;

/**
 * Nodes still `online` in the database have no socket on a gateway that just started (single replica): the
 * previous process died without writing `node.offline`. Mark them offline so their audit trail and dispatch
 * state are right; they flip back to online on reconnect.
 */
async function reconcileStaleNodes(log: typeof rootLog) {
  for (const n of await nodes.listOnline()) {
    await nodes.markOffline(n.id, 'gateway_restart');
    log.info({ node: n.name }, 'stale online node marked offline');
  }
}

export async function startGateway(opts: GatewayOptions = {}): Promise<GatewayHandle> {
  if (current) throw new Error('gateway already started');
  const env = opts.env ?? process.env;
  const log = rootLog.child({ role: 'gateway' });

  await reconcileStaleNodes(log);
  const tokens = await checkEnvTokens(env);
  if (tokens.mismatched.length)
    log.warn({ vars: tokens.mismatched }, 'NODE_TOKEN_* variables do not match any node token hash');

  const hub = createHub({ ...opts.hub, log });
  const server = createGatewayServer({ hub, log });
  const ctx: GatewayContext = { hub, server, log };
  const stops: (() => Promise<void>)[] = [];
  for (const p of opts.plugins ?? []) {
    const stop = await p.start(ctx);
    if (stop) stops.push(stop);
    log.info({ plugin: p.name }, 'gateway plugin started');
  }

  const port = await server.listen(opts.port ?? Number(env.PORT ?? 8080), opts.host);
  log.info({ port, plugins: (opts.plugins ?? []).map((p) => p.name) }, 'gateway listening');

  let stopping: Promise<void> | null = null;
  const handle: GatewayHandle = {
    ...ctx,
    port,
    stop: () => {
      stopping ??= (async () => {
        for (const s of stops.reverse())
          await s().catch((e) => log.error({ err: e.message }, 'plugin stop failed'));
        await hub.close();
        await server.close();
        if (current === handle) current = null;
        log.info('gateway stopped');
      })();
      return stopping;
    },
  };
  current = handle;
  return handle;
}

/** Stops the gateway started by `startGateway`, if any. For the worker's shared graceful shutdown. */
export async function stopGateway(): Promise<void> {
  await current?.stop();
}
