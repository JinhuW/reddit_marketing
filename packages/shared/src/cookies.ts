/**
 * Cookie import for standalone browsers (docs/plans/0003-standalone-browsers.md).
 *
 * People paste the JSON that browser extensions and anti-detect tools export (Cookie-Editor, EditThisCookie,
 * AdsPower, …): an array of `{ name, value, domain, path, expirationDate | expires, httpOnly, secure, sameSite }`.
 * {@link parseCookieJson} turns that into {@link BrowserCookie}s, the shape Playwright's `context.addCookies` takes.
 * Cookie values are secrets: never put them in errors, logs or audit meta.
 */
import { z } from 'zod';

export const MAX_COOKIES = 500;
/** Characters of pasted JSON accepted. */
export const MAX_COOKIE_JSON = 256_000;

export const BrowserCookie = z
  .object({
    name: z.string().min(1).max(256),
    value: z.string().max(8192),
    /** `.reddit.com` or `www.reddit.com` */
    domain: z.string().min(1).max(253),
    path: z.string().min(1).max(1024),
    /** epoch seconds; -1 = session cookie */
    expires: z.number(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(['Strict', 'Lax', 'None']),
  })
  .strict();
export type BrowserCookie = z.infer<typeof BrowserCookie>;

export class CookieParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CookieParseError';
  }
}

/**
 * Parses pasted cookie JSON. Accepts an array, or an object with a `cookies` array. Errors name the cookie's
 * position and field, never its value.
 */
export function parseCookieJson(text: string): BrowserCookie[] {
  if (text.length > MAX_COOKIE_JSON) throw new CookieParseError('Cookie JSON is too large.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CookieParseError('Cookie must be JSON: an array of cookies as your cookie export gives it.');
  }
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.cookies) ? raw.cookies : null;
  if (!list) throw new CookieParseError('Cookie JSON must be an array of cookies.');
  if (list.length === 0) throw new CookieParseError('Cookie JSON has no cookies.');
  if (list.length > MAX_COOKIES) throw new CookieParseError(`At most ${MAX_COOKIES} cookies.`);
  return list.map((c, i) => normalizeCookie(c, i));
}

function normalizeCookie(c: unknown, i: number): BrowserCookie {
  const at = `Cookie ${i + 1}`;
  if (!isRecord(c)) throw new CookieParseError(`${at} is not an object.`);
  const name = c.name;
  if (typeof name !== 'string' || !name) throw new CookieParseError(`${at} has no name.`);
  if (typeof c.value !== 'string') throw new CookieParseError(`${at} (${safeName(name)}) has no value.`);
  const domainRaw = typeof c.domain === 'string' ? c.domain.trim() : '';
  if (!/^\.?[A-Za-z0-9.-]+$/.test(domainRaw))
    throw new CookieParseError(`${at} (${safeName(name)}) has no valid domain.`);
  // Cookie-Editor marks host-only cookies with `hostOnly: true`; Playwright reads a leading dot as "subdomains too".
  const domain = c.hostOnly === true ? domainRaw.replace(/^\./, '') : domainRaw;
  const session = c.session === true;
  const exp = num(c.expirationDate) ?? num(c.expires) ?? num(c.expiry);
  const out = {
    name,
    value: c.value,
    domain,
    path: typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/',
    expires: session || exp === undefined || exp <= 0 ? -1 : Math.floor(exp > 1e11 ? exp / 1000 : exp),
    httpOnly: c.httpOnly === true,
    secure: c.secure === true,
    sameSite: sameSite(c.sameSite),
  };
  // Chromium refuses SameSite=None without Secure.
  if (out.sameSite === 'None' && !out.secure) out.sameSite = 'Lax';
  const parsed = BrowserCookie.safeParse(out);
  if (!parsed.success) throw new CookieParseError(`${at} (${safeName(name)}) is not a valid cookie.`);
  return parsed.data;
}

