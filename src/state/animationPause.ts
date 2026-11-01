import { useEffect, useState } from 'react';

// Seasonal animations pause after a long spell without input (the kiosk has
// long since dimmed) and start again at the next tap or key press, so an
// unattended Raspberry Pi isn't animating all night. The decorations stay
// on screen, just still.

export const ANIMATION_PAUSE_MS = 10 * 60 * 1000;

const INPUT = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function useAnimationPause(pauseAfterMs: number = ANIMATION_PAUSE_MS): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let timer = window.setTimeout(() => setPaused(true), pauseAfterMs);
    const onInput = () => {
      window.clearTimeout(timer);
      setPaused(false);
      timer = window.setTimeout(() => setPaused(true), pauseAfterMs);
    };
    for (const type of INPUT) window.addEventListener(type, onInput, { capture: true, passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const type of INPUT) window.removeEventListener(type, onInput, { capture: true });
    };
  }, [pauseAfterMs]);
  return paused;
}
