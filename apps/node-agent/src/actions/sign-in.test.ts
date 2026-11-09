import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type FakeCdpTarget, canLaunchChromium, startFakeCdpTarget } from '@threadline/node-testkit/fake-cdp';
import { readRedditPage } from '@threadline/node-testkit/fixtures';
import { type CmdOf, WhoamiData } from '@threadline/shared';
import { chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { actionsModule } from '../handlers/actions';
import { SecretSet, createLogger } from '../log';
import type { HandlerContext } from '../registry';
import { StatusStore } from '../status';
import { testConfig } from '../testing/helpers';
import { createActionHandlers } from './index';
import { loginUrl } from './sign-in';
import { totp } from './totp';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../tests/fixtures/reddit-json/${name}`, import.meta.url), 'utf8');
const ME_LOGGED_IN = fixture('me-logged-in.json');
const ME_LOGGED_OUT = fixture('me-logged-out.json');

const SESSION = 'testkit-signin-session-cookie-value';
const USERNAME = 'testkit_poster';
const PASSWORD = 'testkit-Pa55word-not-real';
const TOTP_SECRET = 'GDKI AX2L WCTA C3JC';
const LOGIN_PAGE = readRedditPage('loginWall');

const OTP_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Log In | Reddit</title></head><body>
<main><h1>Enter the 6-digit code from your authenticator app</h1>
<form id="login-otp-form" action="/login/" method="post">
  <input name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
  <button type="submit" class="check">Check code</button>
</form>
__ERROR__
</main></body></html>`;
const PLAIN = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
const CAPTCHA_PAGE = `<!doctype html><html><head><title>Log In | Reddit</title></head><body>
<div class="g-recaptcha" style="width:300px;height:80px;border:1px solid #ccc">I'm not a robot</div></body></html>`;

const withError = (html: string, msg: string) =>
  html.includes('__ERROR__')
    ? html.replace('__ERROR__', `<p role="alert">${msg}</p>`)
    : html.replace('</form>', `</form><p role="alert">${msg}</p>`);

/** How the fake Reddit answers a correct username + password. */
type AfterPassword = 'session' | 'otp' | 'captcha' | 'verify' | 'stuck';

const available = await canLaunchChromium();
if (!available) console.warn('node-agent sign-in: no launchable Chromium, skipping CDP sign-in tests');

describe('sign-in helpers', () => {
  it('builds the login URL from the origin', () => {
    expect(loginUrl('https://www.reddit.com')).toBe('https://www.reddit.com/login/');
    expect(loginUrl('http://127.0.0.1:4100/')).toBe('http://127.0.0.1:4100/login/');
  });

  it('is registered in the actions module', () => {
    expect(Object.keys(actionsModule.handlers)).toContain('profile.signIn');
  });
});

describe.skipIf(!available)('profile.signIn over CDP', { timeout: 60_000 }, () => {
  let target: FakeCdpTarget;
  let server: Server;
  let origin: string;
  let afterPassword: AfterPassword = 'session';
  const seen: Array<{ method: string; path: string }> = [];
  const posted: Array<Record<string, string>> = [];
  let handlers: ReturnType<typeof createActionHandlers>;
  const logLines: string[] = [];

  function ctx(): HandlerContext {
    return {
      cmdId: `bj-profile.signIn-${Math.random().toString(36).slice(2)}`,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 30_000,
      log: createLogger({ level: 'debug', destination: { write: (s: string) => void logLines.push(s) } }),
      config: testConfig(),
      status: new StatusStore(8),
      secrets: new SecretSet(),
    };
  }
  const startUrl = () => `${origin}/r/testkit_sandbox/`;
  const run = (extra: Partial<CmdOf<'profile.signIn'>> = {}) =>
    handlers['profile.signIn']!(
      { kind: 'profile.signIn', profileId: 'prof_1', startUrl: startUrl(), ...extra },
      ctx(),
    );
  const creds = (o: { password?: string; totpSecret?: string } = {}) => ({
    credentials: { username: USERNAME, password: o.password ?? PASSWORD, totpSecret: o.totpSecret },
  });

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
  const ourPages = async () => (await openPages()).filter((u) => u.startsWith(origin));

  beforeAll(async () => {
    target = await startFakeCdpTarget();
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const method = req.method ?? 'GET';
      seen.push({ method, path });
      const signedIn = (req.headers.cookie ?? '').includes(`reddit_session=${SESSION}`);
      const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
        res.end(body);
      };
      const html = (body: string) => send(200, 'text/html', body);
      const signInAndGo = () =>
        send(302, 'text/plain', '', {
          location: '/',
          'set-cookie': `reddit_session=${SESSION}; Path=/; HttpOnly`,
        });

      if (path === '/api/me.json')
        return send(200, 'application/json', signedIn ? ME_LOGGED_IN : ME_LOGGED_OUT);
      if (path === '/account/verify/') return html(readRedditPage('verificationWall'));
      if (path === '/') return html(PLAIN('Reddit home'));
      if (path === '/r/testkit_sandbox/') return html(PLAIN('r/testkit_sandbox'));
      if (path !== '/login/') return send(404, 'text/plain', 'not found');
      if (method === 'GET')
        return signedIn ? send(302, 'text/plain', '', { location: '/' }) : html(LOGIN_PAGE);

      let raw = '';
      req.on('data', (c: Buffer) => {
        raw += c.toString();
      });
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(raw));
        posted.push(form);
        if (form.otp !== undefined) {
          const now = Date.now();
          const ok = [now, now - 30_000].some((t) => totp(TOTP_SECRET, t) === form.otp);
          return ok ? signInAndGo() : html(withError(OTP_PAGE, 'Invalid code. Try again.'));
        }
        if (form.username !== USERNAME || form.password !== PASSWORD)
          return html(withError(LOGIN_PAGE, 'Invalid username or password.'));
        switch (afterPassword) {
          case 'session':
            return signInAndGo();
          case 'otp':
            return html(OTP_PAGE.replace('__ERROR__', ''));
          case 'captcha':
            return html(CAPTCHA_PAGE);
          case 'verify':
            return send(302, 'text/plain', '', { location: '/account/verify/' });
          case 'stuck':
            return html(LOGIN_PAGE);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    handlers = createActionHandlers({
      cdpUrlFor: () => target.cdpUrl,
      proxyFor: () => null,
      redditOrigin: origin,
      stepTimeoutMs: 8_000,
      confirmTimeoutMs: 3_000,
      human: { sleep: async () => {} },
    });
  });

  afterEach(async () => {
    afterPassword = 'session';
    posted.length = 0;
    logLines.length = 0;
    await withBrowser(async (b) => {
      const c = b.contexts()[0]!;
      await c.clearCookies();
      for (const p of c.pages()) if (p.url().startsWith(origin)) await p.close();
    });
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    await target?.close();
  });

  const SIGNED_IN = {
    outcome: 'ok',
    data: { loggedIn: true, name: 'testkit_poster', id: '1a2b3c', totalKarma: 2160, createdUtc: 1546300800 },
  };

  function expectNoSecretsInLogs() {
    const logs = logLines.join('');
    expect(logs).not.toContain(SESSION);
    expect(logs).not.toContain(PASSWORD);
    expect(logs).not.toContain(TOTP_SECRET);
    expect(logs).not.toContain('modhash');
  }

  it('imports cookies, finds the account signed in, never touches the login form, keeps the start tab', async () => {
    const from = seen.length;
    const r = await run({
      cookies: [
        {
          name: 'reddit_session',
          value: SESSION,
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      ...creds(),
    });
    expect(r).toEqual(SIGNED_IN);
    expect(WhoamiData.safeParse(r.data).success).toBe(true);
    expect(seen.slice(from).some((s) => s.path === '/login/')).toBe(false);
    expect(posted).toEqual([]);
    expect(await ourPages()).toEqual([startUrl()]);
    expectNoSecretsInLogs();
  });

  it('opens the start tab and reports loggedIn: false when nobody is signed in and there are no credentials', async () => {
    const from = seen.length;
    expect(await run()).toEqual({ outcome: 'ok', data: { loggedIn: false } });
    expect(seen.slice(from).some((s) => s.path === '/login/')).toBe(false);
    expect(await ourPages()).toEqual([startUrl()]);
  });

  it('signs in with username and password', async () => {
    expect(await run(creds())).toEqual(SIGNED_IN);
    expect(posted).toEqual([{ username: USERNAME, password: PASSWORD }]);
    expect(await ourPages()).toEqual([startUrl()]);
    expectNoSecretsInLogs();
  });

  it('signs in with username, password and the TOTP code from the 2FA secret', async () => {
    afterPassword = 'otp';
    expect(await run(creds({ totpSecret: TOTP_SECRET }))).toEqual(SIGNED_IN);
    expect(posted).toHaveLength(2);
    expect(posted[1]!.otp).toMatch(/^\d{6}$/);
    expect(await ourPages()).toEqual([startUrl()]);
    expectNoSecretsInLogs();
    expect(logLines.join('')).not.toContain(posted[1]!.otp);
  });

  it('rejects a wrong password with signin_rejected, without the credentials in the message', async () => {
    const r = await run(creds({ password: 'wrong-Pa55word' }));
    expect(r).toMatchObject({ outcome: 'error', error: { code: 'signin_rejected' } });
    expect(r.error?.message).not.toContain('wrong-Pa55word');
    expect(r.error?.message).not.toContain(USERNAME);
    expect(logLines.join('')).not.toContain('wrong-Pa55word');
    // An error closes the tab, like the other actions.
    expect(await ourPages()).toEqual([]);
  });

  it('rejects a 2FA code generated from the wrong secret', async () => {
    afterPassword = 'otp';
    const r = await run(creds({ totpSecret: 'JBSWY3DPEHPK3PXP' }));
    expect(r).toMatchObject({ outcome: 'error', error: { code: 'signin_rejected' } });
    expect(r.error?.message).toContain('2FA');
  });

  it('hands a 2FA step without a secret to a human, tab kept', async () => {
    afterPassword = 'otp';
    const r = await run(creds());
    expect(r).toMatchObject({ outcome: 'needs_human', data: { wall: 'verification', submitted: false } });
    expect(await ourPages()).toEqual([loginUrl(origin)]);
  });

  it.each([
    ['captcha', 'captcha', '/login/'],
    ['verify', 'verification', '/account/verify/'],
    ['stuck', 'login', '/login/'],
  ] as const)('after the password, %s → needs_human (%s) with the tab kept', async (mode, wall, path) => {
    afterPassword = mode;
    const r = await run(creds({ totpSecret: TOTP_SECRET }));
    expect(r).toMatchObject({
      outcome: 'needs_human',
      data: { wall, submitted: false },
      error: { code: `${wall}_wall` },
    });
    expect(await ourPages()).toEqual([`${origin}${path}`]);
    expectNoSecretsInLogs();
  });
});
