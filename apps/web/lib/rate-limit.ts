import 'server-only';
import Redis from 'ioredis';

const g = globalThis as unknown as { __tlRedis?: Redis };
function redis() {
  g.__tlRedis ??= new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  return g.__tlRedis;
}

/**
 * Fixed-window per-key limiter in Redis for public endpoints (/r/[slug], /api/tl/collect, webhooks).
 * Fails open if Redis is unreachable so tracked links never break.
 */
export async function allow(key: string, limit: number, windowSec: number): Promise<boolean> {
  try {
    const r = redis();
    if (r.status === 'wait') await r.connect();
    const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, windowSec);
    return n <= limit;
  } catch {
    return true;
  }
}

export function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown'
  );
}
