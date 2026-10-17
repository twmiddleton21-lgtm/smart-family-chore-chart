// In-memory attempt limiter for sign-in, password re-checks, setup codes and
// pairing codes. Keys are e.g. "login:ip:127.0.0.1" and "login:user:alex".
// After `max` failed attempts within the sliding `windowMs`, further attempts
// are refused until the oldest of them is older than the window.
//
// Concurrency: password checks are slow and asynchronous, so an attempt is
// counted the moment it is allowed through (begin), before the check runs.
// If the check then succeeds, release() removes exactly that attempt's own
// entries and nothing else: a success never erases other failures, including
// ones still being checked, and is never itself counted as a failure.
//
// Lifecycle: the counters live in this process's memory only. They are not
// stored in the database, are not shared between processes, and start empty
// whenever the server restarts.

export interface Limit {
  max: number;
  windowMs: number;
}

export type Admission = { allowed: false; retryAfter: number } | { allowed: true; release: () => void };

interface Entry {
  at: number;
}

export class AttemptLimiter {
  private readonly attempts = new Map<string, Entry[]>();
  private pruneAt = 10_000;
  private lastPrune = -Infinity;

  /** `retentionMs`: how long any entry can matter (the longest window in use). */
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly retentionMs: number = LONGEST_WINDOW_MS,
  ) {}

  private recent(key: string, windowMs: number): Entry[] {
    const cutoff = this.now() - windowMs;
    const list = (this.attempts.get(key) ?? []).filter((e) => e.at > cutoff);
    if (list.length) this.attempts.set(key, list);
    else this.attempts.delete(key);
    return list;
  }

  /** Seconds until another attempt is allowed, or 0 if allowed now. */
  retryAfter(key: string, limit: Limit): number {
    const list = this.recent(key, limit.windowMs);
    if (list.length < limit.max) return 0;
    const oldest = list[list.length - limit.max]!;
    return Math.max(1, Math.ceil((oldest.at + limit.windowMs - this.now()) / 1000));
  }

  /**
   * For checks whose outcome is only known later (password hashing): if every
   * key allows it, count this attempt against all of them now. Call
   * `release()` only if the attempt succeeded. If any key refuses, nothing is
   * recorded.
   */
  begin(keys: readonly string[], limit: Limit): Admission {
    const wait = Math.max(0, ...keys.map((k) => this.retryAfter(k, limit)));
    if (wait) return { allowed: false, retryAfter: wait };
    const entry: Entry = { at: this.now() };
    for (const k of keys) this.add(k, entry);
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        for (const k of keys) {
          const list = this.attempts.get(k);
          if (!list) continue;
          const rest = list.filter((e) => e !== entry); // this attempt only (identity)
          if (rest.length) this.attempts.set(k, rest);
          else this.attempts.delete(k);
        }
      },
    };
  }

  /** Record a failure whose outcome was known immediately (code checks). */
  fail(key: string): void {
    this.add(key, { at: this.now() });
  }

  private add(key: string, entry: Entry): void {
    const list = this.attempts.get(key) ?? [];
    list.push(entry);
    this.attempts.set(key, list);
    // Drop expired keys once the map is large: when it doubles, or once a
    // full retention period has passed since the last scan (so a burst of
    // keys can't linger), without rescanning on every call.
    const size = this.attempts.size;
    if (size > this.pruneAt || (size > 10_000 && this.now() - this.lastPrune >= this.retentionMs)) {
      for (const k of [...this.attempts.keys()]) this.recent(k, this.retentionMs);
      this.lastPrune = this.now();
      this.pruneAt = Math.max(10_000, this.attempts.size * 2);
    }
  }

  /** Number of keys held (for tests). */
  get size(): number {
    return this.attempts.size;
  }
}

export const LIMITS = {
  /** Sign-in (per account and per address) and password re-checks (per parent): 5 failures per 15 minutes. */
  login: { max: 5, windowMs: 15 * 60 * 1000 },
  /** Per address: 10 wrong pairing or setup codes per 15 minutes. */
  code: { max: 10, windowMs: 15 * 60 * 1000 },
} as const;

const LONGEST_WINDOW_MS = Math.max(...Object.values(LIMITS).map((l) => l.windowMs));
