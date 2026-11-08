import { decrypt } from '@threadline/shared/crypto';
import { type Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';
import { TokenBucket } from './rate-limit';

const UA = process.env.REDDIT_USER_AGENT ?? 'threadline/0.1';
const OAUTH = 'https://oauth.reddit.com';

/** Raised when Reddit returns a challenge the API cannot complete (captcha / verification). */
export class NeedsBrowser extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeedsBrowser';
  }
}
export class RedditError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RedditError';
  }
}

const buckets = new Map<string, TokenBucket>();
const bucketFor = (key: string) => {
  let b = buckets.get(key);
  if (!b) {
    b = new TokenBucket(60, 60_000);
    buckets.set(key, b);
  }
  return b;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const basic = () =>
  `Basic ${Buffer.from(`${process.env.REDDIT_CLIENT_ID ?? ''}:${process.env.REDDIT_CLIENT_SECRET ?? ''}`).toString('base64')}`;

async function tokenRequest(body: URLSearchParams): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: basic(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body,
  });
  if (!res.ok) throw new RedditError(`token request failed (${res.status})`, res.status);
  return res.json() as Promise<{ access_token: string; expires_in: number }>;
}

/**
 * Thin fetch client. One instance per credential: the app's client-credentials token for read-only
 * polling, or an owner account's refresh token for posting. Tokens stay in this process only.
 */
export class RedditClient {
  private access: { token: string; exp: number } | null = null;
  private constructor(
    private readonly key: string,
    private readonly grant: () => URLSearchParams,
  ) {}

