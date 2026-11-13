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

describe('other cookie formats (plan 0004)', () => {
  const NETSCAPE = [
    '# Netscape HTTP Cookie File',
    '.reddit.com\tTRUE\t/\tTRUE\t1798000000\treddit_session\tabc%2Cdef',
    '#HttpOnly_www.reddit.com\tFALSE\t/\tTRUE\t0\ttoken_v2\tsecret\twith\ttabs',
    '',
  ].join('\n');

  it('reads a cookies.txt file, HttpOnly lines and session cookies included', async () => {
    const { parseCookieText } = await import('./cookies');
    expect(parseCookieText(NETSCAPE)).toEqual([
      {
        name: 'reddit_session',
        value: 'abc%2Cdef',
        domain: '.reddit.com',
        path: '/',
        expires: 1798000000,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      },
      {
        name: 'token_v2',
        value: 'secret\twith\ttabs',
        domain: 'www.reddit.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
  });

  it('reads name=value pairs under the default domain and still reads JSON', async () => {
    const { parseCookieText } = await import('./cookies');
    const pairs = parseCookieText('Cookie: a=1; b=two=2', { defaultDomain: '.example.com' });
    expect(pairs.map((c) => [c.name, c.value, c.domain])).toEqual([
      ['a', '1', '.example.com'],
      ['b', 'two=2', '.example.com'],
    ]);
    expect(parseCookieText('a=1')[0]?.domain).toBe('.reddit.com');
    expect(parseCookieText('[{"name":"a","value":"1","domain":".reddit.com"}]')).toHaveLength(1);
  });

  it('refuses text that is none of the three, without echoing it', async () => {
    const { parseCookieText, CookieParseError } = await import('./cookies');
    for (const bad of ['just some words secret-value', '.reddit.com\tTRUE\t/\tTRUE'])
      try {
        parseCookieText(bad);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CookieParseError);
        expect((e as Error).message).not.toContain('secret-value');
      }
  });

  it('exports round-trip through both formats', async () => {
    const { parseCookieText, cookiesToJson, cookiesToNetscape } = await import('./cookies');
    const cookies = parseCookieText(NETSCAPE);
    expect(parseCookieText(cookiesToNetscape(cookies))).toEqual(cookies);
    expect(parseCookieText(cookiesToJson(cookies))).toEqual(cookies);
  });
});
