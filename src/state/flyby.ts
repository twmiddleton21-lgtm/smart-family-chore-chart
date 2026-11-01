import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { HOME_IDLE_MS } from './homeIdle';

// Santa's sleigh flies across the screen now and then (Christmas). A fly-by
// is a special event, not a loop: at most one is on screen, nothing of it
// exists in the page between fly-bys, and the next one is only planned once
// the last has gone. Each crossing is a little different (direction,
// height, rise and fall, speed and size).
//
// Fly-bys are for someone to see. On a kiosk the screen dims 2 minutes after
// the last touch (HOME_IDLE_MS, mirrored from the device), so:
//   - the first comes 15-40 s after the screen wakes (page load, or the
//     first tap after the 10-minute animation pause);
//   - a fly-by that falls due while nobody has touched the screen for
//     HOME_IDLE_MS, or while the page is hidden, isn't shown over a dim or
//     hidden screen: it waits for the next tap (or the page being shown
//     again), then comes 15-40 s later;
//   - otherwise they come 4-10 minutes apart.
// (Before this, the first came 45-150 s after waking and a missed one
// waited a full gap, so someone using the kiosk for a minute almost never
// saw Santa.)
//
// No fly-bys while animations are paused (10 minutes without input) or with
// reduced motion. A parent's preview shows the first one within a few
// seconds, so there's no long wait to see it.

export type FlybyDirection = 'ltr' | 'rtl';
/** The overall line across the screen. */
export type FlybyClimb = 'up' | 'down' | 'level';
/** A gentle curve on top of that line. */
export type FlybyArc = 'dip' | 'hump' | 'none';

export interface Flyby {
  id: number;
  direction: FlybyDirection;
  climb: FlybyClimb;
  arc: FlybyArc;
  /** Height of the flight line, in % of the screen height. */
  topVh: number;
  durationS: number;
  scale: number;
  /** Start point of the sleigh's gentle bob (negative delay, seconds). */
  bobDelayS: number;
}

type Range = readonly [number, number];

/** Waits in milliseconds: before the first fly-by, and between fly-bys. */
export const FLYBY_TIMING: Record<'scheduled' | 'preview', { first: Range; gap: Range }> = {
  scheduled: { first: [15_000, 40_000], gap: [240_000, 600_000] },
  preview: { first: [2_000, 3_500], gap: [25_000, 45_000] },
};
export const FLYBY_DURATION_S: Range = [13, 19];
export const FLYBY_TOP_VH: Range = [8, 34];

/** A flight that never reports its end (for example the page was hidden) is let go this long after it should have finished. */
const SAFETY_MS = 4000;

const between = ([lo, hi]: Range, r: number) => lo + (hi - lo) * r;
const round = (n: number, places: number) => Number(n.toFixed(places));
function pick<T>(items: readonly T[], r: number): T {
  return items[Math.min(items.length - 1, Math.floor(r * items.length))]!;
}

export function planFlyby(id: number, random: () => number = Math.random): Flyby {
  return {
    id,
    direction: random() < 0.5 ? 'ltr' : 'rtl',
    climb: pick(['up', 'down', 'level'] as const, random()),
    arc: pick(['dip', 'hump', 'none'] as const, random()),
    topVh: round(between(FLYBY_TOP_VH, random()), 1),
    durationS: round(between(FLYBY_DURATION_S, random()), 1),
    scale: round(between([0.85, 1.1], random()), 2),
    bobDelayS: -round(between([0, 3], random()), 1),
  };
}

export function flybyDelay(kind: 'scheduled' | 'preview', first: boolean, random: () => number = Math.random): number {
  const t = FLYBY_TIMING[kind];
  return Math.round(between(first ? t.first : t.gap, random()));
}

export interface FlybySchedule {
  /** The fly-by on screen has crossed: remove it and plan the next. */
  finish(): void;
  /** Someone is using the screen again: a fly-by held back for a dim or hidden screen comes soon. */
  wake(): void;
  /** Stop for good (paused, reduced motion, theme gone): drops any fly-by on screen. */
  stop(): void;
}

/**
 * Plans fly-bys one after another, using at most ONE timer at a time: wait,
 * show a fly-by, wait for it to cross (or let it go after its time plus a
 * margin), then wait again. A fly-by that falls due while nobody is looking
 * (`hidden` or `idle`) is held, with no timer at all, until `wake`. Calls
 * `show` with the fly-by to draw, or null.
 */
export function startFlybys({
  preview,
  show,
  random = Math.random,
  hidden = () => typeof document !== 'undefined' && document.hidden,
  idle = () => false,
}: {
  preview: boolean;
  show: (flyby: Flyby | null) => void;
  random?: () => number;
  hidden?: () => boolean;
  /** Nobody has touched the screen for a while (a kiosk's display is dim). */
  idle?: () => boolean;
}): FlybySchedule {
  const kind = preview ? 'preview' : 'scheduled';
  let flown = 0;
  let current: Flyby | null = null;
  let stopped = false;
  let held = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const wait = (first: boolean) => {
    timer = setTimeout(() => {
      timer = undefined;
      if (hidden() || idle()) {
        held = true; // nobody is looking: keep it for when someone is
        return;
      }
      flown += 1;
      current = planFlyby(flown, random);
      show(current);
      timer = setTimeout(finish, current.durationS * 1000 + SAFETY_MS);
    }, flybyDelay(kind, first, random));
  };
  function finish() {
    if (stopped || !current) return;
    clearTimeout(timer);
    current = null;
    show(null);
    wait(false);
  }
  wait(true);
  return {
    finish,
    wake() {
      if (stopped || !held) return;
      held = false;
      wait(true);
    },
    stop() {
      stopped = true;
      held = false;
      clearTimeout(timer);
      if (current) {
        current = null;
        show(null);
      }
    },
  };
}

/** Input that means someone is using the screen (the same as the animation pause). */
const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * The fly-by on screen now (or null), and `finish` to call when it has
 * crossed. `active` false (paused, reduced motion) stops everything and
 * clears the screen; becoming active again starts afresh.
 */
export function useFlybys({
  active,
  preview,
  random = Math.random,
  idleAfterMs = HOME_IDLE_MS,
}: {
  active: boolean;
  preview: boolean;
  random?: () => number;
  idleAfterMs?: number;
}) {
  const [flyby, setFlyby] = useState<Flyby | null>(null);
  const schedule = useRef<FlybySchedule | null>(null);
  useEffect(() => {
    if (!active) return;
    // Starting counts as activity: the page has just loaded, or someone has
    // just tapped to end the animation pause.
    let lastInput = Date.now();
    const s = startFlybys({ preview, random, show: setFlyby, idle: () => Date.now() - lastInput >= idleAfterMs });
    schedule.current = s;
    const onActivity = () => {
      lastInput = Date.now();
      s.wake();
    };
    const onVisible = () => {
      if (!document.hidden) onActivity();
    };
    for (const type of ACTIVITY) window.addEventListener(type, onActivity, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      s.stop();
      schedule.current = null;
      for (const type of ACTIVITY) window.removeEventListener(type, onActivity, { capture: true });
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, preview, random, idleAfterMs]);
  const finish = useCallback(() => schedule.current?.finish(), []);
  return { flyby: active ? flyby : null, finish };
}

const REDUCE = '(prefers-reduced-motion: reduce)';
function subscribeMotion(onChange: () => void) {
  const query = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE) : null;
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}
const reducedNow = () => (typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE).matches : false);

/** The browser's reduced-motion setting, kept up to date. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, reducedNow, () => false);
}
