/**
 * Authenticated VNC websocket proxy (infra plan T23, ADR-0001 "VNC take-over", PLAN §10 Security).
 *
 *   browser (noVNC RFB) ──ws /api/vnc/<profileId>──▶ web (this module) ──ws, private network──▶ node-gateway
 *     ${NODE_GATEWAY_URL}/internal/vnc/<profileId>?session=…&member=…&exp=…&sig=…
 *
 * The gateway (T24) then asks the node agent to dial back and pipes to the profile container's websockify.
 * Nothing here talks to a container or a node directly, and browser containers publish no ports.
 *
 * Per upgrade: same-origin check → authorize (session cookie → member, `canControlProfile`, open or start the
 * human BrowserSession, which writes `session.started`) → dial the gateway with an HMAC-signed URL → only then
 * complete the browser's handshake and pipe frames both ways. Either side closing closes the other.
 */
import { type IncomingMessage, STATUS_CODES, request } from 'node:http';
import type { Duplex } from 'node:stream';
import { VNC_TOKEN_TTL_SEC } from '@threadline/shared';
import {
  INTERNAL_URL_MAX_TTL_SEC,
  INTERNAL_VNC_PREFIX,
  type InternalCheck,
  signInternalVncUrl,
  verifyInternalVncUrl,
} from '@threadline/shared/vnc-sign';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { VNC_AUTHZ_HEADER, type VncGrant } from './vnc-authz';

/** `/api/vnc/<profileId>`; profile ids are cuids. */
const VNC_PATH = /^\/api\/vnc\/([A-Za-z0-9_-]{1,64})\/?$/;

export function vncProfileIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split('?', 1)[0] ?? '';
  return VNC_PATH.exec(path)?.[1] ?? null;
}

// ── web → gateway signature ───────────────────────────────────────────────────────────────────────────
//
// GET (websocket upgrade) ${NODE_GATEWAY_URL}/internal/vnc/<profileId>?session=<id>&exp=<unix s>&sig=<b64url>
// The signature scheme lives in packages/shared/src/vnc-sign.ts and the gateway verifies with the same code.

export const GATEWAY_VNC_PATH = INTERNAL_VNC_PREFIX;

