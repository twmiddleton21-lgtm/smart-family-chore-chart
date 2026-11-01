import { describe, expect, it } from 'vitest';
import { THEME_IDS, type CelebrationSettings, type FamilyData } from '../types';
import {
  activeTheme,
  birthdayIn,
  birthdaysToday,
  claimBirthdayReward,
  customDatesFor,
  daysBetween,
  defaultCelebrationSettings,
  defaultRange,
  easterSunday,
  holidayDate,
  isBirthdayOn,
  nextBirthday,
  occurrenceFor,
  parseCelebrationSettings,
  recentBonusAwards,
  removeBirthday,
  seasonGreeting,
  setBirthday,
  shiftDate,
  themeStatus,
  toBirthday,
  toBonusAward,
  validCelebrationSettings,
  validateBirthday,
  weekdayOfKey,
} from './celebrations';
import { pointsBalance } from './points';
import { deleteChild } from './manage';
import { makeFamily } from './testFixtures';

const settings = (patch: (s: CelebrationSettings) => void = () => {}): CelebrationSettings => {
  const s = defaultCelebrationSettings();
  patch(s);
  return s;
};
const NOW = new Date('2026-03-12T07:30:00Z');

describe('whole-day calendar arithmetic', () => {
  it('counts days across month, year and leap-day boundaries without time zones', () => {
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2); // UK clocks change on 29 March 2026
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2); // and on 25 October 2026
    expect(shiftDate('2026-12-30', 5)).toBe('2027-01-04');
    expect(shiftDate('2027-01-02', -5)).toBe('2026-12-28');
    expect(weekdayOfKey('2026-10-31')).toBe(6); // Saturday
  });
});

describe('Easter Sunday', () => {
  it.each([
    [2008, '2008-03-23'],
    [2011, '2011-04-24'],
    [2019, '2019-04-21'],
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2028, '2028-04-16'],
    [2029, '2029-04-01'],
    [2030, '2030-04-21'],
    [2038, '2038-04-25'],
    [2285, '2285-03-22'],
  ])('%i → %s', (year, date) => {
    expect(easterSunday(year)).toBe(date);
    expect(weekdayOfKey(easterSunday(year))).toBe(0);
  });
});

describe('default dates (week-of rule)', () => {
  it('uses the Monday–Sunday week containing the holiday', () => {
    expect(defaultRange('halloween', 2026)).toEqual({ start: '2026-10-26', end: '2026-11-01' }); // Sat 31 Oct
    expect(defaultRange('halloween', 2027)).toEqual({ start: '2027-10-25', end: '2027-10-31' }); // Sun 31 Oct
    expect(defaultRange('halloween', 2028)).toEqual({ start: '2028-10-30', end: '2028-11-05' }); // Tue 31 Oct
    expect(defaultRange('valentines', 2027)).toEqual({ start: '2027-02-08', end: '2027-02-14' });
    expect(defaultRange('valentines', 2028)).toEqual({ start: '2028-02-14', end: '2028-02-20' }); // a Monday
  });

  it('moves Easter with the date of Easter Sunday each year', () => {
    expect(defaultRange('easter', 2026)).toEqual({ start: '2026-03-30', end: '2026-04-05' });
    expect(defaultRange('easter', 2027)).toEqual({ start: '2027-03-22', end: '2027-03-28' });
    expect(defaultRange('easter', 2028)).toEqual({ start: '2028-04-10', end: '2028-04-16' });
  });

  it('gives New Year a week that crosses the year boundary', () => {
    expect(holidayDate('newYear', 2027)).toBe('2027-01-01');
    expect(defaultRange('newYear', 2027)).toEqual({ start: '2026-12-28', end: '2027-01-03' }); // Fri 1 Jan
    expect(defaultRange('newYear', 2028)).toEqual({ start: '2027-12-27', end: '2028-01-02' }); // Sat 1 Jan
  });

  it('runs Christmas from 1 November to 25 December', () => {
    expect(defaultRange('christmas', 2026)).toEqual({ start: '2026-11-01', end: '2026-12-25' });
    expect(defaultRange('christmas', 2031)).toEqual({ start: '2031-11-01', end: '2031-12-25' });
  });
});

