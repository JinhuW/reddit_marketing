// Minimal Chrome DevTools Protocol client on Node's built-in WebSocket and fetch (Node 22+), so the probe runs on a
// browser node with nothing but Node installed. Flat sessions only (Target.attachToTarget with flatten).

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };
type Listener = (params: Record<string, unknown>, sessionId?: string) => void;

export class CdpError extends Error {}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private closed = false;
  private readonly ws: WebSocket;

  // No parameter properties: the probe runs under Node's type stripping, which does not support them.
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new CdpError(`socket closed during ${p.method}`));
      this.pending.clear();
    });
  }

  /** `httpUrl` is the DevTools HTTP endpoint, e.g. `http://127.0.0.1:9222`. */
  static async connect(httpUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
    const res = await fetch(new URL('/json/version', httpUrl), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new CdpError(`/json/version answered ${res.status}`);
    const info = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) throw new CdpError('no webSocketDebuggerUrl in /json/version');
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new CdpError('websocket open timed out')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new CdpError('websocket failed to open'));
      });
    });
    return new CdpClient(ws);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(`socket closed before ${method}`));
    const id = this.nextId++;
    const frame: Record<string, unknown> = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify(frame));
    });
  }

  on(event: string, fn: Listener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(text: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(`${p.method}: ${msg.error.message ?? 'error'}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {}, msg.sessionId);
    }
  }
}

export interface ProxyAuth {
  username: string;
  password: string;
}

/**
 * Opens a fresh page target and attaches to it. When `auth` is given, proxy challenges are answered over
 * `Fetch.authRequired`, the same way the node agent does it (plan §4 T22), so credentials never reach argv.
 */
export async function openPage(client: CdpClient, auth?: ProxyAuth): Promise<string> {
  const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await client.send('Page.enable', {}, sessionId);
  if (auth) {
    client.on('Fetch.requestPaused', (p, sid) => {
      if (sid !== sessionId) return;
      void client.send('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => {});
    });
    client.on('Fetch.authRequired', (p, sid) => {
      if (sid !== sessionId) return;
      const challenge = p.authChallenge as { source?: string } | undefined;
      const response =
        challenge?.source === 'Proxy'
          ? { response: 'ProvideCredentials', username: auth.username, password: auth.password }
          : { response: 'CancelAuth' };
      void client
        .send(
          'Fetch.continueWithAuth',
          { requestId: p.requestId, authChallengeResponse: response },
          sessionId,
        )
        .catch(() => {});
    });
    await client.send(
      'Fetch.enable',
      { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] },
      sessionId,
    );
  }
  return sessionId;
}

export async function navigate(client: CdpClient, sessionId: string, url: string, timeoutMs = 30_000) {
  const r = await client.send<{ errorText?: string }>('Page.navigate', { url }, sessionId, timeoutMs);
  if (r.errorText) throw new CdpError(`navigation to ${url} failed: ${r.errorText}`);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const state = await evaluate<string>(client, sessionId, 'document.readyState');
    if (state === 'complete') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new CdpError(`navigation to ${url} did not complete`);
}

export async function evaluate<T>(client: CdpClient, sessionId: string, expression: string): Promise<T> {
  const r = await client.send<{
    result: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) {
    throw new CdpError(
      `page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'error'}`,
    );
  }
  return r.result.value as T;
}