  static app() {
    return new RedditClient('app', () => new URLSearchParams({ grant_type: 'client_credentials' }));
  }
  static forAccount(account: { id: string; oauthTokenEnc: string | null }) {
    if (!account.oauthTokenEnc) throw new RedditError('account has no OAuth token', 401);
    const enc = account.oauthTokenEnc;
    return new RedditClient(
      `acct:${account.id}`,
      () => new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decrypt(enc) }),
    );
  }

  private async token() {
    if (this.access && this.access.exp > Date.now() + 60_000) return this.access.token;
    const t = await tokenRequest(this.grant());
    this.access = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 };
    return t.access_token;
  }

  async request<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<T> {
    const bucket = bucketFor(this.key);
    for (let wait = bucket.take(); wait > 0; wait = bucket.take()) await sleep(wait);
    const res = await fetch(`${OAUTH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'User-Agent': UA,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams({ api_type: 'json', ...form }) : undefined,
    });
    const rem = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    bucket.syncFromHeaders(rem === null ? null : Number(rem), reset === null ? null : Number(reset));
    if (res.status === 429) throw new RedditError('rate limited', 429, reset ? Number(reset) * 1000 : 60_000);
    if (!res.ok) throw new RedditError(`${method} ${path} → ${res.status}`, res.status);
    const json = (await res.json()) as T & { json?: { errors?: [string, string, string][] } };
    const errors = json.json?.errors ?? [];
    if (errors.some(([code]) => code === 'RATELIMIT')) throw new RedditError('RATELIMIT', 429, 10 * 60_000);
    if (errors.some(([code]) => code === 'BAD_CAPTCHA' || code === 'USER_REQUIRED'))
      throw new NeedsBrowser(errors.map((e) => e.join(': ')).join('; '));
    if (errors.length) throw new RedditError(errors.map((e) => e.join(': ')).join('; '), 400);
    return json;
  }

  // ── posting (owner token only) ──
  async comment(parentFullname: string, text: string) {
    const r = await this.request<{ json: { data: { things: { data: { name: string } }[] } } }>(
      'POST',
      '/api/comment',
      {
        thing_id: parentFullname,
        text,
      },
    );
    return r.json.data.things[0]!.data.name;
  }
  async submit(subreddit: string, title: string, text: string) {
    const r = await this.request<{ json: { data: { name: string } } }>('POST', '/api/submit', {
      sr: subreddit,
      kind: 'self',
      title,
      text,
    });
    return r.json.data.name;
  }
  async compose(to: string, subject: string, text: string) {
    await this.request('POST', '/api/compose', { to, subject, text });
    return `dm:${to}:${Date.now()}`;
  }

  // ── read-only (app token) ──
  newPosts(subreddit: string, limit = 50) {
    return this.request<{ data: { children: { data: RedditPost }[] } }>(
      'GET',
      `/r/${subreddit}/new?limit=${limit}`,
    );
  }
}

/**
 * One post as the poll code consumes it. `ups` / `num_comments` exist only in API listings: the public Atom
 * feed has neither, so consumers treat undefined as "unknown" (0 on insert, unchanged on update).
 */
export interface RedditPost {
  name: string;
  subreddit: string;
  author: string;
  title: string;
  selftext: string;
  permalink: string;
  ups?: number;
  num_comments?: number;
  created_utc: number;
}

/** Reads the newest posts of a subreddit. reddit.poll takes one so tests never call Reddit. */
export interface PostReader {
  readonly kind: 'app' | 'public';
  newPosts(subreddit: string): Promise<RedditPost[]>;
}

const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;

/** The Reddit app's client-credentials token (only when REDDIT_CLIENT_ID / SECRET are configured). */
export function appReader(client: RedditClient = RedditClient.app()): PostReader {
  return {
    kind: 'app',
    async newPosts(subreddit) {
      if (!SUBREDDIT.test(subreddit)) throw new RedditError('invalid subreddit name', 400);
      const listing = await client.newPosts(subreddit, 100);
      return listing.data.children.map((c) => c.data);
    },
  };
}

// ── public reader (no Reddit app): the subreddit's Atom feed ──

/** Minimal fetch surface (undici's fetch fits). Injected in tests. */
export type FetchLike = (
  url: string,
  init: {
    headers: Record<string, string>;
    redirect: 'manual';
    signal: AbortSignal;
    dispatcher?: Dispatcher;
  },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Spaces requests out: at most one per `intervalMs`. One shared instance per process (all readers). */
export class Throttle {
  private nextAt = 0;
  constructor(
    readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  /** Waits for this caller's slot. Slots are reserved in call order, so concurrent jobs queue up. */
  async wait(): Promise<void> {
    const t = this.now();
    const at = Math.max(t, this.nextAt);
    this.nextAt = at + this.intervalMs;
    if (at > t) await this.sleep(at - t);
  }
  /** Pushes every later request back: a 429 applies to the whole process, not to one caller. */
  backOff(ms: number): void {
    this.nextAt = Math.max(this.nextAt, this.now() + ms);
  }
}

/** Measured 2026-11-07: the feed answers at 1 request / 3 s; this is the per-process ceiling. */
export const PUBLIC_MIN_INTERVAL_MS = 3_000;
const processThrottle = new Throttle(PUBLIC_MIN_INTERVAL_MS);

/** `host:port` of a proxy URL: the only part of REDDIT_READ_PROXY_URL that may be logged (it holds user:pass). */
export function proxyHostForLog(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return 'invalid';
  }
}

/** Retry-After as ms (delta seconds or an HTTP date); null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const s = Number(header);
  if (header.trim() !== '' && Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export interface PublicReaderOptions {
  fetch?: FetchLike;
  /** e.g. `http://user:pass@host:port`; default REDDIT_READ_PROXY_URL. Never logged (see proxyHostForLog). */
  proxyUrl?: string;
  userAgent?: string;
  throttle?: Throttle;
  sleep?: (ms: number) => Promise<void>;
  /** 429 retries inside one call before it fails with RedditError(429). */
  maxRetries?: number;
  /** A wait above this is not slept through: the call fails with RedditError(429) carrying retryAfterMs. */
  maxWaitMs?: number;
  timeoutMs?: number;
}

/**
 * Public reader for deployments without a Reddit app. Measured 2026-11-07 through a residential proxy:
 * `/r/<sub>/new.json` → 403 and old.reddit.com → 302, but `/r/<sub>/new/.rss` → 200 with a plain User-Agent
 * (a browser-like UA got 429). So: the Atom feed, our own UA, <= 1 request / 3 s per process, 429 honoured
 * (Retry-After when present, else exponential from 10 s).
 */
export function publicReader(opts: PublicReaderOptions = {}): PostReader {
  const proxyUrl = opts.proxyUrl ?? (process.env.REDDIT_READ_PROXY_URL || undefined);
  const ua = opts.userAgent ?? (process.env.REDDIT_USER_AGENT || 'threadline/0.1');
  const throttle = opts.throttle ?? processThrottle;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 3;
  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  // undici's own fetch with its own ProxyAgent, so the dispatcher always matches the fetch implementation.
  const doFetch: FetchLike = opts.fetch ?? (undiciFetch as unknown as FetchLike);
  let dispatcher: Dispatcher | undefined;
  if (proxyUrl) {
    try {
      dispatcher = new ProxyAgent(proxyUrl);
    } catch {
      // the error could quote the URL (credentials): report the host only
      throw new Error(`REDDIT_READ_PROXY_URL is not a valid proxy URL (${proxyHostForLog(proxyUrl)})`);
    }
  }

  return {
    kind: 'public',
    async newPosts(subreddit) {
      if (!SUBREDDIT.test(subreddit)) throw new RedditError('invalid subreddit name', 400);
      const url = `https://www.reddit.com/r/${subreddit}/new/.rss?limit=100`;
      for (let attempt = 0; ; attempt++) {
        await throttle.wait();
        const res = await doFetch(url, {
          headers: { 'User-Agent': ua, Accept: 'application/atom+xml' },
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          ...(dispatcher ? { dispatcher } : {}),
        });
        if (res.status === 429) {
          const wait = retryAfterMs(res.headers.get('retry-after')) ?? 10_000 * 2 ** attempt;
          throttle.backOff(wait);
          if (attempt >= maxRetries || wait > maxWaitMs)
            throw new RedditError(`r/${subreddit} feed rate limited`, 429, wait);
          await sleep(wait);
          continue;
        }
        if (!res.ok) throw new RedditError(`r/${subreddit} feed → ${res.status}`, res.status);
        return parseAtomFeed(await res.text(), subreddit);
      }
    },
  };
}

/** The reader reddit.poll uses: the Reddit app when it is configured, else the public Atom feed. */
export function defaultReader(): PostReader {
  return process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET ? appReader() : publicReader();
}

// ── Atom → RedditPost ──

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes character references: the five XML names, &nbsp; and numeric ones. Unknown names stay as they are. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, ref: string) => {
    if (ref[0] === '#') {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const cp = hex ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[ref.toLowerCase()] ?? m;
  });
}

