import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type FakeCdpTarget, canLaunchChromium, startFakeCdpTarget } from '@threadline/node-testkit/fake-cdp';
import { readRedditPage } from '@threadline/node-testkit/fixtures';
import { WhoamiData } from '@threadline/shared';
import { chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { actionsModule } from '../handlers/actions';
import { SecretSet, createLogger } from '../log';
import type { HandlerContext } from '../registry';
import { StatusStore } from '../status';
import { testConfig } from '../testing/helpers';
import { createActionHandlers } from './index';
import { ActionError } from './session';
import { meUrl, parseMe } from './whoami';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../tests/fixtures/reddit-json/${name}`, import.meta.url), 'utf8');
const ME_LOGGED_IN = fixture('me-logged-in.json');
const ME_LOGGED_OUT = fixture('me-logged-out.json');
const SESSION_COOKIE = 'reddit_session=testkit-session-cookie-value';

const available = await canLaunchChromium();
if (!available) console.warn('node-agent whoami: no launchable Chromium, skipping CDP whoami tests');

describe('parseMe', () => {
  it('reads the identity from the recorded logged-in body', () => {
    expect(parseMe(JSON.parse(ME_LOGGED_IN))).toEqual({
      loggedIn: true,
      name: 'testkit_poster',
      id: '1a2b3c',
      totalKarma: 2160,
      createdUtc: 1546300800,
    });
  });

  it('treats a body without a name as nobody signed in', () => {
    expect(parseMe(JSON.parse(ME_LOGGED_OUT))).toEqual({ loggedIn: false });
    expect(parseMe({ data: {} })).toEqual({ loggedIn: false });
    expect(parseMe(null)).toEqual({ loggedIn: false });
    expect(parseMe([])).toEqual({ loggedIn: false });
  });

  it('accepts a flat body and a t2_-prefixed id, and drops odd optional fields', () => {
    expect(parseMe({ name: 'Leo-B', id: 't2_k9', total_karma: 1.5, created_utc: -1 })).toEqual({
      loggedIn: true,
      name: 'Leo-B',
      id: 'k9',
    });
  });

  it('refuses a name that is not a Reddit username, without echoing the body', () => {
    try {
      parseMe({ data: { name: 'not a <user>', id: 'abc', modhash: 'secret-ish' } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).code).toBe('whoami_unreadable');
      expect((err as ActionError).message).not.toContain('secret-ish');
    }
  });

  it('builds the me.json URL from the origin', () => {
    expect(meUrl('https://www.reddit.com')).toBe('https://www.reddit.com/api/me.json');
    expect(meUrl('http://127.0.0.1:4100/')).toBe('http://127.0.0.1:4100/api/me.json');
  });

  it('is registered in the actions module', () => {
    expect(Object.keys(actionsModule.handlers)).toContain('profile.whoami');
  });
});

type Mode =
  | 'session'
  | 'status401'
  | 'status403'
  | 'status500'
  | 'html'
  | 'login'
  | 'verification'
  | 'captcha';

describe.skipIf(!available)('profile.whoami over CDP', { timeout: 60_000 }, () => {
  let target: FakeCdpTarget;
  let server: Server;
  let origin: string;
  let mode: Mode = 'session';
  const seen: Array<{ path: string; cookie: string | undefined }> = [];
  let handlers: ReturnType<typeof createActionHandlers>;
  const logLines: string[] = [];

  function ctx(): HandlerContext {
    return {
      cmdId: 'bj-profile.whoami-prof_1',
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 20_000,
      log: createLogger({ level: 'debug', destination: { write: (s: string) => void logLines.push(s) } }),
      config: testConfig(),
      status: new StatusStore(8),
      secrets: new SecretSet(),
    };
  }
  const run = () => handlers['profile.whoami']!({ kind: 'profile.whoami', profileId: 'prof_1' }, ctx());

  async function withBrowser<T>(fn: (b: Awaited<ReturnType<typeof chromium.connectOverCDP>>) => Promise<T>) {
    const b = await chromium.connectOverCDP(target.cdpUrl);
    try {
      return await fn(b);
    } finally {
      await b.close();
    }
  }
  const openPages = () =>
    withBrowser(async (b) => b.contexts().flatMap((c) => c.pages().map((p) => p.url())));
  const setSessionCookie = (on: boolean) =>
    withBrowser(async (b) => {
      const c = b.contexts()[0]!;
      await c.clearCookies();
      if (on) {
        const [name, value] = SESSION_COOKIE.split('=') as [string, string];
        await c.addCookies([{ name, value, url: origin }]);
      }
    });

  beforeAll(async () => {
    target = await startFakeCdpTarget();
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      seen.push({ path, cookie: req.headers.cookie });
      const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
        res.end(body);
      };
      if (path === '/login/') return send(200, 'text/html', readRedditPage('loginWall'));
      if (path === '/account/verify/') return send(200, 'text/html', readRedditPage('verificationWall'));
      if (path !== '/api/me.json') return send(404, 'text/plain', 'not found');
      switch (mode) {
        case 'session': {
          const signedIn = (req.headers.cookie ?? '').includes(SESSION_COOKIE);
          return send(200, 'application/json', signedIn ? ME_LOGGED_IN : ME_LOGGED_OUT);
        }
        case 'status401':
          return send(401, 'application/json', '{"message":"Unauthorized","error":401}');
        case 'status403':
          return send(403, 'application/json', '{"message":"Forbidden","error":403}');
        case 'status500':
          return send(500, 'text/plain', 'upstream exploded');
        case 'html':
          return send(200, 'text/html', '<html><body>whoa there, pardner</body></html>');
        case 'login':
          return send(302, 'text/plain', '', { location: '/login/?dest=%2Fapi%2Fme.json' });
        case 'verification':
          return send(302, 'text/plain', '', { location: '/account/verify/' });
        case 'captcha':
          return send(200, 'text/html', readRedditPage('captchaWall'));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    handlers = createActionHandlers({
      cdpUrlFor: () => target.cdpUrl,
      proxyFor: () => null,
      redditOrigin: origin,
      stepTimeoutMs: 8_000,
    });
  });

  afterEach(async () => {
    mode = 'session';
    await setSessionCookie(false);
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    await target?.close();
  });

  it("reads the signed-in identity with the profile's own cookies and closes its tab", async () => {
    await setSessionCookie(true);
    const from = seen.length;
    logLines.length = 0;
    const r = await run();
    expect(r).toEqual({
      outcome: 'ok',
      data: {
        loggedIn: true,
        name: 'testkit_poster',
        id: '1a2b3c',
        totalKarma: 2160,
        createdUtc: 1546300800,
      },
    });
    expect(WhoamiData.safeParse(r.data).success).toBe(true);
    expect(seen.slice(from)).toEqual([{ path: '/api/me.json', cookie: SESSION_COOKIE }]);
    expect((await openPages()).some((u) => u.includes('/api/me.json'))).toBe(false);
    // Neither the body nor the cookie reaches the logs.
    const logs = logLines.join('');
    expect(logs).not.toContain('modhash');
    expect(logs).not.toContain('testkit-not-a-real-modhash');
    expect(logs).not.toContain('testkit-session-cookie-value');
  });

  it('reports loggedIn: false when the profile has no Reddit session', async () => {
    expect(await run()).toEqual({ outcome: 'ok', data: { loggedIn: false } });
  });

  it.each(['status401', 'status403'] as const)('reports loggedIn: false on %s', async (m) => {
    mode = m;
    expect(await run()).toEqual({ outcome: 'ok', data: { loggedIn: false } });
  });

  it('reports loggedIn: false when Reddit redirects me.json to the login page', async () => {
    mode = 'login';
    expect(await run()).toEqual({ outcome: 'ok', data: { loggedIn: false } });
    expect((await openPages()).some((u) => u.startsWith(`${origin}/login/`))).toBe(false);
  });

  it.each([
    ['verification', '/account/verify/'],
    ['captcha', '/api/me.json'],
  ] as const)(
    'stops at a %s wall with needs_human and leaves the tab for the take-over',
    async (wall, path) => {
      mode = wall;
      const r = await run();
      expect(r).toMatchObject({
        outcome: 'needs_human',
        data: { wall, submitted: false },
        error: { code: `${wall}_wall` },
      });
      const pages = await openPages();
      expect(pages.some((u) => u.startsWith(`${origin}${path}`))).toBe(true);
      // Close the kept tab so it does not linger into the next test.
      await withBrowser(async (b) => {
        for (const p of b.contexts()[0]!.pages()) if (p.url().startsWith(origin)) await p.close();
      });
    },
  );

  it('maps other HTTP errors and non-JSON bodies to stable codes without the body', async () => {
    mode = 'status500';
    const a = await run();
    expect(a).toMatchObject({ outcome: 'error', error: { code: 'whoami_http_error' } });
    expect(a.error?.message).toContain('500');
    expect(a.error?.message).not.toContain('exploded');

    mode = 'html';
    const b = await run();
    expect(b).toMatchObject({ outcome: 'error', error: { code: 'whoami_unreadable' } });
    expect(b.error?.message).not.toContain('pardner');
  });
});
