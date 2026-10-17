import { describe, expect, it } from 'vitest';
import { AttemptLimiter, type Limit } from './rateLimit';

const LIMIT: Limit = { max: 5, windowMs: 15 * 60 * 1000 };

function limiter() {
  let t = 1_000_000;
  const l = new AttemptLimiter(() => t, LIMIT.windowMs);
  return { l, advance: (ms: number) => (t += ms), at: (ms: number) => (t = ms), now: () => t };
}

describe('AttemptLimiter', () => {
  it('admits exactly max attempts that fail, then refuses until the window passes', () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 5; i++) expect(l.begin(['k'], LIMIT).allowed).toBe(true); // never released: all failed
    const refused = l.begin(['k'], LIMIT);
    expect(refused).toEqual({ allowed: false, retryAfter: 900 });
    advance(LIMIT.windowMs - 1);
    expect(l.begin(['k'], LIMIT).allowed).toBe(false);
    advance(1);
    expect(l.begin(['k'], LIMIT).allowed).toBe(true);
  });

  it('the window slides: each failure expires 15 minutes after it happened', () => {
    const { l, advance } = limiter();
    l.fail('k');
    advance(5 * 60 * 1000);
    for (let i = 0; i < 4; i++) l.fail('k');
    expect(l.retryAfter('k', LIMIT)).toBe(600); // the first failure expires in 10 minutes
    advance(10 * 60 * 1000);
    expect(l.retryAfter('k', LIMIT)).toBe(0); // 4 left: one more allowed
    l.fail('k');
    expect(l.retryAfter('k', LIMIT)).toBeGreaterThan(0);
  });

  it('release removes only that attempt, never other failures', () => {
    const { l } = limiter();
    const a = l.begin(['k'], LIMIT);
    const b = l.begin(['k'], LIMIT);
    const c = l.begin(['k'], LIMIT);
    if (!a.allowed || !b.allowed || !c.allowed) throw new Error('setup');
    c.release(); // c succeeded; a and b (failures, or still being checked) remain
    l.fail('k');
    l.fail('k');
    l.fail('k'); // a, b + 3 = 5
    expect(l.begin(['k'], LIMIT).allowed).toBe(false);
  });

  it('releasing twice is harmless and can’t remove other entries', () => {
    const { l } = limiter();
    const ok = l.begin(['k'], LIMIT);
    if (!ok.allowed) throw new Error('setup');
    for (let i = 0; i < 4; i++) l.fail('k');
    ok.release();
    ok.release();
    ok.release();
    l.fail('k');
    expect(l.begin(['k'], LIMIT).allowed).toBe(false); // the 5 real failures all still count
  });

  it('a released attempt is never counted', () => {
    const { l } = limiter();
    for (let i = 0; i < 50; i++) {
      const a = l.begin(['k'], LIMIT);
      if (!a.allowed) throw new Error(`refused at ${i}`);
      a.release();
    }
    expect(l.retryAfter('k', LIMIT)).toBe(0);
    expect(l.size).toBe(0);
  });

  it('several keys: admitted only if all allow; nothing is recorded when refused', () => {
    const { l } = limiter();
    for (let i = 0; i < 5; i++) l.fail('ip');
    expect(l.begin(['ip', 'user'], LIMIT).allowed).toBe(false);
    expect(l.retryAfter('user', LIMIT)).toBe(0);
    for (let i = 0; i < 4; i++) l.fail('user'); // 'user' has room for exactly one more
    expect(l.begin(['user'], LIMIT).allowed).toBe(true);
  });

  it('a release on several keys removes its entry from each, and only its own', () => {
    const { l } = limiter();
    l.fail('ip');
    const a = l.begin(['ip', 'user'], LIMIT);
    if (!a.allowed) throw new Error('setup');
    a.release();
    for (let i = 0; i < 4; i++) l.fail('ip');
    expect(l.begin(['ip'], LIMIT).allowed).toBe(false); // the earlier 'ip' failure still counts
    expect(l.retryAfter('user', LIMIT)).toBe(0);
  });

  it('drops expired keys when it grows large, so memory stays bounded', () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 10_001; i++) l.fail(`old:${i}`);
    advance(LIMIT.windowMs + 1);
    l.fail('new'); // crosses the threshold: everything expired is pruned
    expect(l.size).toBe(1);
  });
});
