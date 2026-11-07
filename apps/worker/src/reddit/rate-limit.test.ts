import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rate-limit';

describe('TokenBucket', () => {
  it('allows capacity requests then waits', () => {
    let t = 0;
    const b = new TokenBucket(60, 60_000, () => t);
    for (let i = 0; i < 60; i++) expect(b.take()).toBe(0);
    expect(b.take()).toBe(1000);
    t += 1000;
    expect(b.take()).toBe(0);
  });
  it('drains until the reset Reddit reports', () => {
    let t = 0;
    const b = new TokenBucket(60, 60_000, () => t);
    b.syncFromHeaders(0, 30);
    expect(b.take()).toBeGreaterThanOrEqual(30_000);
    t += 31_000;
    expect(b.take()).toBe(0);
  });
});
