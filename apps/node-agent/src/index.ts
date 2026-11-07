/** Node agent entry point: `node dist/index.mjs` in the image, `pnpm dev` locally. */
import { startAgent } from './agent';
import { ConfigError, loadConfig } from './config';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    // Config errors name variables only, never values.
    console.error(err instanceof ConfigError ? err.message : 'failed to read configuration');
    process.exit(1);
  }
  const agent = await startAgent({ config });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    agent.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    agent.stop().then(
      () => process.exit(0),
      (err) => {
        agent.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
