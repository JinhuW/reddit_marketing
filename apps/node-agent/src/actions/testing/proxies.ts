/**
 * Test-only: a credentialed HTTP proxy, a credentialed SOCKS5 proxy, and a Chromium with CDP whose traffic goes
 * through one of them (the way a `tl-profile-<id>` container runs with `--proxy-server` and no credentials).
 * Everything listens on 127.0.0.1.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { type IncomingMessage, type Server, createServer, request } from 'node:http';
import { type AddressInfo, type Socket, connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium } from 'playwright-core';

export interface ProxyHit {
  kind: 'forward' | 'connect' | 'socks';
  target: string;
  authorized: boolean;
  userAgent?: string;
}

export interface TestProxy {
  port: number;
  hits: ProxyHit[];
  close(): Promise<void>;
}

function expectedAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** HTTP proxy answering 407 unless `Proxy-Authorization` matches; absolute-form forwarding and CONNECT. */
export async function startHttpProxy(user: string, pass: string): Promise<TestProxy> {
  const hits: ProxyHit[] = [];
  const ok = (req: IncomingMessage) => req.headers['proxy-authorization'] === expectedAuth(user, pass);
  const server: Server = createServer((req, res) => {
    const authorized = ok(req);
    hits.push({ kind: 'forward', target: req.url ?? '', authorized, userAgent: req.headers['user-agent'] });
    if (!authorized) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"', 'content-type': 'text/plain' });
      res.end('proxy auth required');
      return;
    }
    const url = new URL(req.url ?? '');
    const { 'proxy-authorization': _auth, 'proxy-connection': _conn, ...headers } = req.headers;
    const up = request(
      {
        host: url.hostname,
        port: url.port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const authorized = ok(req);
    hits.push({ kind: 'connect', target: req.url ?? '', authorized });
    if (!authorized) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n',
      );
      return;
    }
    const [host, port] = (req.url ?? '').split(':');
    const up = connect(Number(port), host ?? '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** SOCKS5 proxy (RFC 1928 CONNECT, RFC 1929 username/password). */
export async function startSocks5Proxy(user: string, pass: string): Promise<TestProxy> {
  const hits: ProxyHit[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage: 'greet' | 'auth' | 'request' | 'piping' = 'greet';
    let authorized = false;
    client.on('data', (chunk: Buffer) => {
      if (stage === 'piping') return;
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet' && buf.length >= 2 && buf.length >= 2 + (buf[1] ?? 0)) {
        const methods = [...buf.subarray(2, 2 + (buf[1] ?? 0))];
        buf = buf.subarray(2 + (buf[1] ?? 0));
        if (!methods.includes(2)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        client.write(Buffer.from([5, 2]));
        stage = 'auth';
      }
      if (stage === 'auth' && buf.length >= 2) {
        const ulen = buf[1] ?? 0;
        if (buf.length < 3 + ulen) return;
        const plen = buf[2 + ulen] ?? 0;
        if (buf.length < 3 + ulen + plen) return;
        const u = buf.subarray(2, 2 + ulen).toString();
        const p = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        authorized = u === user && p === pass;
        if (!authorized) {
          hits.push({ kind: 'socks', target: '', authorized });
          client.end(Buffer.from([1, 1]));
          return;
        }
        client.write(Buffer.from([1, 0]));
        stage = 'request';
      }
      if (stage === 'request' && buf.length >= 5) {
        const len = buf[4] ?? 0;
        if (buf[3] !== 3 || buf.length < 5 + len + 2) return;
        const host = buf.subarray(5, 5 + len).toString();
        const port = buf.readUInt16BE(5 + len);
        const rest = buf.subarray(5 + len + 2);
        hits.push({ kind: 'socks', target: `${host}:${port}`, authorized });
        stage = 'piping';
        client.removeAllListeners('data');
        const up = connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) up.write(rest);
          up.pipe(client);
          client.pipe(up);
        });
        sockets.add(up);
        up.on('close', () => sockets.delete(up));
        up.on('error', () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

export interface CdpBrowser {
  cdpUrl: string;
  close(): Promise<void>;
}

/** Chromium with CDP on a random port and extra args (e.g. `--proxy-server`), like a profile container. */
export async function launchCdpBrowser(args: string[]): Promise<CdpBrowser> {
  const dir = await mkdtemp(join(tmpdir(), 'tl-actions-cdp-'));
  let ctx: BrowserContext | null = null;
  try {
    ctx = await chromium.launchPersistentContext(dir, {
      executablePath: process.env.TESTKIT_CHROMIUM_PATH || undefined,
      headless: true,
      args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', ...args],
    });
    let port = 0;
    for (let i = 0; i < 200 && !port; i++) {
      const text = await readFile(join(dir, 'DevToolsActivePort'), 'utf8').catch(() => '');
      port = Number.parseInt(text.split('\n')[0] ?? '', 10) || 0;
      if (!port) await new Promise((r) => setTimeout(r, 50));
    }
    if (!port) throw new Error('no DevToolsActivePort');
    const c = ctx;
    return {
      cdpUrl: `http://127.0.0.1:${port}`,
      close: async () => {
        await c.close().catch(() => {});
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await ctx?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}
