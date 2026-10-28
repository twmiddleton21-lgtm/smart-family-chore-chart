import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUSY_IDLE_LIMIT_MS,
  HOME_CHECK_EVERY_MS,
  HOME_IDLE_MS,
  editingInProgress,
  mayReturnHome,
  trackPending,
  type DocumentLike,
} from './homeIdle';
import { watchIdle } from './idle';

const MINUTE = 60_000;

function doc(active: DocumentLike['activeElement'], editingMarked = false): DocumentLike {
  return { activeElement: active, querySelector: (s) => (editingMarked && s === '[data-editing="true"]' ? {} : null) };
}

describe('mayReturnHome', () => {
  it('returns home at once when nobody is busy, and waits up to the limit while someone is', () => {
    expect(HOME_IDLE_MS).toBe(2 * MINUTE);
    expect(mayReturnHome(HOME_IDLE_MS, false)).toBe(true);
    expect(mayReturnHome(HOME_IDLE_MS, true)).toBe(false);
    expect(mayReturnHome(BUSY_IDLE_LIMIT_MS - 1, true)).toBe(false);
    expect(mayReturnHome(BUSY_IDLE_LIMIT_MS, true)).toBe(true);
  });
});

describe('editingInProgress', () => {
  it('counts text typed into the focused field', () => {
    expect(editingInProgress(doc({ tagName: 'INPUT', type: 'text', value: 'Feed the cat' }))).toBe(true);
    expect(editingInProgress(doc({ tagName: 'TEXTAREA', value: 'note' }))).toBe(true);
    expect(editingInProgress(doc({ tagName: 'INPUT', type: 'number', value: '5' }))).toBe(true);
    expect(editingInProgress(doc({ tagName: 'DIV', isContentEditable: true, textContent: 'x' }))).toBe(true);
  });

  it('does not count an empty focused field, a button, or a password', () => {
    expect(editingInProgress(doc({ tagName: 'INPUT', type: 'text', value: '  ' }))).toBe(false);
    expect(editingInProgress(doc({ tagName: 'BUTTON', value: 'x' }))).toBe(false);
    expect(editingInProgress(doc({ tagName: 'INPUT', type: 'password', value: 'secret' }))).toBe(false);
    expect(editingInProgress(doc({ tagName: 'INPUT', type: 'checkbox', value: 'on' }))).toBe(false);
    expect(editingInProgress(doc(null))).toBe(false);
  });

  it('counts an open editor dialog or unsaved form (data-editing="true")', () => {
    expect(editingInProgress(doc({ tagName: 'BUTTON' }, true))).toBe(true);
  });
});

describe('trackPending', () => {
  it('counts promises until they settle, resolved or rejected, and passes other results through', async () => {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const actions = {
      save: () => new Promise<void>((r) => (resolve = r)),
      fail: () => new Promise<void>((_, j) => (reject = j)),
      versionOf: (key: string) => key.length,
    };
    const counter = { current: 0 };
    const tracked = trackPending(actions, counter);
    expect(tracked.versionOf('abc')).toBe(3);
    expect(counter.current).toBe(0);
    const saving = tracked.save();
    const failing = tracked.fail();
    expect(counter.current).toBe(2);
    resolve();
    await saving;
    expect(counter.current).toBe(1);
    reject(new Error('offline'));
    await expect(failing).rejects.toThrow('offline');
    expect(counter.current).toBe(0);
  });
});

describe('return home after inactivity (watchIdle with the home policy)', () => {
  const genuine = (type = 'pointerdown') => Object.assign(new Event(type), { genuine: true });
  const isGenuine = (e: Event) => (e as Event & { genuine?: boolean }).genuine === true;

  function startHome(busy: () => boolean) {
    const target = new EventTarget();
    const onIdle = vi.fn();
    watchIdle({
      idleMs: HOME_IDLE_MS,
      onIdle,
      target,
      isGenuine,
      checkEveryMs: HOME_CHECK_EVERY_MS,
      canFire: (idleFor) => mayReturnHome(idleFor, busy()),
    });
    return { target, onIdle };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T09:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('goes home within a second of 2 minutes without input', () => {
    const { onIdle } = startHome(() => false);
    vi.advanceTimersByTime(HOME_IDLE_MS - 1_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('every genuine tap or key restarts the 2 minutes', () => {
    const { target, onIdle } = startHome(() => false);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(90_000);
      target.dispatchEvent(genuine(i % 2 ? 'keydown' : 'touchstart'));
    }
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HOME_IDLE_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('waits while someone is busy, then goes home once they finish', () => {
    let busy = true;
    const { onIdle } = startHome(() => busy);
    vi.advanceTimersByTime(5 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
    busy = false; // e.g. the save answered
    vi.advanceTimersByTime(HOME_CHECK_EVERY_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('an abandoned form keeps the screen for at most 10 minutes without input', () => {
    const { onIdle } = startHome(() => true);
    vi.advanceTimersByTime(BUSY_IDLE_LIMIT_MS - 1_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
