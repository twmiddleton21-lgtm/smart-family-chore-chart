// Return to the home screen after inactivity, on shared family screens (a
// paired kiosk, or the browser-only build). The kiosk dims its own display
// after 2 minutes without input; that is set up on the device, outside this
// app, so the app can't share its timer. It uses the same threshold and the
// same kind of input (taps, keys, wheel), so both run out together.
//
// The app waits while someone is busy: a save still on its way to the server,
// a typed text field, an open editor dialog or an unsaved meal week. It waits
// at most until BUSY_IDLE_LIMIT_MS without input, so an abandoned form never
// keeps the kiosk on a parent screen for good. Navigating away doesn't cancel
// a save: the store applies its answer, and only that screen's message is lost.

/** Same as the kiosk's display-dim timeout. */
export const HOME_IDLE_MS = 2 * 60 * 1000;
/** Longest wait for someone who is busy (saving or editing) but not touching the screen. */
export const BUSY_IDLE_LIMIT_MS = 10 * 60 * 1000;
/** How often the idle time is checked, so home follows the dim within about a second. */
export const HOME_CHECK_EVERY_MS = 1_000;

/** Marks something being edited (an editor dialog, an unsaved form): `data-editing="true"`. */
export const EDITING_ATTRIBUTE = 'data-editing';

export function mayReturnHome(idleForMs: number, busy: boolean): boolean {
  return !busy || idleForMs >= BUSY_IDLE_LIMIT_MS;
}

/** The parts of an element and a document this check reads (a plain object in unit tests). */
interface ElementLike {
  tagName: string;
  type?: string;
  value?: string;
  isContentEditable?: boolean;
  textContent?: string | null;
}
export interface DocumentLike {
  activeElement: ElementLike | null;
  querySelector(selectors: string): unknown;
}

const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'tel', 'url', 'number']);

/**
 * Text typed into the focused field. An empty focused field (e.g. one a
 * dialog focused on opening) is not "typing"; password fields never count,
 * so a typed password isn't left on a kiosk screen.
 */
function typingIn(el: ElementLike | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return (el.textContent ?? '').trim() !== '';
  const tag = el.tagName.toUpperCase();
  const isText = tag === 'TEXTAREA' || (tag === 'INPUT' && TEXT_TYPES.has((el.type ?? '').toLowerCase()));
  return isText && (el.value ?? '').trim() !== '';
}

export function editingInProgress(doc: DocumentLike): boolean {
  return typingIn(doc.activeElement) || doc.querySelector(`[${EDITING_ATTRIBUTE}="true"]`) !== null;
}

/**
 * Wrap a store's actions so `counter.current` is the number of their promises
 * still pending (saves on their way). Other return values pass through.
 */
export function trackPending<T extends object>(actions: T, counter: { current: number }): T {
  const tracked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actions)) {
    if (typeof value !== 'function') {
      tracked[key] = value;
      continue;
    }
    tracked[key] = (...args: unknown[]) => {
      const result: unknown = value.apply(actions, args);
      if (result instanceof Promise) {
        counter.current++;
        const settle = () => {
          counter.current--;
        };
        result.then(settle, settle);
      }
      return result;
    };
  }
  return tracked as T;
}
