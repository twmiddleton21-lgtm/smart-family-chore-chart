import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLYBY_DURATION_S, FLYBY_TIMING, FLYBY_TOP_VH, flybyDelay, planFlyby, startFlybys, type Flyby } from './flyby';

/** A repeatable sequence of "random" numbers. */
function seq(seed = 1) {
  let x = seed;
  return () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  };
}

describe('planning a Santa fly-by', () => {
  it('varies direction, path, height, speed and size within sensible limits', () => {
    const r = seq(7);
    const flights = Array.from({ length: 60 }, (_, i) => planFlyby(i + 1, r));
    for (const f of flights) {
      expect(f.topVh).toBeGreaterThanOrEqual(FLYBY_TOP_VH[0]);
      expect(f.topVh).toBeLessThanOrEqual(FLYBY_TOP_VH[1]);
      expect(f.durationS).toBeGreaterThanOrEqual(FLYBY_DURATION_S[0]);
      expect(f.durationS).toBeLessThanOrEqual(FLYBY_DURATION_S[1]);
      expect(f.scale).toBeGreaterThanOrEqual(0.85);
      expect(f.scale).toBeLessThanOrEqual(1.1);
    }
    expect(new Set(flights.map((f) => f.direction))).toEqual(new Set(['ltr', 'rtl']));
    expect(new Set(flights.map((f) => f.climb)).size).toBe(3);
    expect(new Set(flights.map((f) => f.arc)).size).toBe(3);
    expect(new Set(flights.map((f) => f.durationS)).size).toBeGreaterThan(20);
    expect(new Set(flights.map((f) => f.topVh)).size).toBeGreaterThan(20);
  });

  it('comes soon after the screen wakes, then minutes apart; seconds for a parent’s preview', () => {
    // Soon enough to be seen by someone using the kiosk (it dims after 2 minutes).
    expect(flybyDelay('scheduled', true, () => 0)).toBe(15_000);
    expect(flybyDelay('scheduled', true, () => 0.9999)).toBeLessThanOrEqual(40_000);
    expect(flybyDelay('scheduled', false, () => 0)).toBe(4 * 60_000);
    expect(flybyDelay('scheduled', false, () => 0.9999)).toBeLessThanOrEqual(10 * 60_000);
    expect(flybyDelay('preview', true, () => 0.9999)).toBeLessThanOrEqual(3_500);
    expect(FLYBY_TIMING.preview.gap[0]).toBeGreaterThan(FLYBY_DURATION_S[1] * 1000);
  });
});

