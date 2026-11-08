/**
 * Agent side of the VNC relay (docs/plans/0001-infra-implementation.md §3.4, T24).
 *
 * On `vnc.open` the agent makes a second outbound connection to the gateway and pipes it to the profile
 * container's websockify (`ws://tl-profile-<id>:6080/websockify` on the internal browser network). Nothing on the
 * node listens for inbound connections.
 *
 * The agent never dials a host it was not configured with: the upstream is always `GATEWAY_URL`'s origin plus
 * the `/vnc/<sessionId>` path from the command, whatever host `upstreamUrl` names. The token is a secret (it is
 * registered with the log scrubber by dispatch) and is never logged.
 */
import { type RawData, WebSocket } from 'ws';
import type { Logger } from './log';

export const VNC_PORT = 6080;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FRAME_BYTES = 32 << 20;
const HIGH_WATER = 4 << 20;
const LOW_WATER = 1 << 20;

export class VncError extends Error {
  constructor(
    readonly code: 'vnc_bad_command' | 'vnc_target_unreachable' | 'vnc_upstream_refused' | 'vnc_aborted',
    message: string,
  ) {
    super(message);
    this.name = 'VncError';
  }
}

/** websockify inside the profile container, reachable by container name on the browser network. */
export function websockifyUrl(profileId: string): string {
  if (!ID_RE.test(profileId)) throw new VncError('vnc_bad_command', 'invalid profile id');
  return `ws://tl-profile-${profileId}:${VNC_PORT}/websockify`;
}

/**
 * The URL the agent actually dials: `GATEWAY_URL`'s origin + `/vnc/<sessionId>?t=<token>`. `upstreamUrl` must
 * name the same session; its host is ignored (logged by the caller when it differs).
 */
export function resolveUpstream(
  gatewayUrl: string,
  cmd: { upstreamUrl: string; sessionId: string; token: string },
): { url: string; hostMatches: boolean } {
  if (!ID_RE.test(cmd.sessionId)) throw new VncError('vnc_bad_command', 'invalid session id');
  let given: URL;
  try {
    given = new URL(cmd.upstreamUrl);
  } catch {
    throw new VncError('vnc_bad_command', 'upstreamUrl is not a URL');
  }
  if (given.pathname !== `/vnc/${cmd.sessionId}`)
    throw new VncError('vnc_bad_command', 'upstreamUrl does not name the session');
  const gw = new URL(gatewayUrl);
  const url = new URL(`/vnc/${cmd.sessionId}`, gw.origin);
  url.searchParams.set('t', cmd.token);
  return { url: url.toString(), hostMatches: given.host === gw.host };
}

/**
 * RFB client → server messages that mean a human is at the controls: KeyEvent (type 4, 8 bytes) and
 * PointerEvent (type 5, 6 bytes); noVNC may batch several of one kind in a frame. FramebufferUpdateRequest and
 * the rest (sent continuously by the viewer) are not activity.
 */
export function isRfbInput(data: RawData): boolean {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  if (buf.length === 0) return false;
  if (buf[0] === 4) return buf.length % 8 === 0;
  if (buf[0] === 5) return buf.length % 6 === 0;
  return false;
}

type Sink = (data: RawData, isBinary: boolean) => void;

