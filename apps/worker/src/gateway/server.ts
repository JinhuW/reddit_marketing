/**
 * Gateway HTTP server (`SERVICE_ROLE=gateway`, `nodes.<domain>`): `GET /healthz` and the agent WebSocket at
 * `/agent`. Wave 2 tasks mount their own paths through `route` / `upgrade` (e.g. T24's `/internal/vnc/*` and
 * `/vnc/*`) instead of editing this file. Anything unmatched is a 404; upgrades on other paths are refused.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { AGENT_PATH } from '@threadline/shared';
import { log as rootLog } from '../log';
import type { Hub } from './hub';

export type HttpHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void;

export interface GatewayServer {
  readonly http: Server;
  /** Mount an HTTP handler on every path under `prefix` (e.g. `/internal/vnc/`). First match wins. */
  route(prefix: string, handler: HttpHandler): void;
  /** Mount a WebSocket upgrade handler on every path under `prefix` (e.g. `/vnc/`). */
  upgrade(prefix: string, handler: UpgradeHandler): void;
  /** Listens on `port` (0 = any free port) and resolves with the bound port. */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function refuseUpgrade(socket: Duplex, status: string) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const matches = (path: string, prefix: string) =>
  prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`);

export function createGatewayServer(opts: { hub: Hub; log?: typeof rootLog }): GatewayServer {
  const log = (opts.log ?? rootLog).child({ component: 'gateway.server' });
  const routes: { prefix: string; handler: HttpHandler }[] = [];
  const upgrades: { prefix: string; handler: UpgradeHandler }[] = [
    { prefix: AGENT_PATH, handler: (req, socket, head) => opts.hub.handleUpgrade(req, socket, head) },
  ];

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return json(res, 405, { error: 'method not allowed' });
      // Public endpoint: a count, not node names.
      return json(res, 200, { ok: true, role: 'gateway', nodesOnline: opts.hub.nodes().length });
    }
    const r = routes.find((x) => matches(url.pathname, x.prefix));
    if (!r) return json(res, 404, { error: 'not found' });
    Promise.resolve(r.handler(req, res, url)).catch((e) => {
      log.error({ path: url.pathname, err: (e as Error).message }, 'route failed');
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    const u = upgrades.find((x) => matches(url.pathname, x.prefix));
    if (!u) return refuseUpgrade(socket, '404 Not Found');
    try {
      u.handler(req, socket, head, url);
    } catch (e) {
      log.error({ path: url.pathname, err: (e as Error).message }, 'upgrade failed');
      refuseUpgrade(socket, '500 Internal Server Error');
    }
  });

  return {
    http,
    route: (prefix, handler) => {
      routes.push({ prefix, handler });
    },
    upgrade: (prefix, handler) => {
      upgrades.push({ prefix, handler });
    },
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => {
          http.off('error', reject);
          resolve((http.address() as AddressInfo).port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        if (!http.listening) return resolve();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