describe('which theme shows', () => {
  const on = (date: string, s = settings()) => activeTheme(s, date)?.themeId ?? null;

  it('activates each theme on its dates only', () => {
    expect(on('2026-10-25')).toBeNull();
    expect(on('2026-10-26')).toBe('halloween');
    expect(on('2026-10-31')).toBe('halloween');
    expect(on('2026-11-02')).toBe('christmas');
    expect(on('2026-12-25')).toBe('christmas');
    expect(on('2026-12-26')).toBeNull();
    expect(on('2026-12-28')).toBe('newYear');
    expect(on('2027-01-03')).toBe('newYear');
    expect(on('2027-01-04')).toBeNull();
    expect(on('2027-02-14')).toBe('valentines');
    expect(on('2027-03-25')).toBe('easter');
    expect(on('2027-04-05')).toBeNull();
  });

  it('shows Christmas throughout 1 November – 25 December', () => {
    for (let d = '2027-11-01'; d <= '2027-12-25'; d = shiftDate(d, 1)) expect(on(d)).toBe('christmas');
  });

  it('lets the most recently started theme win where two overlap (1 Nov 2026: Halloween week and Christmas)', () => {
    expect(themeStatus('halloween', settings().themes.halloween, '2026-11-01').state).toBe('active');
    expect(on('2026-11-01')).toBe('christmas');
  });

  it('never shows a switched-off theme, and reports it as disabled', () => {
    const s = settings((x) => {
      x.themes.halloween.enabled = false;
    });
    expect(on('2026-10-31', s)).toBeNull();
    const status = themeStatus('halloween', s.themes.halloween, '2026-10-31');
    expect(status.state).toBe('disabled');
    expect(status.occurrence.start).toBe('2026-10-26'); // still says when it would be
  });

  it('reports the next showing, including next year’s', () => {
    expect(themeStatus('halloween', settings().themes.halloween, '2026-11-02')).toMatchObject({
      state: 'upcoming',
      occurrence: { start: '2027-10-25', end: '2027-10-31' },
    });
    expect(themeStatus('newYear', settings().themes.newYear, '2026-10-31').occurrence.start).toBe('2026-12-28');
    expect(themeStatus('easter', settings().themes.easter, '2026-10-31').occurrence.holiday).toBe('2027-03-28');
  });
});

describe('parents’ own dates', () => {
  it('turns chosen dates into offsets from the holiday', () => {
    expect(customDatesFor('2026-12-25', '2026-11-15', '2026-12-26')).toEqual({ ok: true, value: { startOffset: -40, endOffset: 1 } });
  });

  it('keeps the same dates around fixed holidays every year, and never changes them at a new year', () => {
    const s = settings((x) => {
      x.themes.christmas.custom = { startOffset: -40, endOffset: 1 };
    });
    expect(occurrenceFor('christmas', 2026, s.themes.christmas)).toMatchObject({ start: '2026-11-15', end: '2026-12-26', custom: true });
    expect(occurrenceFor('christmas', 2027, s.themes.christmas)).toMatchObject({ start: '2027-11-15', end: '2027-12-26' });
    expect(s.themes.christmas.custom).toEqual({ startOffset: -40, endOffset: 1 });
    expect(activeTheme(s, '2026-11-14')).toBeNull();
    expect(activeTheme(s, '2026-12-26')?.themeId).toBe('christmas');
  });

  it('follows Easter when it moves (Palm Sunday to Easter Monday)', () => {
    const s = settings((x) => {
      x.themes.easter.custom = { startOffset: -7, endOffset: 1 };
    });
    expect(occurrenceFor('easter', 2026, s.themes.easter)).toMatchObject({ start: '2026-03-29', end: '2026-04-06' });
    expect(occurrenceFor('easter', 2027, s.themes.easter)).toMatchObject({ start: '2027-03-21', end: '2027-03-29' });
  });

  it('handles own dates that cross the year boundary', () => {
    const s = settings((x) => {
      x.themes.newYear.custom = { startOffset: -6, endOffset: 5 }; // 26 Dec – 6 Jan
    });
    expect(activeTheme(s, '2026-12-26')?.holiday).toBe('2027-01-01');
    expect(activeTheme(s, '2027-01-06')?.holiday).toBe('2027-01-01');
    expect(activeTheme(s, '2027-01-07')).toBeNull();
    expect(activeTheme(s, '2027-12-31')?.holiday).toBe('2028-01-01');
  });

  it('rejects impossible or unreasonable dates', () => {
    expect(customDatesFor('2026-12-25', '2026-12-20', '2026-12-10').ok).toBe(false);
    expect(customDatesFor('2026-12-25', '2026-02-30', '2026-12-10').ok).toBe(false);
    expect(customDatesFor('2026-12-25', '2026-06-01', '2026-12-25').ok).toBe(false); // over 100 days
    expect(customDatesFor('2026-12-25', '2027-06-01', '2027-06-05').ok).toBe(false); // far from the holiday
  });

  it('restoring the defaults uses the recurring default again', () => {
    const s = settings((x) => {
      x.themes.halloween.custom = { startOffset: -3, endOffset: 0 };
    });
    s.themes.halloween.custom = null;
    expect(occurrenceFor('halloween', 2026, s.themes.halloween)).toMatchObject({ start: '2026-10-26', custom: false });
  });
});

