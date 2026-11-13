/** Real Chromium: the location setting reaches every tab, including ones opened later (plan 0004 phase 8). */
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type FakeCdpTarget, canLaunchChromium, startFakeCdpTarget } from '@threadline/node-testkit/fake-cdp';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GeoWatchers } from './geo-watch';

const available = await canLaunchChromium();

describe.skipIf(!available)('geolocation watcher', { timeout: 60_000 }, () => {
  let target: FakeCdpTarget;
  let server: Server;
  let origin: string;
  let watchers: GeoWatchers;

  beforeAll(async () => {
    target = await startFakeCdpTarget();
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>geo</title>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    // localhost is a secure context, which geolocation needs.
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    watchers = new GeoWatchers({ cdpUrlFor: () => target.cdpUrl, reconnectMs: 200 });
  });
  afterAll(async () => {
    watchers?.clear();
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    await target?.close();
  });

  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(ok()).toBe(true);
  };
  /** What a page that asks for its position gets, once the permission is granted. */
  async function positionInNewTab(grant: boolean): Promise<string> {
    const b = await chromium.connectOverCDP(target.cdpUrl);
    try {
      const ctx = b.contexts()[0]!;
      if (grant) await ctx.grantPermissions(['geolocation'], { origin });
      const before = watchers.applied('p1');
      const page = await ctx.newPage();
      await page.goto(`${origin}/`);
      if (grant) await until(() => watchers.applied('p1') > before);
      // A string, so this file needs no DOM types: it runs in the page.
      const out = await page.evaluate<string>(`new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (p) => resolve(p.coords.latitude.toFixed(2) + ',' + p.coords.longitude.toFixed(2)),
          (e) => resolve('error:' + e.code),
          { timeout: 4000 },
        );
      })`);
      await page.close();
      return out;
    } finally {
      await b.close();
    }
  }

  it('override: a tab opened later answers with the set coordinates', async () => {
    watchers.set('p1', { mode: 'override', lat: 38.72, lon: -9.14, accuracy: 5000 });
    await until(() => watchers.ready('p1'));
    expect(await positionInNewTab(true)).toBe('38.72,-9.14');
    // A second tab too: the watcher keeps attaching.
    expect(await positionInNewTab(true)).toBe('38.72,-9.14');
  });

  it('block: a site is refused (error 1 = permission denied)', async () => {
    watchers.set('p1', { mode: 'block' });
    await until(() => watchers.ready('p1'));
    expect(await positionInNewTab(false)).toBe('error:1');
  });

  it('cleared: the watcher is gone and nothing more is applied', () => {
    watchers.set('p1', null);
    expect(watchers.ready('p1')).toBe(false);
    expect(watchers.applied('p1')).toBe(0);
  });
});
