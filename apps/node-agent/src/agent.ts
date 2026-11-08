/** Wires config, logger, status, handler modules, dispatcher and gateway client into one agent. */
import { type Backoff, GatewayClient } from './client';
import type { AgentConfig } from './config';
import { secretValues } from './config';
import { Dispatcher } from './dispatch';
import { modules as defaultModules } from './handlers';
import { type Logger, SecretSet, createLogger } from './log';
import { type AgentModule, type ModuleContext, mergeHandlers } from './registry';
import { StatusStore } from './status';

export interface AgentOptions {
  config: AgentConfig;
  modules?: readonly AgentModule[];
  log?: Logger;
  secrets?: SecretSet;
  backoff?: Backoff;
}

export interface Agent {
  client: GatewayClient;
  dispatcher: Dispatcher;
  status: StatusStore;
  log: Logger;
  secrets: SecretSet;
  stop(): Promise<void>;
}

export async function startAgent(opts: AgentOptions): Promise<Agent> {
  const { config } = opts;
  const modules = opts.modules ?? defaultModules;
  const secrets = opts.secrets ?? new SecretSet();
  for (const s of secretValues(config)) secrets.add(s);
  const log = opts.log ?? createLogger({ level: config.logLevel, secrets, base: { node: config.nodeName } });
  const status = new StatusStore(config.maxProfiles);

  // Modules start before the client exists; events emitted that early are dropped.
  const ref: { client?: GatewayClient } = {};
  const ctx: ModuleContext = {
    config,
    log,
    secrets,
    status,
    emit: (event) => {
      if (!ref.client?.sendEvent(event))
        log.warn({ event: event.kind, profileId: event.profileId }, 'event dropped');
    },
  };

  const handlers = mergeHandlers(modules);
  for (const m of modules) await m.start?.({ ...ctx, log: log.child({ module: m.name }) });

  const dispatcher = new Dispatcher({ handlers, log, secrets, config, status });
  const client = new GatewayClient({ config, log, dispatcher, status, backoff: opts.backoff });
  ref.client = client;
  client.start();
  log.info({ version: config.agentVersion, maxProfiles: config.maxProfiles }, 'node agent started');

  return {
    client,
    dispatcher,
    status,
    log,
    secrets,
    async stop() {
      await client.stop();
      for (const m of [...modules].reverse()) {
        try {
          await m.stop?.();
        } catch (err) {
          log.error({ err, module: m.name }, 'module stop failed');
        }
      }
    },
  };
}
