/**
 * Profile-lifetime geolocation (plan 0004 phase 8). A browser reports a location only when a site asks and the
 * permission allows it; left alone, it would report where the node is.
 *
 * - `block`: the permission is denied for every site, browser-wide.
 * - `override`: every tab answers with the given coordinates (the proxy's place, or ones a person set). The
 *   permission itself stays "ask", so a site still gets nothing until someone allows it.
 *
 * This is its own CDP connection, separate from the proxy sign-in watcher, and it never pauses a tab: it attaches
 * without `waitForDebuggerOnStart`, so if it is slow or down, pages still load. The cost is a short window on a
 * brand-new tab before the override lands, which only matters to a site that asks the instant it opens.
 */
import WebSocket from 'ws';
import { cdpUrl } from '../docker';
import type { Logger } from '../log';

export type GeoSetting = { mode: 'block' } | { mode: 'override'; lat: number; lon: number; accuracy: number };

interface CdpMessage {
  id?: number;
  method?: string;
  params?: { sessionId?: string; targetInfo?: { type?: string } };
  sessionId?: string;
  error?: { message?: string };
}

export interface GeoWatcherOptions {
  cdpUrlFor: (profileId: string) => string;
  log?: Logger;
  reconnectMs?: number;
}

class GeoWatch {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;
  /** tabs the override was sent to (tests wait on this) */
  applied = 0;
  ready = false;

  constructor(
    private readonly profileId: string,
    private readonly geo: GeoSetting,
    private readonly o: {
      cdpUrlFor: (id: string) => string;
      reconnectMs: number;
      log: () => Logger | undefined;
    },
  ) {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.close();
  }

  private send(method: string, params: object = {}, sessionId?: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ id: this.nextId++, method, params, ...(sessionId ? { sessionId } : {}) }));
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
    } catch {
      return this.reconnect();
    }
    if (this.stopped) return;
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.ws = ws;
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.ready = false;
      this.reconnect();
    });
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('open', () => {
      if (this.geo.mode === 'block') {
        this.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied' });
      } else {
        // Never pauses a tab: no waitForDebuggerOnStart.
        this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      }
      this.ready = true;
      this.o.log()?.info({ profileId: this.profileId, mode: this.geo.mode }, 'geolocation setting applied');
    });
  }

  private onMessage(raw: string): void {
    let m: CdpMessage;
    try {
      m = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (m.method !== 'Target.attachedToTarget' || this.geo.mode !== 'override') return;
    const sessionId = m.params?.sessionId;
    if (!sessionId || m.params?.targetInfo?.type !== 'page') return;
    this.send(
      'Emulation.setGeolocationOverride',
      { latitude: this.geo.lat, longitude: this.geo.lon, accuracy: this.geo.accuracy },
      sessionId,
    );
    this.applied++;
  }

  private reconnect(): void {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), this.o.reconnectMs);
    this.retry.unref();
  }
}

/** One geolocation watcher per running profile that has a location setting. */
export class GeoWatchers {
  private readonly watches = new Map<string, GeoWatch>();
  private log: Logger | undefined;

  constructor(private readonly o: GeoWatcherOptions) {
    this.log = o.log;
  }

  useLogger(log: Logger): void {
    this.log = log;
  }

  /** Applies `geo` to the profile's browser from now on; `null` stops (the browser's default applies again). */
  set(profileId: string, geo: GeoSetting | null): void {
    this.watches.get(profileId)?.stop();
    this.watches.delete(profileId);
    if (!geo) return;
    this.watches.set(
      profileId,
      new GeoWatch(profileId, geo, {
        cdpUrlFor: this.o.cdpUrlFor,
        reconnectMs: this.o.reconnectMs ?? 2_000,
        log: () => this.log,
      }),
    );
  }

  /** Tabs the override reached so far (0 for `block` or an unknown profile). */
  applied(profileId: string): number {
    return this.watches.get(profileId)?.applied ?? 0;
  }

  ready(profileId: string): boolean {
    return this.watches.get(profileId)?.ready ?? false;
  }

  clear(): void {
    for (const id of [...this.watches.keys()]) this.set(id, null);
  }
}

export const geoWatchers = new GeoWatchers({ cdpUrlFor: cdpUrl });