describe('countdowns', () => {
  const xmas = (today: string) => seasonGreeting(activeTheme(settings(), today)!, today);
  it('counts down to Christmas', () => {
    expect(xmas('2026-11-01')).toEqual({ headline: '54 days to Christmas!', daysToGo: 54 });
    expect(xmas('2026-12-23')).toEqual({ headline: '2 days to Christmas!', daysToGo: 2 });
    expect(xmas('2026-12-24').headline).toBe('It’s Christmas Eve! 1 day to go!');
    expect(xmas('2026-12-25')).toEqual({ headline: 'Merry Christmas!', daysToGo: 0 });
  });

  it('counts across a year boundary, to the right Christmas', () => {
    const s = settings((x) => {
      x.themes.christmas.custom = { startOffset: -10, endOffset: 12 }; // 15 Dec – 6 Jan
      x.themes.newYear.enabled = false; // otherwise New Year's week (started later) wins on 2 January
    });
    expect(activeTheme(settings((x) => (x.themes.christmas.custom = { startOffset: -10, endOffset: 12 })), '2027-01-02')?.themeId).toBe('newYear');
    const o = activeTheme(s, '2027-01-02')!;
    expect(o.holiday).toBe('2026-12-25');
    expect(seasonGreeting(o, '2027-01-02')).toEqual({ headline: 'Happy holidays!', daysToGo: null });
    const preview = themeStatus('christmas', settings().themes.christmas, '2027-01-02').occurrence;
    expect(seasonGreeting(preview, '2027-01-02').daysToGo).toBe(357);
  });

  it('counts down to the New Year, naming the coming year', () => {
    const ny = (today: string) => seasonGreeting(activeTheme(settings(), today)!, today);
    expect(ny('2026-12-28')).toEqual({ headline: '4 days until 2027!', daysToGo: 4 });
    expect(ny('2026-12-31').headline).toBe('It’s New Year’s Eve! 1 day until 2027!');
    expect(ny('2027-01-01')).toEqual({ headline: 'Happy New Year 2027!', daysToGo: 0 });
    expect(ny('2027-01-03').headline).toBe('Happy New Year 2027!');
  });
});

describe('stored settings', () => {
  it('accepts valid settings and repairs damaged ones to the defaults', () => {
    const good = settings((x) => {
      x.themes.easter.custom = { startOffset: -7, endOffset: 1 };
      x.birthdaysEnabled = false;
    });
    expect(parseCelebrationSettings(JSON.parse(JSON.stringify(good)))).toEqual({ settings: good, repaired: false });
    const bad = parseCelebrationSettings({ themes: { halloween: { enabled: 'yes', custom: null } }, birthdaysEnabled: 1 });
    expect(bad.repaired).toBe(true);
    expect(bad.settings).toEqual(defaultCelebrationSettings());
    expect(parseCelebrationSettings({ themes: { ...good.themes, christmas: { enabled: true, custom: { startOffset: 5, endOffset: -5 } } }, birthdaysEnabled: true }).repaired).toBe(true);
  });

  it('only accepts complete settings from a device', () => {
    const good = settings();
    expect(validCelebrationSettings(good)).toEqual(good);
    const { christmas: _c, ...missing } = good.themes;
    expect(validCelebrationSettings({ ...good, themes: missing })).toBeNull();
    expect(validCelebrationSettings({ ...good, themes: { ...good.themes, diwali: { enabled: true, custom: null } } })).toBeNull();
    expect(validCelebrationSettings({ ...good, extra: 1 })).toBeNull();
    expect(THEME_IDS).toHaveLength(5);
  });
});

