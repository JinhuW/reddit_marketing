import { describe, expect, it } from 'vitest';
import { CookieParseError, cookieDomains, parseCookieJson } from './cookies';
import { Cmd } from './node-protocol';
import { BrowserJobSchema } from './queues';

describe('parseCookieJson', () => {
  it('reads a Cookie-Editor export', () => {
    const out = parseCookieJson(
      JSON.stringify([
        {
          domain: '.reddit.com',
          expirationDate: 1_900_000_000.5,
          hostOnly: false,
          httpOnly: true,
          name: 'reddit_session',
          path: '/',
          sameSite: 'no_restriction',
          secure: true,
          session: false,
          storeId: '0',
          value: 'secret-value',
        },
        { domain: 'www.reddit.com', hostOnly: true, name: 'csv', value: '2', session: true, sameSite: null },
      ]),
    );
    expect(out).toEqual([
      {
        name: 'reddit_session',
        value: 'secret-value',
        domain: '.reddit.com',
        path: '/',
        expires: 1_900_000_000,
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
      {
        name: 'csv',
        value: '2',
        domain: 'www.reddit.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ]);
    expect(cookieDomains(out)).toEqual(['reddit.com', 'www.reddit.com']);
  });

  it('accepts { cookies: [...] }, millisecond expiries and `expires`', () => {
    const [c] = parseCookieJson(
      JSON.stringify({
        cookies: [{ name: 'a', value: 'b', domain: '.reddit.com', expires: 1_900_000_000_000 }],
      }),
    );
    expect(c?.expires).toBe(1_900_000_000);
  });

  it('downgrades SameSite=None without Secure to Lax (Chromium refuses it)', () => {
    const [c] = parseCookieJson('[{"name":"a","value":"b","domain":".reddit.com","sameSite":"None"}]');
    expect(c?.sameSite).toBe('Lax');
  });

  it.each([
    ['not json', /must be JSON/],
    ['{}', /array of cookies/],
    ['[]', /no cookies/],
    ['[{"value":"x","domain":".reddit.com"}]', /Cookie 1 has no name/],
    ['[{"name":"a","value":"x","domain":"bad domain"}]', /Cookie 1 \(a\) has no valid domain/],
  ])('refuses %s', (text, msg) => {
    expect(() => parseCookieJson(text)).toThrow(CookieParseError);
    expect(() => parseCookieJson(text)).toThrow(msg);
  });

  it('never echoes a cookie value in an error', () => {
    try {
      parseCookieJson('[{"name":"a","value":"TOP-SECRET","domain":"!!"}]');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('TOP-SECRET');
    }
  });
});

describe('profile.signIn', () => {
  it('is a browser job without secrets', () => {
    expect(BrowserJobSchema.parse({ kind: 'profile.signIn', workspaceId: 'w', profileId: 'p' })).toBeTruthy();
    expect(() =>
      BrowserJobSchema.parse({ kind: 'profile.signIn', workspaceId: 'w', profileId: 'p', password: 'x' }),
    ).toThrow();
  });

  it('is a node command with optional cookies and credentials', () => {
    expect(
      Cmd.parse({
        kind: 'profile.signIn',
        profileId: 'p',
        startUrl: 'https://www.reddit.com/',
        credentials: { username: 'u', password: 'pw', totpSecret: 'GDKIAX2LWCTAC3JC' },
      }).kind,
    ).toBe('profile.signIn');
  });
});
