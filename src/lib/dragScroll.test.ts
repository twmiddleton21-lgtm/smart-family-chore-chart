import { describe, expect, it } from 'vitest';
import { DragTracker, dragScrollRequested, findScrollContainer, type ScrollNode } from './dragScroll';

describe('drag-to-scroll opt-in', () => {
  it('is off unless the address asks for it', () => {
    expect(dragScrollRequested('')).toBe(false);
    expect(dragScrollRequested('?dragscroll=0')).toBe(false);
    expect(dragScrollRequested('?other=1')).toBe(false);
    for (const on of ['?dragscroll=1', '?dragscroll=on', '?x=2&dragscroll=TRUE', '?dragscroll=yes']) {
      expect(dragScrollRequested(on)).toBe(true);
    }
  });
});

describe('DragTracker', () => {
  it('treats a small wobble as a click (no scrolling)', () => {
    const t = new DragTracker(100, 500);
    expect(t.move(103, 505)).toBe(0);
    expect(t.move(96, 494)).toBe(0);
    expect(t.dragging).toBe(false);
  });

  it('becomes a drag past the threshold and scrolls opposite to the finger', () => {
    const t = new DragTracker(100, 500);
    expect(t.move(100, 480)).toBe(20); // finger up 20px: content scrolls down 20px
    expect(t.dragging).toBe(true);
    expect(t.move(100, 450)).toBe(30);
    expect(t.move(100, 470)).toBe(-20); // finger back down: scroll up
  });
});

describe('findScrollContainer', () => {
  const node = (overflow: string, scrollHeight: number, clientHeight: number, parentElement: Node | null = null) => ({
    overflow,
    scrollHeight,
    clientHeight,
    parentElement,
  });
  type Node = ScrollNode & { overflow: string };
  const overflowOf = (n: Node) => n.overflow;

  it('finds the nearest ancestor that actually scrolls', () => {
    const dialog = node('auto', 900, 400);
    const button = node('visible', 50, 50, node('visible', 300, 300, dialog));
    expect(findScrollContainer<Node>(button, overflowOf)).toBe(dialog);
  });

  it('skips scroll containers with nothing to scroll, falling back to the page', () => {
    const short = node('auto', 200, 200);
    expect(findScrollContainer<Node>(node('visible', 10, 10, short), overflowOf)).toBeNull();
    expect(findScrollContainer<Node>(null, overflowOf)).toBeNull();
  });
});
