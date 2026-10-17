// Idle detection for the parent area (server builds). After `idleMs` without
// genuine input the watcher calls `onIdle` once, and the caller locks the
// parent area and ends the session.
//
// It never talks to the server: any authenticated request extends the
// server's idle timeout, so a check that polled the server while idle would
// keep the session alive until its 12-hour maximum.
//
// Only trusted pointer, key, wheel and touch events count as input. Focus,
// visibility changes, data refreshes and events dispatched by scripts do
// not. Input in another tab's parent area (same browser, same session)
// counts too, through `shared`, so an idle tab doesn't sign out a parent who
// is busy in another one.

export const PARENT_IDLE_MS = 30 * 60 * 1000;

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
const SHARED_KEY = 'sfcc:parent-activity';
/** Write the shared activity time at most this often. */
const SHARE_EVERY_MS = 5_000;

/** Last parent-area input time shared between this browser's tabs. */
export interface SharedActivity {
  read(): number | null;
  write(at: number): void;
}

export const localStorageActivity: SharedActivity = {
  read() {
    try {
      const value = Number(window.localStorage.getItem(SHARED_KEY));
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  },
  write(at) {
    try {
      window.localStorage.setItem(SHARED_KEY, String(at));
    } catch {
      // Storage unavailable: each tab then only counts its own input.
    }
  },
};

export interface IdleWatchOptions {
  idleMs: number;
  onIdle: () => void;
  /** Where input, focus and the timer live (window in the app). */
  target: EventTarget;
  /** Where visibilitychange fires (document in the app). */
  visibility?: EventTarget;
  shared?: SharedActivity;
  now?: () => number;
  checkEveryMs?: number;
  /** Which input events count (trusted ones only in the app). */
  isGenuine?: (event: Event) => boolean;
}

/** Start watching; returns a function that stops it. */
export function watchIdle(options: IdleWatchOptions): () => void {
  const { idleMs, onIdle, target, visibility, shared } = options;
  const now = options.now ?? (() => Date.now());
  const isGenuine = options.isGenuine ?? ((event: Event) => event.isTrusted);
  let last = now();
  let lastShared = -Infinity;
  let done = false;

  const lastActivity = () => {
    const other = shared?.read() ?? null;
    // Ignore a shared time from the future (clock changes).
    return other !== null && other > last && other <= now() ? other : last;
  };
  const idle = () => now() - lastActivity() >= idleMs;

  const fire = () => {
    if (done) return;
    stop();
    onIdle();
  };
  const check = () => {
    if (idle()) fire();
  };
  const onInput = (event: Event) => {
    if (!isGenuine(event)) return;
    // Input after an unnoticed idle period (timers paused while the device
    // slept) locks rather than counting as activity.
    if (idle()) return fire();
    last = now();
    if (shared && last - lastShared >= SHARE_EVERY_MS) {
      lastShared = last;
      shared.write(last);
    }
  };

  const timer = setInterval(check, options.checkEveryMs ?? 15_000);
  for (const type of INPUT_EVENTS) target.addEventListener(type, onInput, { capture: true, passive: true });
  target.addEventListener('focus', check);
  visibility?.addEventListener('visibilitychange', check);

  function stop() {
    if (done) return;
    done = true;
    clearInterval(timer);
    for (const type of INPUT_EVENTS) target.removeEventListener(type, onInput, { capture: true });
    target.removeEventListener('focus', check);
    visibility?.removeEventListener('visibilitychange', check);
  }
  return stop;
}
