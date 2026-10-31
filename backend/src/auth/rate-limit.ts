/** In-memory login throttling: after a few failures, exponentially growing lockouts per client key. */

export type RateLimiterOptions = {
  now?: () => number;
  /** Failures allowed before the first lockout. */
  freeAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Failure history is forgotten after this much quiet time. */
  forgetAfterMs?: number;
};

type Entry = { failures: number; blockedUntil: number; last: number };

export class LoginRateLimiter {
  private entries = new Map<string, Entry>();
  private now: () => number;
  private free: number;
  private base: number;
  private max: number;
  private forgetAfter: number;

  constructor(o: RateLimiterOptions = {}) {
    this.now = o.now ?? Date.now;
    this.free = o.freeAttempts ?? 5;
    this.base = o.baseDelayMs ?? 1000;
    this.max = o.maxDelayMs ?? 15 * 60_000;
    this.forgetAfter = o.forgetAfterMs ?? 60 * 60_000;
  }

  /** Seconds the caller must wait, or 0 when an attempt is allowed. */
  retryAfterSeconds(key: string): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    const t = this.now();
    if (t - e.last > this.forgetAfter) {
      this.entries.delete(key);
      return 0;
    }
    return e.blockedUntil > t ? Math.ceil((e.blockedUntil - t) / 1000) : 0;
  }

  recordFailure(key: string): void {
    const t = this.now();
    if (this.entries.size > 10_000) this.sweep(t);
    const e = this.entries.get(key) ?? { failures: 0, blockedUntil: 0, last: t };
    e.failures += 1;
    e.last = t;
    if (e.failures >= this.free) {
      e.blockedUntil = t + Math.min(this.max, this.base * 2 ** (e.failures - this.free));
    }
    this.entries.set(key, e);
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private sweep(t: number) {
    for (const [k, e] of this.entries) if (t - e.last > this.forgetAfter) this.entries.delete(k);
  }
}
