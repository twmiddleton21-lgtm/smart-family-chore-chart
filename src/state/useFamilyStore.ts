import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Child, Chore, DateKey, FamilyData, FoodCategory, Reward, Settings } from '../types';
import { toggleChore } from '../lib/chores';
import { toDateKey } from '../lib/dates';
import { addFoodOption, removeFoodOption } from '../lib/foodOptions';
import * as manage from '../lib/manage';
import { saveMealWeek, type MealRow } from '../lib/meals';
import { redeemReward, type RedeemResult } from '../lib/rewards';
import {
  STORAGE_KEY,
  getBrowserStorage,
  loadData,
  parseFamilyData,
  resetData,
  saveData,
  type LoadStatus,
} from '../lib/storage';

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Holds the family data in React state and persists every change through
 * the storage layer. Business rules live in src/lib; this hook only wires
 * them to React and localStorage.
 */
export function useFamilyStore() {
  const [boot] = useState(() => {
    const storage = getBrowserStorage();
    return { storage, ...loadData(storage, toDateKey(new Date())) };
  });
  const { storage } = boot;

  const [data, setData] = useState<FamilyData>(boot.data);
  const [loadStatus] = useState<LoadStatus>(boot.status);
  const [saveFailed, setSaveFailed] = useState(boot.status === 'unavailable');

  // Always read the latest data inside actions, even for rapid repeated taps
  // that happen before React re-renders.
  const dataRef = useRef(data);

  const commit = useCallback(
    (next: FamilyData) => {
      dataRef.current = next;
      setData(next);
      setSaveFailed(!saveData(storage, next));
    },
    [storage],
  );

  // Keep multiple open tabs in step: another tab saving replaces our state.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || event.newValue === null) return;
      try {
        const parsed = parseFamilyData(JSON.parse(event.newValue));
        if (parsed) {
          dataRef.current = parsed.data;
          setData(parsed.data);
        }
      } catch {
        // Ignore unreadable updates from other tabs.
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const actions = useMemo(
    () => ({
      toggleChore(choreId: string, date: DateKey): ActionResult {
        const result = toggleChore(dataRef.current, choreId, date);
        if (!result.ok) return result;
        commit(result.data);
        return { ok: true };
      },
      redeemReward(childId: string, rewardId: string, date: DateKey): RedeemResult {
        const result = redeemReward(dataRef.current, childId, rewardId, date);
        if (result.ok) commit(result.data);
        return result;
      },
      saveChild(value: Omit<Child, 'id'>, id?: string) {
        commit(manage.saveChild(dataRef.current, value, id));
      },
      deleteChild(id: string) {
        commit(manage.deleteChild(dataRef.current, id));
      },
      saveMealWeek(childId: string, monday: DateKey, rows: MealRow[]): ActionResult {
        const result = saveMealWeek(dataRef.current, childId, monday, rows, toDateKey(new Date()));
        if (!result.ok) return result;
        commit(result.data);
        return { ok: true };
      },
      addFoodOption(category: FoodCategory, name: string): ActionResult {
        const result = addFoodOption(dataRef.current, category, name);
        if (!result.ok) return result;
        commit(result.data);
        return { ok: true };
      },
      /** Refused (with an explanation) while the option is planned on any day. */
      removeFoodOption(category: FoodCategory, id: string): ActionResult {
        const result = removeFoodOption(dataRef.current, category, id, toDateKey(new Date()));
        if (!result.ok) return result;
        commit(result.data);
        return { ok: true };
      },
      /** Hide the "meal plan running out" popup until tomorrow. */
      dismissMealReminder(today: DateKey) {
        commit(manage.updateSettings(dataRef.current, { mealReminderDismissedOn: today }));
      },
      saveChore(value: Omit<Chore, 'id'>, id?: string) {
        commit(manage.saveChore(dataRef.current, value, id));
      },
      deleteChore(id: string) {
        commit(manage.deleteChore(dataRef.current, id));
      },
      saveReward(value: Omit<Reward, 'id'>, id?: string) {
        commit(manage.saveReward(dataRef.current, value, id));
      },
      deleteReward(id: string) {
        commit(manage.deleteReward(dataRef.current, id));
      },
      updateSettings(patch: Partial<Settings>) {
        commit(manage.updateSettings(dataRef.current, patch));
      },
      resetDemoData() {
        const fresh = resetData(storage, toDateKey(new Date()));
        commit(fresh);
      },
    }),
    [commit, storage],
  );

  return { data, actions, loadStatus, saveFailed };
}

export type FamilyActions = ReturnType<typeof useFamilyStore>['actions'];
