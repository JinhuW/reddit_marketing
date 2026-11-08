import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type FetchLike,
  RedditError,
  Throttle,
  decodeEntities,
  htmlToText,
  parseAtomFeed,
  proxyHostForLog,
  publicReader,
  retryAfterMs,
} from './client';

/** Recorded feed shape (tests/fixtures/reddit-feeds/README.md); never fetched live. */
const FEED = readFileSync(
  fileURLToPath(
    new URL('../../../../tests/fixtures/reddit-feeds/projectmanagement-new.atom.xml', import.meta.url),
  ),
  'utf8',
);

describe('parseAtomFeed (recorded feed shape)', () => {
  const posts = parseAtomFeed(FEED, 'projectmanagement');

  it('reads every entry with id, author, permalink and date', () => {
    expect(posts.map((p) => p.name)).toEqual(['t3_1ox9k2q', 't3_1ox8w1d', 't3_1ox7c3m']);
    expect(posts[0]).toMatchObject({
      subreddit: 'projectmanagement',
      author: 'ops_kat',
      title: 'Asana alternative for a 12-person agency? (client approvals & time tracking)',
      permalink: '/r/projectmanagement/comments/1ox9k2q/asana_alternative_for_a_12person_agency/',
      created_utc: Date.parse('2026-11-07T14:58:40Z') / 1000,
    });
    expect(posts[2]?.title).toBe("Remote retros that don't suck?");
  });

  it('has no score or comment count (the feed lacks them)', () => {
    for (const p of posts) {
      expect(p.ups).toBeUndefined();
      expect(p.num_comments).toBeUndefined();
    }
  });

  it('turns the self-text HTML into plain text and drops the "submitted by" footer', () => {
    expect(posts[0]?.selftext).toBe(
      [
        "We're a 12-person agency and Asana got too expensive. Looking for an Asana alternative that handles:",
        '',
        '- client approvals',
        '- time tracking & invoicing',
        '',
        'Budget is < $10/seat. Any tips?',
      ].join('\n'),
    );
    expect(posts[0]?.selftext).not.toMatch(/submitted by|\[link\]|<[a-z/]|&amp;/);
    expect(posts[2]?.selftext).toBe(
      [
        'How do you all run retros with a remote team?',
        'Ours turned into a status meeting.',
        '',
        '"What went well" gets 2 stickies.',
        '',
        'Tried Miro & FigJam — no luck.',
      ].join('\n'),
    );
  });

  it('gives a link post an empty selftext, like the API', () => {
    expect(posts[1]?.selftext).toBe('');
  });

  it('skips entries without a t3 id, a date or a Reddit permalink', () => {
    const entry = (id: string, href: string, published = '2026-11-07T10:00:00+00:00') =>
      `<entry><author><name>/u/a</name></author><id>${id}</id><link href="${href}" /><published>${published}</published><title>x</title></entry>`;
    const ok = 'https://www.reddit.com/r/x/comments/abc/t/';
    const xml = `<feed>${entry('t1_abc', ok)}${entry('t3_abc', 'https://evil.example/r/x/')}${entry('t3_def', ok, 'nope')}${entry('t3_ghi', ok)}</feed>`;
    expect(parseAtomFeed(xml, 'x').map((p) => p.name)).toEqual(['t3_ghi']);
  });

  it('marks a missing author as [deleted] and falls back to the requested subreddit', () => {
    const xml =
      '<feed><entry><id>t3_zz1</id><link href="https://www.reddit.com/r/x/comments/zz1/t/" /><published>2026-11-07T10:00:00Z</published><title>t</title></entry></feed>';
    expect(parseAtomFeed(xml, 'x')[0]).toMatchObject({ author: '[deleted]', subreddit: 'x' });
  });
});

describe('entities and HTML', () => {
  it('decodes named, decimal and hex references and leaves unknown ones', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x2014; &bogus;')).toBe(
      'a & b <c> "d" \'e\' — &bogus;',
    );
  });
  it('drops comments, scripts and tags', () => {
    expect(htmlToText('<!-- x --><p>a<script>evil()</script></p><p>b &amp;amp; c</p>')).toBe(
      'a\n\nb &amp; c',
    );
  });
});

