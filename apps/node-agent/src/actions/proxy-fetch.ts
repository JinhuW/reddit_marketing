/**
 * The agent's own request through a profile's proxy, for the connection test's `agentIp` (plan §4 T22, T31):
 * HTTP proxies use absolute-form GET for http:// targets and CONNECT for https://; SOCKS5 proxies use the
 * RFC 1928 handshake with RFC 1929 username/password auth. Node built-ins only, so the node image stays small.
 *
 * Credentials go only into the proxy handshake; errors never include them.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { type Socket, connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { ProxySpec } from '@threadline/shared';

export class ProxyFetchError extends Error {
  constructor(
    readonly code: 'proxy_unreachable' | 'proxy_auth_failed' | 'proxy_refused' | 'upstream_error' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'ProxyFetchError';
  }
}

export interface FetchedText {
  status: number;
  body: string;
}

export interface ProxyFetchOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

const MAX_BODY = 64 * 1024;

/** GET `url` through `proxy` (or directly when `proxy` is null). */
export async function fetchViaProxy(
  url: string,
  proxy: ProxySpec | null,
  opts: ProxyFetchOptions,
): Promise<FetchedText> {
  const target = new URL(url);
  const https = target.protocol === 'https:';
  const port = Number(target.port || (https ? 443 : 80));
  const deadline = Date.now() + opts.timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());

  if (!proxy) return get(url, undefined, { headers: {} }, left(), opts.signal);
  if (proxy.protocol === 'http' && !https) {
    // Absolute-form request to the proxy itself.
    return get(
      url,
      undefined,
      {
        host: proxy.host,
        port: proxy.port,
        path: target.toString(),
        headers: { host: target.host, ...basicAuth(proxy) },
      },
      left(),
      opts.signal,
    );
  }
  const socket = await openTunnel(proxy, target.hostname, port, left(), opts.signal);
  const conn = https ? tlsConnect({ socket, servername: target.hostname }) : socket;
  return get(url, conn, { headers: {} }, left(), opts.signal);
}

function basicAuth(proxy: ProxySpec): Record<string, string> {
  if (!proxy.username) return {};
  const token = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64');
  return { 'proxy-authorization': `Basic ${token}` };
}

function get(
  url: string,
  socket: Socket | undefined,
  extra: { host?: string; port?: number; path?: string; headers: Record<string, string> },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FetchedText> {
  const target = new URL(url);
  const req = target.protocol === 'https:' && !extra.host ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(
      {
        method: 'GET',
        protocol: extra.host ? 'http:' : target.protocol,
        host: extra.host ?? target.hostname,
        port: extra.port ?? (target.port || undefined),
        path: extra.path ?? `${target.pathname}${target.search}`,
        headers: { accept: 'application/json, text/plain', connection: 'close', ...extra.headers },
        agent: false,
        timeout: timeoutMs,
        signal,
        ...(socket ? { createConnection: () => socket } : {}),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          if (body.length < MAX_BODY) body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', (e) => reject(new ProxyFetchError('upstream_error', e.message)));
      },
    );
    r.on('timeout', () => r.destroy(new ProxyFetchError('timeout', `no answer within ${timeoutMs} ms`)));
    r.on('error', (e) =>
      reject(e instanceof ProxyFetchError ? e : new ProxyFetchError('upstream_error', e.message)),
    );
    r.end();
  }).then((res) => {
    const out = res as FetchedText;
    if (out.status === 407) throw new ProxyFetchError('proxy_auth_failed', 'proxy rejected the credentials');
    return out;
  });
}

