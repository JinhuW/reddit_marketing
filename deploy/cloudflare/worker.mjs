// Edge for reddits.recycleservers.com (Worker `threadline-edge`). Next.js runs on Railway (`web`); this Worker
// only fronts it. See docs/DECISIONS.md "2026-11-08 — Cloudflare edge" for why the app itself stays on Railway.
//
//   1. http → https (308).
//   2. /_next/static/* is content-hashed: served from the edge cache once Railway has answered 200.
//      Misses that are not 200 are never cached (a deploy can briefly 404 a new chunk).
//   3. Outer flood guards per client IP, above the app's own Redis limits (lib/rate-limit.ts):
//      POST /api/tl/collect → 429 past COLLECT_LIMITER; /r/<slug> → 429 only past R_LIMITER, which is set far
//      above any real reader, because a tracked link in a Reddit comment must keep working.
//   4. Everything else (pages, server actions, SSE, the VNC websocket) is forwarded unchanged, with
//      x-forwarded-host so Next.js origin checks and Auth.js URLs stay on the public hostname.

const STATIC_PREFIX = '/_next/static/';
const IMMUTABLE = 'public, max-age=31536000, immutable';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 308);
    }

    const ip = request.headers.get('cf-connecting-ip') ?? '';
    const limited = await overLimit(request, url, ip, env);
    if (limited) return limited;

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith(STATIC_PREFIX)) {
      return staticAsset(request, url, env, ctx, ip);
    }
    return forward(request, url, env, ip);
  },
};

/** A 429 response when a guarded route is over its edge limit, else null. Fails open if a binding is missing. */
async function overLimit(request, url, ip, env) {
  if (!ip) return null;
  let limiter = null;
  if (request.method === 'POST' && url.pathname === '/api/tl/collect') limiter = env.COLLECT_LIMITER;
  else if (url.pathname.startsWith('/r/')) limiter = env.R_LIMITER;
  if (!limiter) return null;
  try {
    const { success } = await limiter.limit({
      key: `${url.pathname.startsWith('/r/') ? 'r' : 'collect'}:${ip}`,
    });
    if (success) return null;
  } catch {
    return null;
  }
  return new Response('Too many requests', {
    status: 429,
    headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
  });
}

async function staticAsset(request, url, env, ctx, ip) {
  const cache = caches.default;
  const key = new Request(`${url.origin}${url.pathname}${url.search}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return request.method === 'HEAD' ? new Response(null, hit) : hit;

  const res = await forward(
    new Request(request.url, { method: 'GET', headers: request.headers }),
    url,
    env,
    ip,
  );
  if (res.status !== 200) {
    const miss = new Response(res.body, res);
    miss.headers.set('Cache-Control', 'no-store');
    return miss;
  }
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', IMMUTABLE);
  out.headers.delete('Set-Cookie');
  ctx.waitUntil(cache.put(key, out.clone()));
  return request.method === 'HEAD' ? new Response(null, out) : out;
}

function forward(request, url, env, ip) {
  const target = new URL(url.pathname + url.search, env.ORIGIN_URL);
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', 'https');
  if (ip) headers.set('x-forwarded-for', ip);
  return fetch(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  });
}
