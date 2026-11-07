/**
 * Custom Node server for apps/web (infra plan T23): Next.js for every request, plus the authenticated VNC
 * websocket on `/api/vnc/<profileId>` (route handlers cannot accept upgrades). See vnc-proxy.ts.
 *
 *   pnpm --filter @threadline/web dev     tsx server.ts               (NODE_ENV≠production → next dev)
 *   pnpm --filter @threadline/web start   NODE_ENV=production tsx server.ts   (needs `next build`)
 *
 * Env: PORT (3000), NODE_GATEWAY_URL, GATEWAY_INTERNAL_SECRET, APP_URL / AUTH_URL (allowed websocket origins).
 * Listens on every interface (dual-stack), like `next start`.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import next from 'next';
import { VNC_AUTHZ_ENV } from './vnc-authz';
import { createVncProxy, routeAuthorizer } from './vnc-proxy';

const log = (msg: string, meta?: Record<string, unknown>) =>
  console.log(JSON.stringify({ level: 'info', component: 'web.server', msg, ...meta }));

async function startWebServer() {
  const dev = process.env.NODE_ENV !== 'production';
  const port = Number(process.env.PORT ?? 3000);
  // Not $HOSTNAME: Docker sets it to the container id.
  const hostname = 'localhost';
  const dir = fileURLToPath(new URL('.', import.meta.url));

  // Key for the in-process authorize POST (vnc-authz.ts). Set before Next loads any route module.
  const key = randomBytes(32).toString('hex');
  process.env[VNC_AUTHZ_ENV] = key;

  // Next attaches its own `upgrade` listener (HMR in dev) to `httpServer` on the first request, and that
  // listener ends any upgrade on a path that has a route handler, including /api/vnc/*. Give it a server that
  // never listens and forward only the upgrades that are not ours.
  const nextUpgrades = createServer();
  const app = next({ dev, dir, hostname, port, httpServer: nextUpgrades });
  await app.prepare(); // loads .env files, so read the gateway settings after this
  const handle = app.getRequestHandler();

  const vnc = createVncProxy({
    gatewayUrl: process.env.NODE_GATEWAY_URL || undefined,
    secret: process.env.GATEWAY_INTERNAL_SECRET || undefined,
    allowedOrigins: [process.env.APP_URL, process.env.AUTH_URL].filter((u): u is string => Boolean(u)),
    authorize: routeAuthorizer({ port, key }),
    log,
  });

  const server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => {
      log('request failed', { err: e.message });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    if (vnc.handleUpgrade(req, socket, head)) return;
    if (nextUpgrades.listenerCount('upgrade') > 0) nextUpgrades.emit('upgrade', req, socket, head);
    else socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  log('listening', {
    port,
    dev,
    vnc: process.env.NODE_GATEWAY_URL && process.env.GATEWAY_INTERNAL_SECRET ? 'on' : 'off',
  });

  const shutdown = () => {
    vnc.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

startWebServer().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
