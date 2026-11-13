/** Real Chromium over CDP: cookie export, clearing data and the extra start tabs (plan 0004 phase 4). */
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type FakeCdpTarget, canLaunchChromium, startFakeCdpTarget } from '@threadline/node-testkit/fake-cdp';
import { ExportCookiesData } from '@threadline/shared';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretSet, createLogger } from '../log';
import type { HandlerContext } from '../registry';
import { StatusStore } from '../status';
import { testConfig } from '../testing/helpers';
import { createActionHandlers } from './index';

const available = await canLaunchChromium();
const SECRET = 'export-cookie-secret-value-123';

describe.skipIf(!available)('browser data over CDP', { timeout: 60_000 }, () => {
  let target: FakeCdpTarget;
  let server: Server;
  let origin: string;
  let handlers: ReturnType<typeof createActionHandlers>;
  const logLines: string[] = [];
  const PROFILE = 'prof_data';

  const ctx = (): HandlerContext => ({
    cmdId: `c-${Math.random().toString(36).slice(2)}`,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 30_000,
    log: createLogger({ level: 'debug', destination: { write: (s: string) => void logLines.push(s) } }),
    config: testConfig(),
    status: new StatusStore(8),
    secrets: new SecretSet(),
  });
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: '127.0.0.1',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax' as const,
  });
  async function withContext<T>(fn: (c: import('playwright-core').BrowserContext) => Promise<T>) {
    const b = await chromium.connectOverCDP(target.cdpUrl);
    try {
      return await fn(b.contexts()[0]!);
    } finally {
      await b.close();
    }
  }

  beforeAll(async () => {
    target = await startFakeCdpTarget();
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/api/me.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>${path}</title><p>${path}</p>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    handlers = createActionHandlers({
      cdpUrlFor: () => target.cdpUrl,
      proxyFor: () => null,
      redditOrigin: origin,
      ipUrl: `${origin}/ip`,
    });
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    await target?.close();
  });

  it('exports every cookie in the import shape, and logs no value', async () => {
    await withContext((c) => c.addCookies([cookie('reddit_session', SECRET), cookie('theme', 'dark')]));
    const r = await handlers['profile.exportCookies']!(
      { kind: 'profile.exportCookies', profileId: PROFILE },
      ctx(),
    );
    expect(r.outcome).toBe('ok');
    const data = ExportCookiesData.parse(r.data);
    expect(data.cookies).toEqual(
      expect.arrayContaining([cookie('reddit_session', SECRET), cookie('theme', 'dark')]),
    );
    // The value is in the result (that is the point) and nowhere in the logs.
    expect(logLines.join('')).not.toContain(SECRET);
    expect(logLines.join('')).toContain('cookies exported');
  });

  it('clearing the cache alone keeps cookies; clearing cookies signs everything out', async () => {
    await withContext((c) => c.addCookies([cookie('reddit_session', SECRET)]));
    const cacheOnly = await handlers['profile.clearData']!(
      { kind: 'profile.clearData', profileId: PROFILE, cookies: false, cache: true },
      ctx(),
    );
    expect(cacheOnly).toEqual({ outcome: 'ok', data: { cookies: false, cache: true } });
    expect((await withContext((c) => c.cookies())).some((k) => k.name === 'reddit_session')).toBe(true);

    await handlers['profile.clearData']!(
      { kind: 'profile.clearData', profileId: PROFILE, cookies: true, cache: false },
      ctx(),
    );
    expect(await withContext((c) => c.cookies())).toEqual([]);
  });

  it('sign-in opens the extra start tabs once and keeps them', async () => {
    const run = () =>
      handlers['profile.signIn']!(
        {
          kind: 'profile.signIn',
          profileId: PROFILE,
          startUrl: `${origin}/start`,
          extraUrls: [`${origin}/mail`, `${origin}/shop/`],
        },
        ctx(),
      );
    const ours = async () =>
      (await withContext(async (c) => c.pages().map((p) => p.url())))
        .filter((u) => u.startsWith(origin))
        .map((u) => u.slice(origin.length))
        .sort();
    expect((await run()).outcome).toBe('ok');
    expect(await ours()).toEqual(['/mail', '/shop/', '/start']);
    // A second run adds a new start tab (as before) but no second copy of the extra tabs.
    expect((await run()).outcome).toBe('ok');
    expect((await ours()).filter((u) => u !== '/start')).toEqual(['/mail', '/shop/']);
  });
});