/** Rendered post HTML → plain text: block ends become line breaks, tags go, entities are decoded. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(li|tr)>/gi, '\n')
    .replace(/<\/(p|div|ul|ol|blockquote|pre|h[1-6]|table)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Text of the first `<tag>` element (CDATA kept verbatim, else references decoded), or null. */
function tagText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m) return null;
  const raw = m[1] ?? '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return cdata ? (cdata[1] ?? '') : decodeEntities(raw);
}

/** Value of attribute `name` on the first `<tag>` element, or null. */
function attr(xml: string, tag: string, name: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`).exec(xml);
  return m ? decodeEntities(m[1] ?? '') : null;
}

/**
 * Parses a subreddit's Atom feed into RedditPosts. The body is the self-text between Reddit's
 * `<!-- SC_OFF -->` / `<!-- SC_ON -->` markers (a link post has none, so its selftext is '' as in the API);
 * the "submitted by … [link] [comments]" footer is dropped. Entries without a t3_ id, a date or a Reddit
 * permalink are skipped. Score and comment count are not in the feed and stay undefined.
 */
export function parseAtomFeed(xml: string, subreddit: string): RedditPost[] {
  const out: RedditPost[] = [];
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const e = m[1] ?? '';
    const name = tagText(e, 'id')?.trim() ?? '';
    if (!/^t3_[a-z0-9]+$/i.test(name)) continue;
    const created = Date.parse(tagText(e, 'published') ?? tagText(e, 'updated') ?? '');
    if (Number.isNaN(created)) continue;
    const href = attr(e, 'link', 'href') ?? '';
    const pm = /^https:\/\/(?:www\.|old\.|new\.)?reddit\.com(\/r\/[^?#\s]+)/.exec(href);
    if (!pm?.[1]) continue;
    const authorBlock = /<author>([\s\S]*?)<\/author>/.exec(e)?.[1] ?? '';
    const author = (tagText(authorBlock, 'name') ?? '').trim().replace(/^\/?u\//, '') || '[deleted]';
    const html = tagText(e, 'content') ?? '';
    const self = /<!--\s*SC_OFF\s*-->([\s\S]*?)<!--\s*SC_ON\s*-->/.exec(html);
    out.push({
      name,
      subreddit: attr(e, 'category', 'term') ?? subreddit,
      author,
      title: (tagText(e, 'title') ?? '').trim(),
      selftext: self ? htmlToText(self[1] ?? '') : '',
      permalink: pm[1],
      created_utc: Math.floor(created / 1000),
    });
  }
  return out;
}
