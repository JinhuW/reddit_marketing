/** The agent's own requests through an HTTPS proxy: an HTTP proxy reached over TLS (plan 0004 phase 6). */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type Server, createServer, request } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Server as TlsServer, createServer as createTlsServer } from 'node:tls';
import type { ProxySpec } from '@threadline/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxyUrl } from '../docker';
import { ProxyFetchError, agentOver, fetchViaProxy, openTunnel } from './proxy-fetch';
import { type TestProxy, startHttpProxy } from './testing/proxies';

const USER = 'tl-user';
const PASS = 'tls-proxy-pass-s3cret';

/** A throwaway certificate for 127.0.0.1; null when openssl is not on this machine. */
function selfSigned(): { key: string; cert: string; dir: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'tl-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
      dir,
    };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}
const pem = selfSigned();

describe.skipIf(!pem)('https proxy', () => {
  let echo: Server;
  let echoUrl: string;
  let plain: TestProxy;
  let front: TlsServer;
  let port = 0;

  beforeAll(async () => {
    echo = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ip: '192.0.2.77' }));
    });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    echoUrl = `http://127.0.0.1:${(echo.address() as AddressInfo).port}/ip`;
    plain = await startHttpProxy(USER, PASS);
    // TLS in front of the plain test proxy: what a vendor's HTTPS proxy endpoint is.
    front = createTlsServer({ key: pem!.key, cert: pem!.cert }, (client) => {
      const up = connect(plain.port, '127.0.0.1');
      client.pipe(up).pipe(client);
      client.on('error', () => up.destroy());
      up.on('error', () => client.destroy());
    });
    await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()));
    port = (front.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((r) => front?.close(r));
    await plain?.close();
    echo?.closeAllConnections();
    await new Promise((r) => echo?.close(r));
    if (pem) rmSync(pem.dir, { recursive: true, force: true });
  });

  const spec = (password = PASS): ProxySpec => ({
    protocol: 'https',
    host: '127.0.0.1',
    port,
    username: USER,
    password,
  });
  const opts = () => ({ timeoutMs: 5000, proxyCa: pem!.cert });

  it('fetches through the proxy over TLS, with the login', async () => {
    const r = await fetchViaProxy(echoUrl, spec(), opts());
    expect(r).toEqual({ status: 200, body: JSON.stringify({ ip: '192.0.2.77' }) });
    expect(plain.hits.at(-1)).toMatchObject({ kind: 'forward', authorized: true });
  });

  it('opens a CONNECT tunnel over TLS', async () => {
    const u = new URL(echoUrl);
    const socket = await openTunnel(spec(), u.hostname, Number(u.port), 5000, undefined, pem!.cert);
    const answer = await new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (c: Buffer) => {
        buf += c.toString();
      });
      socket.on('end', () => resolve(buf));
      socket.write(`GET /ip HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`);
    });
    expect(answer).toContain('192.0.2.77');
    expect(plain.hits.at(-1)).toMatchObject({ kind: 'connect', authorized: true });
  });

  it('a wrong password is proxy_auth_failed, without the password in the error', async () => {
    const err = await fetchViaProxy(echoUrl, spec('wrong-password-1'), opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyFetchError);
    expect((err as ProxyFetchError).code).toBe('proxy_auth_failed');
    expect(String((err as Error).message)).not.toContain('wrong-password-1');
  });

  it('refuses a proxy whose certificate it cannot verify', async () => {
    const err = await fetchViaProxy(echoUrl, spec(), { timeoutMs: 5000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxyFetchError);
    expect((err as ProxyFetchError).code).toBe('proxy_unreachable');
    expect(String((err as Error).message)).not.toContain(PASS);
  });
});

describe('proxyUrl', () => {
  it('gives the browser an https:// proxy address with no login in it', () => {
    expect(
      proxyUrl({ protocol: 'https', host: 'gate.example.com', port: 8443, username: 'u', password: 'p' }),
    ).toBe('https://gate.example.com:8443');
  });
});

describe('agentOver', () => {
  it('sends the request on the given connection, never on a new one to the target', async () => {
    // Two servers: the request names A as its target but must travel on the socket connected to B.
    const serve = async (body: string) => {
      const s = createServer((_q, res) => res.end(body));
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
      return s;
    };
    const a = await serve('direct');
    const b = await serve('over-the-socket');
    try {
      const socket = connect((b.address() as AddressInfo).port, '127.0.0.1');
      await new Promise((r) => socket.once('connect', r));
      const body = await new Promise<string>((resolve, reject) => {
        request(
          {
            host: '127.0.0.1',
            port: (a.address() as AddressInfo).port,
            path: '/',
            headers: { connection: 'close' },
            agent: agentOver(socket, false),
          },
          (res) => {
            let d = '';
            res.on('data', (c: Buffer) => {
              d += c.toString();
            });
            res.on('end', () => resolve(d));
          },
        )
          .on('error', reject)
          .end();
      });
      expect(body).toBe('over-the-socket');
    } finally {
      a.closeAllConnections();
      b.closeAllConnections();
      await Promise.all([new Promise((r) => a.close(r)), new Promise((r) => b.close(r))]);
    }
  });
});
