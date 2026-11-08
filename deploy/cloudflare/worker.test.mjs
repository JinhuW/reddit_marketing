// threadline-edge with a fake origin, cache and rate limiters. Run: node --test deploy/cloudflare/worker.test.mjs
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import worker from './worker.mjs';

const ORIGIN = 'https://web.example.up.railway.app';
let seen;
let answer;
let store;
let waits;
const realFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  waits = [];
  store = new Map();
  answer = () => new Response('ok', { status: 200, headers: { 'Cache-Control': 'private' } });
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init });
    return answer(String(url), init);
  };
  globalThis.caches = {
    default: {
      match: async (req) => store.get(req.url)?.clone(),
      put: async (req, res) => {
        store.set(req.url, res);
      },
    },
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.caches = undefined;
});

const ctx = { waitUntil: (p) => waits.push(p) };
const limiter = (success) => ({
  calls: [],
  async limit(o) {
    this.calls.push(o.key);
    return { success };
  },
});
const env = (over = {}) => ({ ORIGIN_URL: ORIGIN, ...over });
const req = (path, init = {}) =>
  new Request(`https://reddits.recycleservers.com${path}`, {
    ...init,
    headers: { 'cf-connecting-ip': '203.0.113.7', ...(init.headers ?? {}) },
  });

test('http redirects to https', async () => {
  const res = await worker.fetch(new Request('http://reddits.recycleservers.com/login?x=1'), env(), ctx);
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), 'https://reddits.recycleservers.com/login?x=1');
  assert.equal(seen.length, 0);
});

test('pages are forwarded with the public host and client ip', async () => {
  const res = await worker.fetch(req('/approvals?tab=1'), env(), ctx);
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, `${ORIGIN}/approvals?tab=1`);
  assert.equal(seen[0].headers.get('x-forwarded-host'), 'reddits.recycleservers.com');
  assert.equal(seen[0].headers.get('x-forwarded-proto'), 'https');
  assert.equal(seen[0].headers.get('x-forwarded-for'), '203.0.113.7');
  assert.equal(seen[0].redirect, 'manual');
  assert.equal(store.size, 0, 'pages are never cached');
});

test('a 200 static asset is cached immutable and served from cache next time', async () => {
  const first = await worker.fetch(req('/_next/static/chunks/app-abc.js'), env(), ctx);
  assert.equal(first.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  await Promise.all(waits);
  assert.equal(store.size, 1);
  const second = await worker.fetch(req('/_next/static/chunks/app-abc.js'), env(), ctx);
  assert.equal(await second.text(), 'ok');
  assert.equal(seen.length, 1, 'second request did not reach Railway');
});

test('a static miss that is not 200 is not cached and is marked no-store', async () => {
  answer = () => new Response('nope', { status: 404 });
  const res = await worker.fetch(req('/_next/static/chunks/new.js'), env(), ctx);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  await Promise.all(waits);
  assert.equal(store.size, 0);
});

test('collect over the edge limit gets 429 without reaching Railway', async () => {
  const COLLECT_LIMITER = limiter(false);
  const res = await worker.fetch(
    req('/api/tl/collect', { method: 'POST', body: '{}' }),
    env({ COLLECT_LIMITER }),
    ctx,
  );
  assert.equal(res.status, 429);
  assert.deepEqual(COLLECT_LIMITER.calls, ['collect:203.0.113.7']);
  assert.equal(seen.length, 0);
});

test('collect under the limit and tracked links under the limit are forwarded', async () => {
  const e = env({ COLLECT_LIMITER: limiter(true), R_LIMITER: limiter(true) });
  assert.equal(
    (await worker.fetch(req('/api/tl/collect', { method: 'POST', body: '{}' }), e, ctx)).status,
    200,
  );
  answer = () =>
    new Response(null, { status: 302, headers: { Location: 'https://example.com/?utm_source=reddit' } });
  const r = await worker.fetch(req('/r/abc123'), e, ctx);
  assert.equal(r.status, 302);
  assert.deepEqual(e.R_LIMITER.calls, ['r:203.0.113.7']);
  assert.equal(seen.length, 2);
});

test('a throwing or missing limiter fails open', async () => {
  const broken = {
    limit: async () => {
      throw new Error('down');
    },
  };
  assert.equal((await worker.fetch(req('/r/abc123'), env({ R_LIMITER: broken }), ctx)).status, 200);
  assert.equal((await worker.fetch(req('/r/abc123'), env(), ctx)).status, 200);
});
