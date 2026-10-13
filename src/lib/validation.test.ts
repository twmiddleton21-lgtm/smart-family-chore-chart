import { describe, expect, it } from 'vitest';
import { validateChild, validateChore, validatePin, validateReward, type ChoreDraft } from './validation';

const baseChore: ChoreDraft = {
  title: 'Feed the fish',
  icon: '🐟',
  childId: 'a',
  period: 'morning',
  points: '5',
  scheduleType: 'daily',
  days: [],
};

describe('chore validation', () => {
  it('accepts a valid chore and trims text', () => {
    const r = validateChore({ ...baseChore, title: '  Feed   the fish ' }, ['a']);
    expect(r).toEqual({
      ok: true,
      value: { title: 'Feed the fish', icon: '🐟', childId: 'a', period: 'morning', points: 5, schedule: { type: 'daily' } },
    });
  });

  it.each(['', 'abc', '-3', '2.5', '0', '101', '1e2', ' '])('rejects invalid points %j', (points) => {
    const r = validateChore({ ...baseChore, points }, ['a']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.points).toBeTruthy();
  });

  it('requires a title, a known child and a valid period', () => {
    const r = validateChore({ ...baseChore, title: ' ', childId: 'zzz', period: 'night' }, ['a']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.title).toBeTruthy();
      expect(r.errors.childId).toBeTruthy();
      expect(r.errors.period).toBeTruthy();
    }
  });

  it('requires at least one day for a weekly schedule', () => {
    const r = validateChore({ ...baseChore, scheduleType: 'weekly', days: [] }, ['a']);
    expect(r.ok).toBe(false);
    const good = validateChore({ ...baseChore, scheduleType: 'weekly', days: [5, 1, 1] }, ['a']);
    expect(good.ok && good.value.schedule).toEqual({ type: 'weekly', days: [1, 5] });
  });

  it('falls back to a default icon when none is given', () => {
    const r = validateChore({ ...baseChore, icon: '' }, ['a']);
    expect(r.ok && r.value.icon).toBe('⭐');
  });
});

describe('reward validation', () => {
  it('accepts a valid reward', () => {
    const r = validateReward({ name: 'Ice cream', description: '', icon: '🍦', cost: '30' });
    expect(r.ok).toBe(true);
  });

  it.each(['0', '-1', '1001', 'ten', '3.5'])('rejects invalid cost %j', (cost) => {
    const r = validateReward({ name: 'X', description: '', icon: '🎁', cost });
    expect(r.ok).toBe(false);
  });
});

describe('child validation', () => {
  it('requires a name, avatar and known colour', () => {
    expect(validateChild({ name: 'Sam', avatar: '🐼', color: 'teal' }).ok).toBe(true);
    const r = validateChild({ name: '', avatar: '', color: 'neon' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['avatar', 'color', 'name']);
  });

  it('limits name length', () => {
    expect(validateChild({ name: 'x'.repeat(21), avatar: '🐼', color: 'teal' }).ok).toBe(false);
  });
});

describe('PIN validation', () => {
  it('accepts 4–8 digits only', () => {
    expect(validatePin('1234')).toBeNull();
    expect(validatePin('12345678')).toBeNull();
    expect(validatePin('123')).not.toBeNull();
    expect(validatePin('123456789')).not.toBeNull();
    expect(validatePin('12a4')).not.toBeNull();
  });
});
