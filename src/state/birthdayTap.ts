import { useEffect, useRef } from 'react';
import type { DateKey, FamilyData } from '../types';
import { birthdayAward, yearOf, type BirthdayToday } from '../lib/celebrations';
import type { CelebrationEntry } from '../components/celebrations/Banners';
import type { FamilyActions } from './storeTypes';

// The birthday moment on a shared family screen (a paired kiosk, or the
// browser-only build). On a child's birthday, the first tap or key press on
// this screen opens the celebration and asks for the birthday reward.
//
// The reward itself is guarded by the data source, not by this hook: the
// server gives it at most once per child and year (inside its write
// transaction), so repeated taps, reloads, profile switches and other
// devices can never add it twice. This hook only decides when to ask and
// when to show the celebration. Which screens a celebration is "shown" on is
// remembered per device and day (localStorage), so each kiosk celebrates
// once even when the reward was already given elsewhere.

const SHOWN_PREFIX = 'smart-family-chore-chart:birthday-shown:';

export function shownKey(today: DateKey): string {
  return `${SHOWN_PREFIX}${today}`;
}

export function readShown(storage: Pick<Storage, 'getItem'> | null, today: DateKey): string[] {
  try {
    const raw = storage?.getItem(shownKey(today));
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function writeShown(storage: Pick<Storage, 'setItem' | 'removeItem' | 'length' | 'key'> | null, today: DateKey, ids: string[]): void {
  try {
    if (!storage) return;
    // Forget earlier days.
    for (let i = storage.length - 1; i >= 0; i--) {
      const k = storage.key(i);
      if (k && k.startsWith(SHOWN_PREFIX) && k !== shownKey(today)) storage.removeItem(k);
    }
    storage.setItem(shownKey(today), JSON.stringify([...new Set(ids)]));
  } catch {
    // Best effort: without storage the celebration may show again after a reload.
  }
}

/**
 * Birthdays that still need the first-tap moment on this screen: a reward
 * not given yet, or (with the birthday theme on) a celebration this device
 * hasn't shown today.
 */
export function pendingBirthdays(birthdays: BirthdayToday[], shownHere: string[], visual: boolean): BirthdayToday[] {
  return birthdays.filter((b) => (b.rewardEnabled && !b.claimed) || (visual && !shownHere.includes(b.childId)));
}

/** Ask for each pending reward (one at a time) and collect what to show. */
export async function celebrate(
  pending: BirthdayToday[],
  data: FamilyData,
  today: DateKey,
  claim: FamilyActions['claimBirthdayReward'],
): Promise<CelebrationEntry[]> {
  const entries: CelebrationEntry[] = [];
  for (const b of pending) {
    const child = data.children.find((c) => c.id === b.childId);
    if (!child) continue;
    if (b.rewardEnabled) {
      const r = await claim(b.childId);
      entries.push({ child, award: r.ok ? r.award : null, problem: r.ok ? null : r.error });
    } else {
      entries.push({ child, award: birthdayAward(data, child.id, yearOf(today)) ?? null, problem: null });
    }
  }
  return entries;
}

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export interface BirthdayTapOptions {
  /** A shared screen showing a child-facing page, with no preview running. */
  active: boolean;
  today: DateKey;
  birthdays: BirthdayToday[];
  /** The visual birthday theme is switched on. */
  visual: boolean;
  data: FamilyData;
  claim: FamilyActions['claimBirthdayReward'];
  onCelebrate: (entries: CelebrationEntry[]) => void;
}

export function useBirthdayFirstTap({ active, today, birthdays, visual, data, claim, onCelebrate }: BirthdayTapOptions): void {
  const latest = useRef({ data, claim, onCelebrate });
  latest.current = { data, claim, onCelebrate };
  const busy = useRef(false);
  const pending = active ? pendingBirthdays(birthdays, readShown(storage(), today), visual) : [];
  // Re-arm only when what is pending changes.
  const signature = pending.map((b) => `${b.childId}:${b.claimed ? 1 : 0}`).join(',');

  useEffect(() => {
    if (!signature) return;
    const onFirst = (event: Event) => {
      if (!event.isTrusted || busy.current) return;
      busy.current = true;
      window.removeEventListener('pointerdown', onFirst, true);
      window.removeEventListener('keydown', onFirst, true);
      const due = pendingBirthdays(birthdays, readShown(storage(), today), visual);
      void celebrate(due, latest.current.data, today, latest.current.claim)
        .then((entries) => {
          // A failed reward stays pending (the next tap tries again); the
          // celebration itself is remembered as shown.
          writeShown(storage(), today, [...readShown(storage(), today), ...entries.map((e) => e.child.id)]);
          if (entries.length > 0) latest.current.onCelebrate(entries);
        })
        .finally(() => {
          busy.current = false;
        });
    };
    window.addEventListener('pointerdown', onFirst, true);
    window.addEventListener('keydown', onFirst, true);
    return () => {
      window.removeEventListener('pointerdown', onFirst, true);
      window.removeEventListener('keydown', onFirst, true);
    };
    // `signature` stands for the parts of `birthdays` that matter.
  }, [signature, today, visual]);
}