/** A fetch that answers from a list and records what it was asked. */
function scripted(
  answers: { status: number; body?: string; headers?: Record<string, string> }[],
): FetchLike & { calls: { url: string; init: Parameters<FetchLike>[1] }[] } {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const f = (async (url, init) => {
    calls.push({ url, init });
    const a = answers.shift();
    if (!a) throw new Error('unexpected request');
    return {
      status: a.status,
      ok: a.status >= 200 && a.status < 300,
      headers: { get: (n: string) => a.headers?.[n.toLowerCase()] ?? null },
      text: async () => a.body ?? '',
    };
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

/** Throttle on a fake clock: sleeping advances time. */
function fakeClock() {
  let t = 1_000_000;
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
    t += ms;
  };
  return { now: () => t, sleep, slept, throttle: new Throttle(3_000, () => t, sleep) };
}

describe('publicReader', () => {
  it('fetches the Atom feed with our User-Agent and parses it', async () => {
    const f = scripted([{ status: 200, body: FEED }]);
    const c = fakeClock();
    const r = publicReader({ fetch: f, throttle: c.throttle, userAgent: 'threadline/0.1', proxyUrl: '' });
    const posts = await r.newPosts('projectmanagement');
    expect(r.kind).toBe('public');
    expect(posts).toHaveLength(3);
    expect(f.calls[0]?.url).toBe('https://www.reddit.com/r/projectmanagement/new/.rss?limit=100');
    expect(f.calls[0]?.init.headers['User-Agent']).toBe('threadline/0.1');
    expect(f.calls[0]?.init.redirect).toBe('manual');
    expect(f.calls[0]?.init.dispatcher).toBeUndefined();
  });

  it('defaults the User-Agent to REDDIT_USER_AGENT, then threadline/0.1', async () => {
    const prev = process.env.REDDIT_USER_AGENT;
    try {
      process.env.REDDIT_USER_AGENT = 'threadline/0.1 by test';
      const f = scripted([{ status: 200, body: FEED }]);
      await publicReader({ fetch: f, throttle: fakeClock().throttle, proxyUrl: '' }).newPosts('x_y');
      expect(f.calls[0]?.init.headers['User-Agent']).toBe('threadline/0.1 by test');
      process.env.REDDIT_USER_AGENT = '';
      const g = scripted([{ status: 200, body: FEED }]);
      await publicReader({ fetch: g, throttle: fakeClock().throttle, proxyUrl: '' }).newPosts('x_y');
      expect(g.calls[0]?.init.headers['User-Agent']).toBe('threadline/0.1');
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'REDDIT_USER_AGENT');
      else process.env.REDDIT_USER_AGENT = prev;
    }
  });

  it('goes through the proxy when one is set', async () => {
    const f = scripted([{ status: 200, body: FEED }]);
    const r = publicReader({
      fetch: f,
      throttle: fakeClock().throttle,
      proxyUrl: 'http://user:secret@proxy.test:10001',
    });
    await r.newPosts('projectmanagement');
    expect(f.calls[0]?.init.dispatcher).toBeDefined();
    expect(f.calls[0]?.init.dispatcher?.constructor.name).toBe('ProxyAgent');
  });

  it('never puts proxy credentials in an error or a log field', () => {
    expect(proxyHostForLog('http://user:secret@proxy.test:10001')).toBe('proxy.test:10001');
    expect(proxyHostForLog('http://user:secret@proxy.test')).toBe('proxy.test');
    expect(proxyHostForLog(undefined)).toBeNull();
    expect(proxyHostForLog('not a url user:secret')).toBe('invalid');
    let message = '';
    try {
      publicReader({ fetch: scripted([]), proxyUrl: 'ftp//user:secret@' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/not a valid proxy URL/);
    expect(message).not.toContain('secret');
  });

  it('spaces requests at least 3 s apart, across calls', async () => {
    const f = scripted([
      { status: 200, body: FEED },
      { status: 200, body: FEED },
      { status: 200, body: FEED },
    ]);
    const c = fakeClock();
    const r = publicReader({ fetch: f, throttle: c.throttle, sleep: c.sleep, proxyUrl: '' });
    const start = c.now();
    await Promise.all([r.newPosts('a_b'), r.newPosts('c_d'), r.newPosts('e_f')]);
    expect(f.calls).toHaveLength(3);
    // the fake sleep advances the clock at once, so each later caller waits for its own 3 s slot
    expect(c.slept).toEqual([3_000, 3_000]);
    expect(c.now() - start).toBe(6_000);
  });

  it('honours Retry-After on 429 and then succeeds', async () => {
    const f = scripted([
      { status: 429, headers: { 'retry-after': '7' } },
      { status: 200, body: FEED },
    ]);
    const c = fakeClock();
    const r = publicReader({ fetch: f, throttle: c.throttle, sleep: c.sleep, proxyUrl: '' });
    expect(await r.newPosts('projectmanagement')).toHaveLength(3);
    // 7 s from Retry-After; the throttle slot after the backoff is already free by then
    expect(c.slept[0]).toBe(7_000);
    expect(f.calls).toHaveLength(2);
  });

  it('backs off exponentially without Retry-After and gives up with a 429 RedditError', async () => {
    const f = scripted([{ status: 429 }, { status: 429 }, { status: 429 }]);
    const c = fakeClock();
    const r = publicReader({ fetch: f, throttle: c.throttle, sleep: c.sleep, proxyUrl: '', maxRetries: 2 });
    const err = await r.newPosts('projectmanagement').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedditError);
    expect((err as RedditError).status).toBe(429);
    expect((err as RedditError).retryAfterMs).toBe(40_000);
    expect(c.slept.filter((ms) => ms >= 10_000)).toEqual([10_000, 20_000]);
  });

  it('does not sleep through a long Retry-After: it fails so the job retries later', async () => {
    const f = scripted([{ status: 429, headers: { 'retry-after': '600' } }]);
    const c = fakeClock();
    const err = await publicReader({ fetch: f, throttle: c.throttle, sleep: c.sleep, proxyUrl: '' })
      .newPosts('projectmanagement')
      .catch((e: unknown) => e);
    expect((err as RedditError).retryAfterMs).toBe(600_000);
    expect(c.slept).toEqual([]);
  });

  it('reports other statuses (403 blocked, 302 redirect) as RedditError without retrying', async () => {
    for (const status of [403, 302, 404]) {
      const f = scripted([{ status }]);
      const err = await publicReader({ fetch: f, throttle: fakeClock().throttle, proxyUrl: '' })
        .newPosts('projectmanagement')
        .catch((e: unknown) => e);
      expect((err as RedditError).status).toBe(status);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('refuses a subreddit name that is not one (no path injection)', async () => {
    const f = scripted([]);
    const r = publicReader({ fetch: f, throttle: fakeClock().throttle, proxyUrl: '' });
    await expect(r.newPosts('../api/me')).rejects.toThrow(/invalid subreddit/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('retryAfterMs', () => {
  it('reads seconds and HTTP dates', () => {
    expect(retryAfterMs('5')).toBe(5_000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});
