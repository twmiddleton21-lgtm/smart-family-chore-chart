// Simple in-memory attempt limiter for sign-in, setup and pairing. Keys are
// e.g. "login:ip:127.0.0.1" and "login:user:alex". After `max` failures in
// `windowMs`, further attempts are refused until the window passes. A
// successful attempt clears the key. Memory is bounded by pruning old keys.
// Callers that await before knowing the outcome (password hashing) must call
// fail() BEFORE awaiting and succeed() after, so concurrent attempts count.

export interface Limit {
  max: number;
  windowMs: number;
}

export class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private recent(key: string, windowMs: number): number[] {
    const cutoff = this.now() - windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  /** Seconds until another attempt is allowed, or 0 if allowed now. */
  retryAfter(key: string, limit: Limit): number {
    const list = this.recent(key, limit.windowMs);
    if (list.length < limit.max) return 0;
    const oldest = list[list.length - limit.max]!;
    return Math.max(1, Math.ceil((oldest + limit.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const list = this.failures.get(key) ?? [];
    list.push(this.now());
    this.failures.set(key, list);
    if (this.failures.size > 10000) this.prune(24 * 60 * 60 * 1000);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }

  private prune(maxAgeMs: number): void {
    for (const key of [...this.failures.keys()]) this.recent(key, maxAgeMs);
  }
}

export const LIMITS = {
  /** Per account and per IP: 5 wrong passwords per 15 minutes. */
  login: { max: 5, windowMs: 15 * 60 * 1000 },
  /** Per IP: 10 wrong pairing or setup codes per 15 minutes. */
  code: { max: 10, windowMs: 15 * 60 * 1000 },
} as const;