// ---------- Birthdays ----------

function withBirthday(patch: Partial<{ month: number; day: number; enabled: boolean; points: number; gift: string }> = {}): FamilyData {
  return setBirthday(makeFamily(), {
    childId: 'a',
    month: patch.month ?? 3,
    day: patch.day ?? 12,
    reward: { enabled: patch.enabled ?? true, points: patch.points ?? 50, gift: patch.gift ?? 'Cinema trip' },
  });
}

describe('birthday dates', () => {
  it('matches only the right day', () => {
    const b = { month: 3, day: 12 };
    expect(isBirthdayOn(b, '2026-03-12')).toBe(true);
    expect(isBirthdayOn(b, '2026-03-11')).toBe(false);
    expect(isBirthdayOn(b, '2027-03-12')).toBe(true);
  });

  it('celebrates 29 February on 28 February in other years', () => {
    const leap = { month: 2, day: 29 };
    expect(birthdayIn(leap, 2027)).toBe('2027-02-28');
    expect(birthdayIn(leap, 2028)).toBe('2028-02-29');
    expect(isBirthdayOn(leap, '2027-02-28')).toBe(true);
    expect(isBirthdayOn(leap, '2028-02-28')).toBe(false);
    expect(isBirthdayOn(leap, '2028-02-29')).toBe(true);
  });

  it('finds the next birthday, across the year end', () => {
    expect(nextBirthday({ month: 1, day: 5 }, '2026-12-30')).toBe('2027-01-05');
    expect(nextBirthday({ month: 12, day: 30 }, '2026-12-30')).toBe('2026-12-30');
  });

  it('lists today’s birthdays for the right child only', () => {
    const data = withBirthday();
    expect(birthdaysToday(data, '2026-03-12')).toEqual([{ childId: 'a', rewardEnabled: true, claimed: false }]);
    expect(birthdaysToday(data, '2026-03-13')).toEqual([]);
  });
});

describe('birthday reward', () => {
  it('is given once, with points in the balance and the gift in the record', () => {
    const data = withBirthday();
    const before = pointsBalance(data, 'a');
    const first = claimBirthdayReward(data, 'a', '2026-03-12', NOW);
    expect(first.ok && first.awarded).toBe(true);
    if (!first.ok) return;
    expect(first.award).toMatchObject({ childId: 'a', kind: 'birthday', year: 2026, date: '2026-03-12', points: 50, note: 'Cinema trip', awardedAt: NOW.toISOString() });
    expect(pointsBalance(first.data, 'a')).toBe(before + 50);
    expect(pointsBalance(first.data, 'b')).toBe(pointsBalance(data, 'b'));
    expect(birthdaysToday(first.data, '2026-03-12')[0]!.claimed).toBe(true);

    const again = claimBirthdayReward(first.data, 'a', '2026-03-12', NOW);
    expect(again).toMatchObject({ ok: true, awarded: false });
    if (again.ok) {
      expect(again.data).toBe(first.data);
      expect(again.award.id).toBe(first.award.id);
    }
  });

  it('is given again next year (once per birthday year)', () => {
    const y1 = claimBirthdayReward(withBirthday(), 'a', '2026-03-12', NOW);
    if (!y1.ok) throw new Error(y1.error);
    const y2 = claimBirthdayReward(y1.data, 'a', '2027-03-12', NOW);
    expect(y2.ok && y2.awarded).toBe(true);
    if (y2.ok) expect(y2.data.bonusAwards.map((a) => a.year)).toEqual([2026, 2027]);
  });

  it('is refused on the wrong day, for the wrong child, or when switched off', () => {
    expect(claimBirthdayReward(withBirthday(), 'a', '2026-03-13', NOW)).toEqual({ ok: false, error: 'It isn’t Alex’s birthday today.' });
    expect(claimBirthdayReward(withBirthday(), 'b', '2026-03-12', NOW).ok).toBe(false);
    expect(claimBirthdayReward(withBirthday(), 'nobody', '2026-03-12', NOW).ok).toBe(false);
    expect(claimBirthdayReward(withBirthday({ enabled: false }), 'a', '2026-03-12', NOW).ok).toBe(false);
  });

  it('records a gift with zero points', () => {
    const r = claimBirthdayReward(withBirthday({ points: 0, gift: 'Choose dinner' }), 'a', '2026-03-12', NOW);
    expect(r.ok && r.awarded).toBe(true);
    if (r.ok) {
      expect(r.award).toMatchObject({ points: 0, note: 'Choose dinner' });
      expect(pointsBalance(r.data, 'a')).toBe(pointsBalance(makeFamily(), 'a'));
    }
  });

  it('works from a paired device’s copy, which has no award day or time: same points, newest year first, still once per year', () => {
    const y1 = claimBirthdayReward(withBirthday(), 'a', '2026-03-12', NOW);
    if (!y1.ok) throw new Error(y1.error);
    const y2 = claimBirthdayReward(y1.data, 'a', '2027-03-12', NOW);
    if (!y2.ok) throw new Error(y2.error);
    const shared: FamilyData = { ...y2.data, birthdays: [], bonusAwards: y2.data.bonusAwards.map(({ date: _d, awardedAt: _t, ...rest }) => rest) };
    expect(pointsBalance(shared, 'a')).toBe(pointsBalance(y2.data, 'a'));
    expect(recentBonusAwards(shared, 'a').map((a) => a.year)).toEqual([2027, 2026]);
    expect(recentBonusAwards(y2.data, 'a').map((a) => a.year)).toEqual([2027, 2026]);
    expect(birthdaysToday({ ...y2.data, bonusAwards: shared.bonusAwards }, '2027-03-12')[0]!.claimed).toBe(true);
  });

  it('keeps a given reward when the birthday is removed, and removes both with the child', () => {
    const r = claimBirthdayReward(withBirthday(), 'a', '2026-03-12', NOW);
    if (!r.ok) throw new Error(r.error);
    const removed = removeBirthday(r.data, 'a');
    expect(removed.birthdays).toEqual([]);
    expect(pointsBalance(removed, 'a')).toBe(50);
    const gone = deleteChild(r.data, 'a');
    expect(gone.birthdays).toEqual([]);
    expect(gone.bonusAwards).toEqual([]);
  });
});

