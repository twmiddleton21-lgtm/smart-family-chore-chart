import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localStorageActivity, PARENT_IDLE_MS, watchIdle, type IdleWatchOptions, type SharedActivity } from './idle';

const MINUTE = 60_000;

/** An input event the test marks as genuine (real events use isTrusted). */
function input(type = 'pointerdown'): Event {
  return Object.assign(new Event(type), { genuine: true });
}
const isGenuine = (e: Event) => (e as Event & { genuine?: boolean }).genuine === true;

function memoryShared(): SharedActivity & { value: number | null; writes: number } {
  const s = {
    value: null as number | null,
    writes: 0,
    read: () => s.value,
    write: (at: number) => {
      s.value = at;
      s.writes++;
    },
  };
  return s;
}

function start(extra: Partial<IdleWatchOptions> = {}) {
  const target = new EventTarget();
  const visibility = new EventTarget();
  const onIdle = vi.fn();
  const stop = watchIdle({ idleMs: PARENT_IDLE_MS, onIdle, target, visibility, isGenuine, ...extra });
  return { target, visibility, onIdle, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-02T09:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('watchIdle', () => {
  it('locks once after 30 minutes without input, and not before', () => {
    const { onIdle } = start();
    vi.advanceTimersByTime(PARENT_IDLE_MS - 15_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(12 * 60 * MINUTE); // and never again (no polling afterwards)
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('genuine input keeps the parent area open while a parent is using it', () => {
    const { target, onIdle } = start();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(20 * MINUTE);
      target.dispatchEvent(input(['pointerdown', 'keydown', 'wheel', 'touchstart'][i % 4]));
    }
    expect(onIdle).not.toHaveBeenCalled(); // 200 minutes of regular use
    vi.advanceTimersByTime(PARENT_IDLE_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('focus, visibility changes and other non-input events do not count as activity', () => {
    const { target, visibility, onIdle } = start();
    for (let m = 1; m < 30; m++) {
      vi.advanceTimersByTime(MINUTE);
      target.dispatchEvent(new Event('focus'));
      visibility.dispatchEvent(new Event('visibilitychange'));
      target.dispatchEvent(new Event('mousemove'));
      target.dispatchEvent(new Event('scroll'));
    }
    vi.advanceTimersByTime(MINUTE);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('by default only trusted events count: events dispatched by scripts are ignored', () => {
    const target = new EventTarget();
    const onIdle = vi.fn();
    watchIdle({ idleMs: PARENT_IDLE_MS, onIdle, target }); // default isGenuine (isTrusted)
    for (let m = 1; m <= 30; m++) {
      vi.advanceTimersByTime(MINUTE);
      target.dispatchEvent(new Event('pointerdown')); // isTrusted is false
    }
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('input after an unnoticed idle period (timers paused, e.g. device asleep) locks instead of counting', () => {
    const { target, onIdle } = start();
    vi.setSystemTime(Date.now() + 3 * 60 * MINUTE); // clock moved, no timer ran
    target.dispatchEvent(input());
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('regaining focus after an unnoticed idle period locks at once', () => {
    const { target, onIdle } = start();
    vi.setSystemTime(Date.now() + 31 * MINUTE);
    target.dispatchEvent(new Event('focus'));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('input in another tab’s parent area (same browser) counts, through shared activity', () => {
    const shared = memoryShared();
    const a = start({ shared });
    const b = start({ shared });
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(20 * MINUTE);
      b.target.dispatchEvent(input()); // the parent is busy in tab B
    }
    expect(a.onIdle).not.toHaveBeenCalled();
    expect(b.onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PARENT_IDLE_MS);
    expect(a.onIdle).toHaveBeenCalledTimes(1);
    expect(b.onIdle).toHaveBeenCalledTimes(1);
  });

  it('ignores a shared activity time from the future, and limits how often it is written', () => {
    const shared = memoryShared();
    shared.value = Date.now() + 365 * 24 * 60 * MINUTE;
    const { target, onIdle } = start({ shared });
    for (let i = 0; i < 50; i++) target.dispatchEvent(input());
    expect(shared.writes).toBe(1);
    shared.value = Date.now() + 365 * 24 * 60 * MINUTE;
    vi.advanceTimersByTime(PARENT_IDLE_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('still works (this tab only) when browser storage throws', () => {
    const blocked = () => {
      throw new Error('storage blocked');
    };
    vi.stubGlobal('window', { localStorage: { getItem: blocked, setItem: blocked } });
    try {
      const { target, onIdle } = start({ shared: localStorageActivity });
      vi.advanceTimersByTime(20 * MINUTE);
      target.dispatchEvent(input());
      vi.advanceTimersByTime(20 * MINUTE);
      expect(onIdle).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10 * MINUTE);
      expect(onIdle).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stop() removes the timer and listeners: nothing fires after leaving the parent area', () => {
    const { target, onIdle, stop } = start();
    stop();
    vi.advanceTimersByTime(2 * PARENT_IDLE_MS);
    target.dispatchEvent(new Event('focus'));
    target.dispatchEvent(input());
    expect(onIdle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
