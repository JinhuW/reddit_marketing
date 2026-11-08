/**
 * Profile-lifetime proxy authentication. The container's Chromium gets `--proxy-server` without credentials
 * (ADR-0001), so every request through an authenticated proxy gets a 407. Without a CDP client answering it,
 * Chromium shows its "Sign in: the proxy requires a username and password" dialog, and the owner sees that
 * dialog over VNC.
 *
 * As soon as a profile's browser is up, the agent keeps one browser-level CDP connection open. It auto-attaches
 * to every target (the first tab, tabs the owner opens over VNC, popups, out-of-process iframes and workers),
 * waiting for the debugger on start. On each target it enables `Fetch` with `handleAuthRequests` *before* the
 * target runs. So no request reaches the proxy before the challenge can be answered, and the dialog never appears.
 *
 * Credentials are read from the lookup on every challenge, so they stay only in agent memory. They are given only
 * to `Proxy` challenges, once per request. A second challenge means the proxy rejected them, and that challenge is
 * cancelled. A site's own HTTP auth challenge gets the browser's default handling: the owner can still use it,
 * and the site never receives the proxy password.
 */
import WebSocket from 'ws';
import { cdpUrl } from '../docker';
import type { Logger } from '../log';
import { type ProxyLookup, profileProxies } from './proxy-store';

export interface ProxyAuthWatcherOptions {
  cdpUrlFor: (profileId: string) => string;
  proxyFor: ProxyLookup;
  log?: Logger;
  /** Delay before reconnecting a dropped CDP connection while the profile is still watched; default 2 s. */
  reconnectMs?: number;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  error?: { message?: string };
  result?: Record<string, unknown>;
}

interface AttachedToTarget {
  sessionId: string;
  targetInfo: { type: string };
  waitingForDebugger: boolean;
}

interface AuthRequired {
  requestId: string;
  authChallenge?: { source?: 'Server' | 'Proxy' };
}

/** Targets that can make network requests of their own and nest further targets. */
const NESTING = new Set(['page', 'iframe']);
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
const FETCH = { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] };

class Watch {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, (m: CdpMessage) => void>();
  private readonly answered = new Set<string>();
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;
  ready = false;

  constructor(
    private readonly profileId: string,
    private readonly o: Required<Pick<ProxyAuthWatcherOptions, 'cdpUrlFor' | 'proxyFor' | 'reconnectMs'>> & {
      log: () => Logger | undefined;
    },
  ) {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.retry);
    this.ws?.close();
    this.ws = undefined;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let wsUrl: string;
    try {
      const res = await fetch(`${this.o.cdpUrlFor(this.profileId)}/json/version`, {
        signal: AbortSignal.timeout(5_000),
      });
      wsUrl = ((await res.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? '';
      if (!wsUrl) throw new Error('no webSocketDebuggerUrl');
    } catch (err) {
      this.o.log()?.warn({ profileId: this.profileId, err: msg(err) }, 'proxy auth: CDP not reachable');
      return this.reconnect();
    }
    if (this.stopped) return;
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.ws = ws;
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.ready = false;
      for (const done of this.pending.values()) done({ error: { message: 'closed' } });
      this.pending.clear();
      this.reconnect();
    });
    ws.on('open', async () => {
      // Existing targets attach too (not paused); new ones wait for the Fetch.enable below before they run.
      const r = await this.send('Target.setAutoAttach', AUTO_ATTACH);
      if (r.error) {
        this.o
          .log()
          ?.warn({ profileId: this.profileId, err: r.error.message }, 'proxy auth: auto-attach failed');
        ws.close();
        return;
      }
      this.ready = true;
      this.o
        .log()
        ?.info({ profileId: this.profileId }, 'proxy auth: answering proxy challenges for all tabs');
    });
  }

  private reconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), this.o.reconnectMs);
    this.retry.unref();
  }

  private send(method: string, params: object = {}, sessionId?: string): Promise<CdpMessage> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ error: { message: 'closed' } });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  private onMessage(text: string): void {
    let m: CdpMessage;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof m.id === 'number') {
      const done = this.pending.get(m.id);
      this.pending.delete(m.id);
      done?.(m);
      return;
    }
    const sid = m.sessionId;
    switch (m.method) {
      case 'Target.attachedToTarget':
        void this.onAttached(m.params as unknown as AttachedToTarget);
        return;
      case 'Fetch.requestPaused':
        void this.send('Fetch.continueRequest', { requestId: m.params?.requestId }, sid);
        return;
      case 'Fetch.authRequired':
        void this.onAuth(m.params as unknown as AuthRequired, sid);
        return;
    }
  }

  private async onAttached(p: AttachedToTarget): Promise<void> {
    const { sessionId } = p;
    if (NESTING.has(p.targetInfo.type)) await this.send('Target.setAutoAttach', AUTO_ATTACH, sessionId);
    // Some worker types have no Fetch domain; they still have to be resumed.
    await this.send('Fetch.enable', FETCH, sessionId);
    if (p.waitingForDebugger) await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }

  private async onAuth(p: AuthRequired, sessionId: string | undefined): Promise<void> {
    const first = !this.answered.has(p.requestId);
    this.answered.add(p.requestId);
    if (this.answered.size > 1_000) this.answered.clear();
    let authChallengeResponse: object;
    if (p.authChallenge?.source !== 'Proxy') {
      authChallengeResponse = { response: 'Default' };
    } else {
      const proxy = this.o.proxyFor(this.profileId);
      authChallengeResponse =
        first && proxy?.username
          ? { response: 'ProvideCredentials', username: proxy.username, password: proxy.password ?? '' }
          : { response: 'CancelAuth' };
      if (!first)
        this.o.log()?.warn({ profileId: this.profileId }, 'proxy auth: proxy rejected the credentials');
    }
    await this.send('Fetch.continueWithAuth', { requestId: p.requestId, authChallengeResponse }, sessionId);
  }
}

/** One watcher per running profile whose proxy needs credentials. */
export class ProxyAuthWatchers {
  private readonly watches = new Map<string, Watch>();
  private log: Logger | undefined;

  constructor(private readonly o: ProxyAuthWatcherOptions) {
    this.log = o.log;
  }

  useLogger(log: Logger): void {
    this.log = log;
  }

  /** Start answering proxy challenges for `profileId`'s browser. Idempotent. */
  watch(profileId: string): void {
    if (this.watches.has(profileId)) return;
    this.watches.set(
      profileId,
      new Watch(profileId, {
        cdpUrlFor: this.o.cdpUrlFor,
        proxyFor: this.o.proxyFor,
        reconnectMs: this.o.reconnectMs ?? 2_000,
        log: () => this.log,
      }),
    );
  }

  unwatch(profileId: string): void {
    this.watches.get(profileId)?.stop();
    this.watches.delete(profileId);
  }

  /** True while the watcher is connected and auto-attaching: new tabs already get proxy auth. */
  covers(profileId: string): boolean {
    return this.watches.get(profileId)?.ready ?? false;
  }

  clear(): void {
    for (const id of [...this.watches.keys()]) this.unwatch(id);
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The agent-wide watchers. The profile module watches a profile once its browser is up. */
export const proxyAuthWatchers = new ProxyAuthWatchers({
  cdpUrlFor: cdpUrl,
  proxyFor: profileProxies.lookup,
});