describe('birthday form and record validation', () => {
  const draft = { month: '3', day: '12', rewardEnabled: true, points: '50', gift: '  Cinema   trip ' };
  it('accepts a birthday with no year and tidies the gift', () => {
    expect(validateBirthday(draft)).toEqual({ ok: true, value: { month: 3, day: 12, reward: { enabled: true, points: 50, gift: 'Cinema trip' } } });
  });
  it('rejects impossible days and missing rewards', () => {
    expect(validateBirthday({ ...draft, month: '2', day: '30' }).ok).toBe(false);
    expect(validateBirthday({ ...draft, month: '4', day: '31' }).ok).toBe(false);
    expect(validateBirthday({ ...draft, month: '2', day: '29' }).ok).toBe(true);
    expect(validateBirthday({ ...draft, month: '' }).ok).toBe(false);
    expect(validateBirthday({ ...draft, points: '1001' }).ok).toBe(false);
    expect(validateBirthday({ ...draft, points: '0', gift: '' }).ok).toBe(false);
    expect(validateBirthday({ ...draft, rewardEnabled: false, points: '0', gift: '' }).ok).toBe(true);
    expect(validateBirthday({ ...draft, gift: 'x'.repeat(61) }).ok).toBe(false);
  });
  it('checks stored records strictly', () => {
    expect(toBirthday({ childId: 'a', month: 2, day: 30, reward: { enabled: true, points: 1, gift: '' } })).toBeNull();
    expect(toBirthday({ childId: 'a', month: 2, day: 29, reward: { enabled: true, points: 1, gift: '' } })).not.toBeNull();
    expect(toBirthday({ childId: 'a', month: 2, day: 29, year: 2019, reward: { enabled: true, points: 1, gift: '' } })).not.toHaveProperty('year');
    const award = { id: 'x', childId: 'a', kind: 'birthday', year: 2026, date: '2026-03-12', points: 5, note: '', awardedAt: NOW.toISOString() };
    expect(toBonusAward(award)).toEqual(award);
    expect(toBonusAward({ ...award, year: 2025 })).toBeNull();
    expect(toBonusAward({ ...award, kind: 'other' })).toBeNull();
  });
});