describe('the fly-by schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function run(preview: boolean, hidden = () => false, idle = () => false) {
    const shown: (Flyby | null)[] = [];
    const s = startFlybys({ preview, random: seq(3), hidden, idle, show: (f) => shown.push(f) });
    const onScreen = () => shown.at(-1) ?? null;
    return { s, shown, onScreen };
  }

  it('is occasional: nothing at first, then one fly-by, then a long gap', () => {
    const { s, shown, onScreen } = run(false);
    const secondsUntilShown = () => {
      for (let t = 1; t <= 3600; t++) {
        vi.advanceTimersByTime(1000);
        if (onScreen()) return t;
      }
      return Infinity;
    };
    const first = secondsUntilShown();
    expect(first * 1000).toBeGreaterThanOrEqual(FLYBY_TIMING.scheduled.first[0]);
    expect(first * 1000).toBeLessThanOrEqual(FLYBY_TIMING.scheduled.first[1] + 1000);
    expect(onScreen()?.id).toBe(1);
    // The crossing ends (animationend): gone, and the next one is minutes away.
    s.finish();
    expect(onScreen()).toBeNull();
    const gap = secondsUntilShown();
    expect(gap * 1000).toBeGreaterThanOrEqual(FLYBY_TIMING.scheduled.gap[0]);
    expect(gap * 1000).toBeLessThanOrEqual(FLYBY_TIMING.scheduled.gap[1] + 1000);
    expect(onScreen()?.id).toBe(2);
    expect(shown.filter(Boolean)).toHaveLength(2);
    s.stop();
  });

  it('never has more than one fly-by at a time, and keeps a single timer', () => {
    const { s, shown } = run(true);
    let onScreen = 0;
    let most = 0;
    for (let minute = 0; minute < 60; minute++) {
      vi.advanceTimersByTime(60_000);
      onScreen = shown.at(-1) ? 1 : 0;
      most = Math.max(most, onScreen);
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(most).toBe(1);
    // An hour of preview: a fly-by every 25-45 s plus its crossing; never piling up.
    const flights = shown.filter(Boolean).length;
    expect(flights).toBeGreaterThan(40);
    expect(flights).toBeLessThan(110);
    // Each one was removed before the next came.
    shown.forEach((f, i) => {
      if (f && i > 0) expect(shown[i - 1]).toBeNull();
    });
    s.stop();
  });

  it('lets go of a fly-by that never reports its end', () => {
    const { s, onScreen } = run(true);
    vi.advanceTimersByTime(FLYBY_TIMING.preview.first[1]);
    const f = onScreen()!;
    expect(f).not.toBeNull();
    vi.advanceTimersByTime(f.durationS * 1000);
    expect(onScreen()).toBe(f); // still crossing
    vi.advanceTimersByTime(4_000);
    expect(onScreen()).toBeNull();
    s.stop();
  });

  it('stopping (idle pause, reduced motion) removes the fly-by and plans nothing more', () => {
    const { s, shown, onScreen } = run(true);
    vi.advanceTimersByTime(FLYBY_TIMING.preview.first[1]);
    expect(onScreen()).not.toBeNull();
    s.stop();
    expect(onScreen()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const count = shown.length;
    vi.advanceTimersByTime(60 * 60_000);
    s.finish();
    expect(shown).toHaveLength(count);
  });

  it('holds a fly-by while the page is hidden, with no timer running, and brings it soon after the page is shown', () => {
    let hidden = true;
    const { s, shown } = run(false, () => hidden);
    vi.advanceTimersByTime(60 * 60_000);
    expect(shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0); // nothing ticking in the background
    hidden = false;
    s.wake();
    vi.advanceTimersByTime(FLYBY_TIMING.scheduled.first[1]);
    expect(shown.filter(Boolean)).toHaveLength(1);
    s.stop();
  });

  it('never flies over a screen nobody has touched for a while (a dim kiosk): it waits for the next tap', () => {
    let idle = false;
    const { s, shown, onScreen } = run(false, () => false, () => idle);
    vi.advanceTimersByTime(FLYBY_TIMING.scheduled.first[1]);
    const first = onScreen()!;
    expect(first).not.toBeNull(); // someone is using it: Santa comes
    s.finish();
    // The kiosk is left alone: the next fly-by falls due while it is dim, and is held.
    idle = true;
    vi.advanceTimersByTime(30 * 60_000);
    expect(shown.filter(Boolean)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    // A child taps (the hook marks the activity, so the screen is no longer idle, and wakes the schedule).
    idle = false;
    s.wake();
    s.wake(); // every tap calls it: safe to repeat, still one timer
    expect(vi.getTimerCount()).toBe(1);
    // A child taps: Santa comes within 15-40 s, not after another 4-10 minute gap.
    vi.advanceTimersByTime(FLYBY_TIMING.scheduled.first[0] - 1000);
    expect(onScreen()).toBeNull();
    vi.advanceTimersByTime(FLYBY_TIMING.scheduled.first[1] - FLYBY_TIMING.scheduled.first[0] + 1000);
    expect(onScreen()?.id).toBe(2);
    s.stop();
  });

  it('wake does nothing while a fly-by is on screen or already planned (still one at a time)', () => {
    const { s, shown, onScreen } = run(true);
    s.wake();
    s.wake();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(FLYBY_TIMING.preview.first[1]);
    expect(onScreen()).not.toBeNull();
    s.wake();
    expect(vi.getTimerCount()).toBe(1); // only the safety release for the one crossing
    expect(shown.filter(Boolean)).toHaveLength(1);
    s.stop();
    s.wake();
    expect(vi.getTimerCount()).toBe(0);
  });
});
