import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canLaunchChromium } from '@threadline/node-testkit/fake-cdp';
import type { ProxySpec } from '@threadline/shared';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../log';
import { ProxyAuthWatchers } from './proxy-watch';
import { type TestProxy, launchCdpBrowser, startHttpProxy } from './testing/proxies';

const USER = 'tl-user';
const PASS = 'p+ss/w0rd';

let echo: Server;
let echoUrl: string;
let proxy: TestProxy;

beforeAll(async () => {
  echo = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok ${req.url}`);
  });
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  echoUrl = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  proxy = await startHttpProxy(USER, PASS);
});

afterAll(async () => {
  await proxy?.close();
  echo?.closeAllConnections();
  await new Promise<void>((r) => echo?.close(() => r()));
});

const spec = (password = PASS): ProxySpec => ({
  protocol: 'http',
  host: '127.0.0.1',
  port: proxy.port,
  username: USER,
  password,
});

async function until(fn: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const available = await canLaunchChromium();

describe.skipIf(!available)(
  'ProxyAuthWatchers (proxy auth from launch, no sign-in dialog)',
  { timeout: 60_000 },
  () => {
    it('answers proxy challenges for the first tab and for tabs opened outside any action (VNC)', async () => {
      const browser = await launchCdpBrowser([
        `--proxy-server=http://127.0.0.1:${proxy.port}`,
        '--proxy-bypass-list=<-loopback>',
      ]);
      const creds = spec();
      const watchers = new ProxyAuthWatchers({
        cdpUrlFor: () => browser.cdpUrl,
        proxyFor: () => creds,
        log: createLogger({ level: 'silent' }),
        reconnectMs: 100,
      });
      try {
        watchers.watch('p');
        await until(() => watchers.covers('p'));

        // A tab opened the way a person would open one: no Playwright, no Fetch of its own.
        const from = proxy.hits.length;
        const r = await fetch(`${browser.cdpUrl}/json/new?${encodeURIComponent(`${echoUrl}/new-tab`)}`, {
          method: 'PUT',
        });
        expect(r.ok).toBe(true);
        await until(() => proxy.hits.slice(from).some((h) => h.authorized && h.target.endsWith('/new-tab')));

        // The tab that already existed when the watcher connected (the browser's first tab).
        const pw = await chromium.connectOverCDP(browser.cdpUrl);
        const first = pw.contexts()[0]?.pages()[0];
        expect(first).toBeDefined();
        const res = await first!.goto(`${echoUrl}/first-tab`);
        expect(res?.status()).toBe(200);
        expect(await res?.text()).toBe('ok /first-tab');
        await pw.close();

        watchers.unwatch('p');
        expect(watchers.covers('p')).toBe(false);
      } finally {
        watchers.clear();
        await browser.close();
      }
    });
  },
);
