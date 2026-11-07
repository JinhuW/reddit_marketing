import { decrypt } from '@threadline/shared/crypto';
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

export interface RedditPost {
  name: string;
  subreddit: string;
  author: string;
  title: string;
  selftext: string;
  permalink: string;
  ups: number;
  num_comments: number;
  created_utc: number;
}
