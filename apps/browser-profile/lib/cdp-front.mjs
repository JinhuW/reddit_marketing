// CDP front proxy. Chromium serves DevTools only to requests whose Host header is an IP or `localhost`, and
// recent builds bind it to loopback. The node agent dials `tl-profile-<id>:9222` on the internal Docker network,
// so this proxy listens there, forwards to the browser's loopback port with `Host: 127.0.0.1:<port>`, and
// rewrites the `webSocketDebuggerUrl` values in /json answers back to the host the caller used.
// The port is never published on the node host (plan §3.4, ADR-0001).
import http from 'node:http';
import net from 'node:net';

/**
 * Rewrites loopback DevTools URLs in a /json body to the caller's host.
 * @param {string} body
 * @param {number} upstreamPort
 * @param {string} publicHost  value of the caller's Host header, e.g. `tl-profile-abc:9222`
 */
export function rewriteDevtoolsUrls(body, upstreamPort, publicHost) {
  return body
    .split(`127.0.0.1:${upstreamPort}`)
    .join(publicHost)
    .split(`localhost:${upstreamPort}`)
    .join(publicHost);
}

/**
 * Raw HTTP/1.1 request head for an upgrade, with the Host header replaced.
 * @param {http.IncomingMessage} req
 * @param {string} upstreamHost
 */
export function upgradeHead(req, upstreamHost) {
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    const name = /** @type {string} */ (raw[i]);
    if (name.toLowerCase() === 'host') continue;
    lines.push(`${name}: ${raw[i + 1]}`);
  }
  lines.push(`Host: ${upstreamHost}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * @param {{ listenPort: number, listenHost?: string, upstreamPort: number, upstreamHost?: string }} opts
 * @returns {http.Server}
 */
export function createCdpFront({
  listenPort,
  listenHost = '0.0.0.0',
  upstreamPort,
  upstreamHost = '127.0.0.1',
}) {
  const upstream = `${upstreamHost}:${upstreamPort}`;

  const server = http.createServer((req, res) => {
    const publicHost = req.headers.host || `localhost:${listenPort}`;
    const headers = { ...req.headers, host: upstream };
    const up = http.request(
      { host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers },
      (upRes) => {
        const isJson = (req.url || '').startsWith('/json');
        if (!isJson) {
          res.writeHead(upRes.statusCode || 502, upRes.headers);
          upRes.pipe(res);
          return;
        }
        /** @type {Buffer[]} */
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          const body = rewriteDevtoolsUrls(Buffer.concat(chunks).toString('utf8'), upstreamPort, publicHost);
          const { 'transfer-encoding': _te, ...rest } = upRes.headers;
          const h = { ...rest, 'content-length': String(Buffer.byteLength(body)) };
          res.writeHead(upRes.statusCode || 502, h);
          res.end(body);
        });
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('browser not ready');
    });
    req.pipe(up);
  });

  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(upstreamPort, upstreamHost, () => {
      up.write(upgradeHead(req, upstream));
      if (head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    const close = () => {
      socket.destroy();
      up.destroy();
    };
    up.on('error', close);
    socket.on('error', close);
    up.on('close', close);
    socket.on('close', close);
  });

  server.listen(listenPort, listenHost);
  return server;
}