/** The gateway URL for one VNC connection, as a ws:// or wss:// URL. */
export function signGatewayVncUrl(input: {
  gatewayUrl: string;
  secret: string;
  profileId: string;
  sessionId: string;
  nowMs?: number;
  ttlSec?: number;
}): string {
  const url = new URL(input.gatewayUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  const signed = new URL(
    signInternalVncUrl(input.secret, {
      profileId: input.profileId,
      sessionId: input.sessionId,
      now: input.nowMs,
      ttlSec: input.ttlSec ?? Math.min(VNC_TOKEN_TTL_SEC, INTERNAL_URL_MAX_TTL_SEC),
    }),
    'ws://gateway.local',
  );
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${signed.pathname}`;
  url.search = signed.search;
  return url.toString();
}

/** Checks a URL from {@link signGatewayVncUrl} exactly as the gateway does (tests, diagnostics). */
export function verifyGatewayVncUrl(url: string | URL, secret: string, nowMs = Date.now()): InternalCheck {
  const u = typeof url === 'string' ? new URL(url, 'ws://gateway.local') : url;
  const idx = u.pathname.lastIndexOf(GATEWAY_VNC_PATH);
  const local = new URL(`${idx >= 0 ? u.pathname.slice(idx) : u.pathname}${u.search}`, 'ws://gateway.local');
  return verifyInternalVncUrl(secret, local, nowMs);
}

// ── upgrade handling ──────────────────────────────────────────────────────────────────────────────────

export type AuthorizeResult = { ok: true; grant: VncGrant } | { ok: false; status: number };
export type Authorize = (req: IncomingMessage, profileId: string) => Promise<AuthorizeResult>;

export interface VncProxyOptions {
  /** Private URL of the gateway (`NODE_GATEWAY_URL`). Unset → every upgrade is refused with 503. */
  gatewayUrl: string | undefined;
  /** `GATEWAY_INTERNAL_SECRET`. Unset → 503. Never logged. */
  secret: string | undefined;
  authorize: Authorize;
  /** Extra origins allowed besides the request's own host (e.g. `APP_URL`). */
  allowedOrigins?: string[];
  /** How long to wait for the gateway (it waits up to 10 s for the agent to dial back). */
  connectTimeoutMs?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface VncProxy {
  /** Handles an upgrade on `/api/vnc/<profileId>`; returns false (and leaves the socket alone) for other paths. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Closes every open pipe. */
  close(): void;
}

function refuse(socket: Duplex, status: number) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();

/**
 * Cross-site websocket hijacking guard: browsers attach cookies to websocket handshakes from any page,
 * so the Origin must be this app (the request's own host, or one of `allowed`).
 */
export function originAllowed(req: IncomingMessage, allowed: string[] = []): boolean {
  const origin = first(req.headers.origin);
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const reqHost = first(req.headers['x-forwarded-host']) ?? first(req.headers.host);
  if (reqHost && host === reqHost) return true;
  return allowed.some((a) => {
    try {
      return new URL(a).host === host;
    } catch {
      return false;
    }
  });
}

/** Close codes a peer may send on; anything else (1005, 1006, 1015, …) becomes 1000. */
const sendableCode = (code: number) =>
  (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
    ? code
    : 1000;

function closeWith(ws: WebSocket, code: number, reason: Buffer) {
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  if (ws.readyState === WebSocket.CONNECTING) return ws.terminate();
  ws.close(sendableCode(code), reason.length <= 123 ? reason : undefined);
}

/** Pipes two open websockets; frames keep their text/binary type; either closing closes the other. */
export function pipeSockets(a: WebSocket, b: WebSocket) {
  a.on('message', (data, isBinary) => {
    if (b.readyState === WebSocket.OPEN) b.send(data, { binary: isBinary });
  });
  b.on('message', (data, isBinary) => {
    if (a.readyState === WebSocket.OPEN) a.send(data, { binary: isBinary });
  });
  a.on('close', (code, reason) => closeWith(b, code, reason));
  b.on('close', (code, reason) => closeWith(a, code, reason));
  a.on('error', () => b.terminate());
  b.on('error', () => a.terminate());
}

export function createVncProxy(opts: VncProxyOptions): VncProxy {
  const log = opts.log ?? (() => {});
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const live = new Set<WebSocket>();
  const timeoutMs = opts.connectTimeoutMs ?? 15_000;

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, profileId: string) {
    if (!opts.gatewayUrl || !opts.secret) return refuse(socket, 503);
    if (!originAllowed(req, opts.allowedOrigins)) {
      log('vnc.refused', { profileId, status: 403, why: 'origin' });
      return refuse(socket, 403);
    }
    let auth: AuthorizeResult;
    try {
      auth = await opts.authorize(req, profileId);
    } catch (e) {
      log('vnc.authorize_failed', { profileId, err: (e as Error).message });
      return refuse(socket, 502);
    }
    if (!auth.ok) {
      log('vnc.refused', { profileId, status: auth.status });
      return refuse(socket, auth.status);
    }
    if (socket.destroyed) return;
    const { grant } = auth;

    const upstreamUrl = signGatewayVncUrl({
      gatewayUrl: opts.gatewayUrl,
      secret: opts.secret,
      profileId,
      sessionId: grant.sessionId,
    });
    const upstream = new WebSocket(upstreamUrl, { handshakeTimeout: timeoutMs, perMessageDeflate: false });
    const early: [RawData, boolean][] = [];
    const hold = (data: RawData, isBinary: boolean) => early.push([data, isBinary]);
    upstream.on('message', hold);
    const abandon = () => upstream.terminate();
    socket.once('close', abandon);

    upstream.once('unexpected-response', (_r, res) => {
      log('vnc.gateway_refused', { profileId, sessionId: grant.sessionId, status: res.statusCode });
      upstream.terminate();
      refuse(socket, res.statusCode === 404 || res.statusCode === 409 ? res.statusCode : 502);
    });
    upstream.once('error', (e) => {
      if (socket.destroyed) return;
      const timedOut = /timed out/i.test(e.message);
      log('vnc.gateway_error', { profileId, sessionId: grant.sessionId, timedOut });
      refuse(socket, timedOut ? 504 : 502);
    });
    upstream.once('open', () => {
      socket.off('close', abandon);
      if (socket.destroyed) return upstream.terminate();
      wss.handleUpgrade(req, socket, head, (client) => {
        upstream.off('message', hold);
        live.add(client);
        live.add(upstream);
        client.once('close', () => live.delete(client));
        upstream.once('close', () => live.delete(upstream));
        log('vnc.open', { profileId, sessionId: grant.sessionId, memberId: grant.memberId });
        pipeSockets(client, upstream);
        for (const [data, isBinary] of early) client.send(data, { binary: isBinary });
        client.once('close', (code) => log('vnc.closed', { profileId, sessionId: grant.sessionId, code }));
      });
    });
  }

  return {
    handleUpgrade(req, socket, head) {
      const profileId = vncProfileIdFromUrl(req.url);
      if (!profileId) return false;
      socket.on('error', () => socket.destroy());
      upgrade(req, socket, head, profileId).catch((e) => {
        log('vnc.failed', { profileId, err: (e as Error).message });
        refuse(socket, 500);
      });
      return true;
    },
    close() {
      for (const ws of live) ws.terminate();
      live.clear();
      wss.close();
    },
  };
}

// ── authorization through the route handler ──────────────────────────────────────────────────────────

const FORWARDED = [
  'cookie',
  'host',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-for',
  'user-agent',
];

/**
 * Asks this process's own `POST /api/vnc/<profileId>` (see vnc-authz.ts) whether the upgrade's cookies belong
 * to a member who may control the profile. Forwards the proxy headers so Auth.js reads the same cookie name
 * (`__Secure-` behind HTTPS) it would for the page.
 */
export function routeAuthorizer(opts: { port: number; key: string; timeoutMs?: number }): Authorize {
  return (req, profileId) =>
    new Promise<AuthorizeResult>((resolve, reject) => {
      const headers: Record<string, string> = { [VNC_AUTHZ_HEADER]: opts.key, 'content-length': '0' };
      for (const h of FORWARDED) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      const r = request(
        {
          host: '127.0.0.1',
          port: opts.port,
          method: 'POST',
          path: `/api/vnc/${encodeURIComponent(profileId)}`,
          headers,
          timeout: opts.timeoutMs ?? 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode ?? 500;
            if (status !== 200) return resolve({ ok: false, status: status >= 400 ? status : 502 });
            try {
              const g = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<VncGrant>;
              if (!g.sessionId || !g.memberId || !g.workspaceId || g.profileId !== profileId)
                return resolve({ ok: false, status: 502 });
              resolve({ ok: true, grant: g as VncGrant });
            } catch {
              resolve({ ok: false, status: 502 });
            }
          });
          res.on('error', reject);
        },
      );
      r.on('timeout', () => r.destroy(new Error('authorize timed out')));
      r.on('error', reject);
      r.end();
    });
}
