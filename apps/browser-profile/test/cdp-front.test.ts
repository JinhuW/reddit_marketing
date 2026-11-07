import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createCdpFront, rewriteDevtoolsUrls } from '../lib/cdp-front.mjs';

const servers: (http.Server | net.Server)[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers) if (s instanceof http.Server) s.closeAllConnections();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

const listening = (s: http.Server) =>
  new Promise<number>((resolve) => {
    if (s.listening) resolve((s.address() as AddressInfo).port);
    else s.once('listening', () => resolve((s.address() as AddressInfo).port));
  });

/** Stands in for Chromium's DevTools endpoint, including its Host header check. */
async function fakeDevtools() {
  const seen: { host?: string; upgradeHost?: string } = {};
  const upstream = http.createServer((req, res) => {
    seen.host = req.headers.host;
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      res.writeHead(500);
      res.end('Host header is specified and is not an IP address or localhost.');
      return;
    }
    const port = (upstream.address() as AddressInfo).port;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        Browser: 'Chrome/140',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc`,
      }),
    );
  });
  upstream.on('upgrade', (req, socket) => {
    seen.upgradeHost = req.headers.host;
    sockets.push(socket as net.Socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(d)); // echo
  });
  upstream.listen(0, '127.0.0.1');
  servers.push(upstream);
  return { port: await listening(upstream), seen };
}

describe('rewriteDevtoolsUrls', () => {
  it('points loopback DevTools URLs at the caller host', () => {
    const body =
      '{"webSocketDebuggerUrl":"ws://127.0.0.1:9223/devtools/page/1","devtoolsFrontendUrl":"x?ws=localhost:9223/p"}';
    expect(rewriteDevtoolsUrls(body, 9223, 'tl-profile-abc:9222')).toBe(
      '{"webSocketDebuggerUrl":"ws://tl-profile-abc:9222/devtools/page/1","devtoolsFrontendUrl":"x?ws=tl-profile-abc:9222/p"}',
    );
  });
});

describe('createCdpFront', () => {
  it('serves /json/version to a non-loopback Host and rewrites the websocket URL', async () => {
    const { port: upPort, seen } = await fakeDevtools();
    const front = createCdpFront({ listenPort: 0, listenHost: '127.0.0.1', upstreamPort: upPort });
    servers.push(front);
    const port = await listening(front);

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port, path: '/json/version', headers: { host: 'tl-profile-abc:9222' } },
          (res) => {
            let s = '';
            res.on('data', (c) => {
              s += c;
            });
            res.on('end', () => resolve(s));
          },
        )
        .on('error', reject);
    });
    expect(seen.host).toBe(`127.0.0.1:${upPort}`);
    expect(JSON.parse(body).webSocketDebuggerUrl).toBe('ws://tl-profile-abc:9222/devtools/browser/abc');
  });

  it('pipes websocket upgrades with the Host rewritten', async () => {
    const { port: upPort, seen } = await fakeDevtools();
    const front = createCdpFront({ listenPort: 0, listenHost: '127.0.0.1', upstreamPort: upPort });
    servers.push(front);
    const port = await listening(front);

    const reply = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          'GET /devtools/browser/abc HTTP/1.1\r\nHost: tl-profile-abc:9222\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n') && !buf.includes('ping')) sock.write('ping');
        if (buf.includes('ping')) {
          sock.destroy();
          resolve(buf);
        }
      });
      sock.on('error', reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 101/);
    expect(reply).toContain('ping');
    expect(seen.upgradeHost).toBe(`127.0.0.1:${upPort}`);
  });

  it('answers 502 while the browser is not up yet', async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));

    const front = createCdpFront({ listenPort: 0, listenHost: '127.0.0.1', upstreamPort: deadPort });
    servers.push(front);
    const port = await listening(front);
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject);
    });
    expect(status).toBe(502);
  });
});
