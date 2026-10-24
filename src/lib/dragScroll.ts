// Drag-to-scroll fallback for touchscreens that the browser reports as a
// MOUSE (common with Chromium kiosks on a Raspberry Pi when the browser
// doesn't receive real touch events). Real touch input scrolls natively and
// never needs this; it is off unless the kiosk's address asks for it:
//
//   http://<server>/?dragscroll=1
//
// When on, a press-and-drag with the primary mouse button scrolls the
// nearest scrollable area (or the page) instead of selecting text, and the
// click that ends a drag is swallowed so scrolling never ticks a chore.
// A press that moves less than DRAG_THRESHOLD_PX is an ordinary click.

export const DRAG_THRESHOLD_PX = 10;

/** True if the page address opts in (?dragscroll=1, on, true or yes). */
export function dragScrollRequested(search: string): boolean {
  const value = new URLSearchParams(search).get('dragscroll');
  return value !== null && ['1', 'on', 'true', 'yes'].includes(value.toLowerCase());
}

/** One press: decides whether it has become a drag, and by how much to scroll. */
export class DragTracker {
  private lastY: number;
  dragging = false;

  constructor(
    private readonly startX: number,
    private readonly startY: number,
    private readonly threshold = DRAG_THRESHOLD_PX,
  ) {
    this.lastY = startY;
  }

  /** Pointer moved: returns how far to scroll (positive = down), 0 while still a click. */
  move(x: number, y: number): number {
    if (!this.dragging) {
      if (Math.hypot(x - this.startX, y - this.startY) < this.threshold) return 0;
      this.dragging = true;
    }
    const delta = this.lastY - y;
    this.lastY = y;
    return delta;
  }
}

export interface ScrollNode {
  parentElement: ScrollNode | null;
  scrollHeight: number;
  clientHeight: number;
}

/** The nearest ancestor that scrolls vertically, or null for "the page". */
export function findScrollContainer<T extends ScrollNode>(start: T | null, overflowY: (node: T) => string): T | null {
  for (let node = start; node; node = node.parentElement as T | null) {
    if (/(auto|scroll)/.test(overflowY(node)) && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

const EDITABLE = 'input, textarea, select, [contenteditable="true"]';

/** Turn the fallback on for this page. Returns a function that turns it off. */
export function installDragScroll(win: Window = window): () => void {
  const doc = win.document;
  let press: { tracker: DragTracker; container: Element | null } | null = null;
  let swallowClick = false;

  const onDown = (event: PointerEvent) => {
    press = null;
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(EDITABLE)) return; // let people select text in fields
    const container = findScrollContainer<Element>(target, (el) => win.getComputedStyle(el).overflowY);
    press = { tracker: new DragTracker(event.clientX, event.clientY), container };
  };
  const onMove = (event: PointerEvent) => {
    if (!press) return;
    if ((event.buttons & 1) === 0) {
      press = null;
      return;
    }
    const delta = press.tracker.move(event.clientX, event.clientY);
    if (!press.tracker.dragging) return;
    event.preventDefault();
    if (press.container) press.container.scrollTop += delta;
    else win.scrollBy(0, delta);
  };
  const onUp = () => {
    if (press?.tracker.dragging) {
      // The browser sends a click straight after this pointerup; swallow it.
      swallowClick = true;
      win.setTimeout(() => (swallowClick = false), 0);
    }
    press = null;
  };
  const onClick = (event: MouseEvent) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  doc.documentElement.classList.add('drag-scroll');
  win.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  win.addEventListener('pointermove', onMove, { capture: true, passive: false });
  win.addEventListener('pointerup', onUp, { capture: true, passive: true });
  win.addEventListener('pointercancel', onUp, { capture: true, passive: true });
  win.addEventListener('click', onClick, { capture: true });
  return () => {
    doc.documentElement.classList.remove('drag-scroll');
    win.removeEventListener('pointerdown', onDown, { capture: true });
    win.removeEventListener('pointermove', onMove, { capture: true });
    win.removeEventListener('pointerup', onUp, { capture: true });
    win.removeEventListener('pointercancel', onUp, { capture: true });
    win.removeEventListener('click', onClick, { capture: true });
  };
}