/** A raw TCP stream to `host:port` through the proxy (HTTP CONNECT or SOCKS5). */
export async function openTunnel(
  proxy: ProxySpec,
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Socket> {
  const socket = await dial(proxy.host, proxy.port, timeoutMs, signal);
  const timer = setTimeout(
    () => socket.destroy(new ProxyFetchError('timeout', `proxy handshake took over ${timeoutMs} ms`)),
    timeoutMs,
  );
  try {
    const io = new Reader(socket);
    if (proxy.protocol === 'http') {
      const auth = basicAuth(proxy)['proxy-authorization'];
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`,
      );
      const head = await io.until('\r\n\r\n');
      const status = Number(head.toString('latin1').match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0);
      if (status === 407) throw new ProxyFetchError('proxy_auth_failed', 'proxy rejected the credentials');
      if (status !== 200)
        throw new ProxyFetchError('proxy_refused', `proxy CONNECT answered ${status || 'garbage'}`);
    } else {
      await socks5(io, socket, proxy, host, port);
    }
    io.release();
    return socket;
  } catch (err) {
    socket.destroy();
    throw err instanceof ProxyFetchError ? err : new ProxyFetchError('proxy_refused', String(err));
  } finally {
    clearTimeout(timer);
  }
}

async function socks5(io: Reader, socket: Socket, proxy: ProxySpec, host: string, port: number) {
  const withAuth = !!proxy.username;
  socket.write(Buffer.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]));
  const [ver, method] = await io.read(2);
  if (ver !== 5 || method === 0xff)
    throw new ProxyFetchError('proxy_refused', 'SOCKS5 proxy refused the methods');
  if (method === 2) {
    if (!withAuth) throw new ProxyFetchError('proxy_auth_failed', 'SOCKS5 proxy wants credentials');
    const u = Buffer.from(proxy.username ?? '');
    const p = Buffer.from(proxy.password ?? '');
    if (u.length > 255 || p.length > 255)
      throw new ProxyFetchError('proxy_auth_failed', 'credentials too long');
    socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const [, status] = await io.read(2);
    if (status !== 0) throw new ProxyFetchError('proxy_auth_failed', 'proxy rejected the credentials');
  } else if (method !== 0) {
    throw new ProxyFetchError('proxy_refused', `SOCKS5 proxy chose unsupported method ${method}`);
  }
  const h = Buffer.from(host);
  socket.write(
    Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 0xff])]),
  );
  const [, rep, , atyp] = await io.read(4);
  if (rep !== 0) throw new ProxyFetchError('proxy_refused', `SOCKS5 connect failed with code ${rep}`);
  const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : ((await io.read(1))[0] ?? 0);
  await io.read(addrLen + 2);
}

function dial(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host, port });
    const fail = (err: Error) => {
      s.destroy();
      reject(new ProxyFetchError('proxy_unreachable', `proxy ${host}:${port} unreachable: ${err.message}`));
    };
    const timer = setTimeout(() => fail(new Error('connect timeout')), timeoutMs);
    const onAbort = () => fail(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    s.once('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    s.once('connect', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      s.removeAllListeners('error');
      resolve(s);
    });
  });
}

/** Buffered reads from a socket during a handshake. */
class Reader {
  private buf = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  private readonly onData = (c: Buffer) => {
    this.buf = Buffer.concat([this.buf, c]);
    this.wake?.();
  };
  private readonly onEnd = () => {
    this.failure ??= new ProxyFetchError('proxy_refused', 'proxy closed the connection during the handshake');
    this.wake?.();
  };
  private readonly onError = (e: Error) => {
    this.failure = e;
    this.wake?.();
  };

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
    socket.on('error', this.onError);
  }

  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.more();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async until(delim: string): Promise<Buffer> {
    for (;;) {
      const i = this.buf.indexOf(delim);
      if (i >= 0) return this.read(i + delim.length);
      if (this.buf.length > 16 * 1024) throw new ProxyFetchError('proxy_refused', 'proxy answer too long');
      await this.more();
    }
  }

  /** Stop listening; the tunnel is clean (nothing buffered past the handshake). */
  release(): void {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    this.socket.off('error', this.onError);
    if (this.buf.length) this.socket.unshift(this.buf);
  }

  private more(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.wake = () => {
        this.wake = null;
        if (this.failure) reject(this.failure);
        else resolve();
      };
    });
  }
}
