import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

// Santa's sleigh flies across the screen now and then (Christmas). A fly-by
// is a special event, not a loop: at most one is on screen, nothing of it
// exists in the page between fly-bys, and the next one is only planned once
// the last has gone. Each crossing is a little different (direction,
// height, rise and fall, speed and size).
//
// No fly-bys while animations are paused (10 minutes without input), with
// reduced motion, or while the page is hidden. A parent's preview shows the
// first one within a few seconds, so there's no long wait to see it.

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
  scheduled: { first: [45_000, 150_000], gap: [240_000, 600_000] },
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
  /** Stop for good (paused, reduced motion, theme gone): drops any fly-by on screen. */
  stop(): void;
}

/**
 * Plans fly-bys one after another, using ONE timer at a time: wait, show a
 * fly-by, wait for it to cross (or let it go after its time plus a margin),
 * then wait again. Calls `show` with the fly-by to draw, or null.
 */
export function startFlybys({
  preview,
  show,
  random = Math.random,
  hidden = () => typeof document !== 'undefined' && document.hidden,
}: {
  preview: boolean;
  show: (flyby: Flyby | null) => void;
  random?: () => number;
  hidden?: () => boolean;
}): FlybySchedule {
  const kind = preview ? 'preview' : 'scheduled';
  let flown = 0;
  let current: Flyby | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const wait = (first: boolean) => {
    timer = setTimeout(() => {
      if (hidden()) {
        wait(false); // nobody is looking: try again later
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
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (current) {
        current = null;
        show(null);
      }
    },
  };
}

/**
 * The fly-by on screen now (or null), and `finish` to call when it has
 * crossed. `active` false (paused, reduced motion) stops everything and
 * clears the screen; becoming active again starts afresh.
 */
export function useFlybys({ active, preview, random = Math.random }: { active: boolean; preview: boolean; random?: () => number }) {
  const [flyby, setFlyby] = useState<Flyby | null>(null);
  const schedule = useRef<FlybySchedule | null>(null);
  useEffect(() => {
    if (!active) return;
    const s = startFlybys({ preview, random, show: setFlyby });
    schedule.current = s;
    return () => {
      s.stop();
      schedule.current = null;
    };
  }, [active, preview, random]);
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