function sameSite(v: unknown): BrowserCookie['sameSite'] {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return 'None';
  return 'Lax';
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Cookie names are not secret, but keep messages short and printable. */
function safeName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Domains the cookies are for, for display ("reddit.com · 12 cookies"). */
export function cookieDomains(cookies: BrowserCookie[]): string[] {
  return [...new Set(cookies.map((c) => c.domain.replace(/^\./, '')))].sort();
}

// ── other formats (plan 0004 phase 4) ──

/** `# Netscape HTTP Cookie File` lines: domain, subdomains flag, path, secure, expiry, name, value (tab separated). */
function parseNetscape(text: string): BrowserCookie[] {
  const rows: Record<string, unknown>[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    let httpOnly = false;
    // curl and wget mark HttpOnly cookies with this prefix on an otherwise normal line.
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice('#HttpOnly_'.length);
    } else if (!line.trim() || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7)
      throw new CookieParseError(`Cookie line ${rows.length + 1} does not have 7 tab-separated fields.`);
    const [domain, subdomains, path, secure, expiry, name] = f;
    rows.push({
      domain,
      hostOnly: subdomains?.toUpperCase() !== 'TRUE' && !domain?.startsWith('.'),
      path,
      secure: secure?.toUpperCase() === 'TRUE',
      expires: Number(expiry) || 0,
      name,
      // A value may itself contain tabs.
      value: f.slice(6).join('\t'),
      httpOnly,
    });
  }
  return rows.map((c, i) => normalizeCookie(c, i));
}

/** A `Cookie:` header value, `name=value; other=value`, for one site. */
function parseHeader(text: string, domain: string): BrowserCookie[] {
  const body = text.replace(/^\s*cookie:\s*/i, '');
  const rows = body
    .split(/;\s*|\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      if (i <= 0) throw new CookieParseError('Cookie must be JSON, a cookies.txt file, or name=value pairs.');
      return { name: p.slice(0, i).trim(), value: p.slice(i + 1), domain, path: '/', secure: true };
    });
  return rows.map((c, i) => normalizeCookie(c, i));
}

/**
 * Parses what a person pastes into the Cookie box, whichever of the three common exports it is:
 * JSON (Cookie-Editor, EditThisCookie, AdsPower), a Netscape `cookies.txt` file, or `name=value; name=value`
 * pairs. Pairs carry no site, so they are filed under `defaultDomain`. Errors never include a cookie value.
 */
export function parseCookieText(text: string, opts: { defaultDomain?: string } = {}): BrowserCookie[] {
  if (text.length > MAX_COOKIE_JSON) throw new CookieParseError('Cookie text is too large.');
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) return parseCookieJson(t);
  const list = /\t/.test(t) ? parseNetscape(t) : parseHeader(t, opts.defaultDomain ?? '.reddit.com');
  if (list.length === 0) throw new CookieParseError('No cookies found.');
  if (list.length > MAX_COOKIES) throw new CookieParseError(`At most ${MAX_COOKIES} cookies.`);
  return list;
}

/** The JSON shape cookie extensions and anti-detect tools import (the reverse of {@link parseCookieJson}). */
export function cookiesToJson(cookies: BrowserCookie[]): string {
  return JSON.stringify(
    cookies.map((c) => ({
      domain: c.domain,
      hostOnly: !c.domain.startsWith('.'),
      name: c.name,
      value: c.value,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite === 'None' ? 'no_restriction' : c.sameSite.toLowerCase(),
      session: c.expires <= 0,
      ...(c.expires > 0 ? { expirationDate: c.expires } : {}),
    })),
    null,
    2,
  );
}

/** A Netscape `cookies.txt` file (curl, wget, yt-dlp and most browser tools read it). */
export function cookiesToNetscape(cookies: BrowserCookie[]): string {
  const lines = cookies.map((c) =>
    [
      `${c.httpOnly ? '#HttpOnly_' : ''}${c.domain}`,
      c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
      c.path,
      c.secure ? 'TRUE' : 'FALSE',
      c.expires > 0 ? String(Math.floor(c.expires)) : '0',
      c.name,
      c.value,
    ].join('\t'),
  );
  return `# Netscape HTTP Cookie File\n${lines.join('\n')}\n`;
}
