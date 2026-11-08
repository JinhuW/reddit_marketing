/** Small helpers shared by the fakes. Test-only code. */

export class TestkitTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`testkit: timed out after ${ms} ms waiting for ${what}`);
    this.name = 'TestkitTimeoutError';
  }
}

/**
 * A list that records items and lets a test wait for one that matches. Waiters see items that arrived
 * before they started waiting, so `waitFor` never races the event it waits for.
 */
export class Recorder<T> {
  readonly items: T[] = [];
  private waiters: { match: (t: T) => boolean; resolve: (t: T) => void }[] = [];

  push(item: T): void {
    this.items.push(item);
    this.waiters = this.waiters.filter((w) => {
      if (!w.match(item)) return true;
      w.resolve(item);
      return false;
    });
  }

  /** Resolve with the first recorded item (past or future) at index ≥ `from` that matches. */
  waitFor(
    match: (t: T) => boolean = () => true,
    opts: { timeoutMs?: number; from?: number; what?: string } = {},
  ) {
    const { timeoutMs = 5_000, from = 0, what = 'a matching item' } = opts;
    const seen = this.items.slice(from).find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new TestkitTimeoutError(what, timeoutMs));
      }, timeoutMs);
      const waiter = {
        match,
        resolve: (t: T) => {
          clearTimeout(timer);
          resolve(t);
        },
      };
      this.waiters.push(waiter);
    });
  }

  clear(): void {
    this.items.length = 0;
  }
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