function dial(url: string, opts: { protocols?: string[]; timeoutMs: number; signal?: AbortSignal }) {
  return new Promise<{ ws: WebSocket; release(s: Sink): void }>((resolve, reject) => {
    const ws = new WebSocket(url, opts.protocols ?? [], {
      handshakeTimeout: opts.timeoutMs,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    // Buffer from the first byte: websockify forwards the RFB greeting as soon as it connects.
    const queue: [RawData, boolean][] = [];
    let sink: Sink | null = null;
    ws.on('message', (d, b) => (sink ? sink(d, b) : queue.push([d, b])));
    const onAbort = () => {
      ws.terminate();
      reject(new VncError('vnc_aborted', 'deadline passed'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    ws.once('open', () => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        ws,
        release(s) {
          sink = s;
          for (const [d, b] of queue.splice(0)) s(d, b);
        },
      });
    });
    ws.once('unexpected-response', (_req, res) => {
      opts.signal?.removeEventListener('abort', onAbort);
      ws.terminate();
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
    });
    ws.once('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
  });
}

function forwardableCode(code: number): number {
  if (code === 1005) return 1000;
  if (code === 1006) return 1001;
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999))
    return code;
  return 1011;
}

function closeQuietly(ws: WebSocket, code: number, reason = '') {
  if (ws.readyState === WebSocket.CLOSED) return;
  try {
    if (ws.readyState !== WebSocket.CLOSING) ws.close(forwardableCode(code), reason.slice(0, 120));
    setTimeout(() => ws.terminate(), 2_000).unref();
  } catch {
    ws.terminate();
  }
}

function forward(from: WebSocket, to: WebSocket, onFrame?: (d: RawData) => void): Sink {
  return (data, isBinary) => {
    if (to.readyState !== WebSocket.OPEN) return;
    onFrame?.(data);
    to.send(data, { binary: isBinary }, () => {
      if (from.isPaused && to.bufferedAmount < LOW_WATER) from.resume();
    });
    if (to.bufferedAmount > HIGH_WATER && !from.isPaused) from.pause();
  };
}

export interface VncPipe {
  sessionId: string;
  profileId: string;
  /** Resolves when both sockets are closed. */
  closed: Promise<void>;
  close(code?: number, reason?: string): void;
}

export interface OpenVncPipeOptions {
  gatewayUrl: string;
  profileId: string;
  sessionId: string;
  upstreamUrl: string;
  token: string;
  /** Default {@link websockifyUrl}. */
  targetUrl?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  log: Logger;
  /** Called for every viewer frame that is keyboard or pointer input. */
  onInput?: () => void;
}

/** Dials websockify, then the gateway, and pipes the two. Rejects with {@link VncError}. */
export async function openVncPipe(o: OpenVncPipeOptions): Promise<VncPipe> {
  const upstream = resolveUpstream(o.gatewayUrl, o);
  if (!upstream.hostMatches)
    o.log.warn({ sessionId: o.sessionId }, 'vnc upstream host differs from GATEWAY_URL; dialing GATEWAY_URL');
  const targetUrl = o.targetUrl ?? websockifyUrl(o.profileId);

  let target: Awaited<ReturnType<typeof dial>>;
  try {
    target = await dial(targetUrl, { protocols: ['binary'], timeoutMs: o.timeoutMs, signal: o.signal });
  } catch (e) {
    if (e instanceof VncError) throw e;
    throw new VncError(
      'vnc_target_unreachable',
      `profile display is not reachable (${(e as Error).message})`,
    );
  }
  let up: Awaited<ReturnType<typeof dial>>;
  try {
    up = await dial(upstream.url, { timeoutMs: o.timeoutMs, signal: o.signal });
  } catch (e) {
    target.ws.terminate();
    if (e instanceof VncError) throw e;
    const status = (e as { status?: number }).status;
    // Error messages from `ws` can quote the URL, which carries the token: never pass them on.
    throw new VncError(
      'vnc_upstream_refused',
      status ? `gateway refused the relay (HTTP ${status})` : 'gateway relay connection failed',
    );
  }

  const onceClosed = (ws: WebSocket) =>
    ws.readyState === WebSocket.CLOSED
      ? Promise.resolve()
      : new Promise<void>((r) => ws.once('close', () => r()));
  const closed = Promise.all([onceClosed(target.ws), onceClosed(up.ws)]).then(() => undefined);
  const wire = (x: WebSocket, y: WebSocket) => {
    x.once('close', (code, reason) => closeQuietly(y, code, reason.toString()));
    x.on('error', () => y.terminate());
  };
  wire(target.ws, up.ws);
  wire(up.ws, target.ws);
  target.release(forward(target.ws, up.ws));
  up.release(
    forward(up.ws, target.ws, (d) => {
      if (o.onInput && isRfbInput(d)) o.onInput();
    }),
  );
  o.log.info({ profileId: o.profileId, sessionId: o.sessionId }, 'vnc pipe open');
  void closed.then(() => o.log.info({ profileId: o.profileId, sessionId: o.sessionId }, 'vnc pipe closed'));

  return {
    sessionId: o.sessionId,
    profileId: o.profileId,
    closed,
    close(code = 1001, reason = '') {
      closeQuietly(up.ws, code, reason);
      closeQuietly(target.ws, code, reason);
    },
  };
}
