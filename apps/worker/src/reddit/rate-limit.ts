/**
 * Token bucket: `capacity` requests refilled evenly over `perMs`.
 * Reddit's published limit is 60 requests/min per OAuth client+user.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    readonly capacity: number,
    readonly perMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }
  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / this.perMs) * this.capacity);
    this.last = t;
  }
  /** ms to wait before a token is available (0 = take it now). Takes the token when available. */
  take(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.capacity) * this.perMs);
  }
  /** Honour X-Ratelimit-Remaining / Reset from Reddit: drain the bucket until reset. */
  syncFromHeaders(remaining: number | null, resetSeconds: number | null) {
    if (remaining !== null && remaining < 1 && resetSeconds !== null) {
      this.tokens = -((resetSeconds * 1000) / this.perMs) * this.capacity;
      this.last = this.now();
    }
  }
}
