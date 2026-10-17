import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FamilyData } from '../types';
import { toggleChore } from '../lib/chores';
import { toDateKey } from '../lib/dates';
import { toExportFile } from '../lib/exportFile';
import { addFoodOption, removeFoodOption } from '../lib/foodOptions';
import * as manage from '../lib/manage';
import { saveMealWeek } from '../lib/meals';
import { redeemReward } from '../lib/rewards';
import { STORAGE_KEY, getBrowserStorage, loadData, parseFamilyData, resetData, saveData } from '../lib/storage';
import { validatePin } from '../lib/validation';
import type { ActionResult, FamilyActions, FamilyStore } from './storeTypes';
import { useToday } from './time';

// Browser-local data source: the released v0.3.0 behaviour, unchanged.
// Family data lives in this browser's localStorage only. Business rules live
// in src/lib; this hook only wires them to React and localStorage.

const LOAD_MESSAGES: Partial<Record<string, string>> = {
  recovered:
    'Saved data could not be read, so the sample family has been loaded. A copy of the old data was kept in browser storage.',
  repaired: 'Some saved items were damaged and have been skipped. Everything else loaded normally.',
};

const OK: ActionResult = { ok: true };
const fail = (error: string): ActionResult => ({ ok: false, error, kind: 'local' });
const unsupported = (error: string) => ({ ok: false as const, error, kind: 'unsupported' as const });

export function useLocalFamilyStore(): FamilyStore {
  const today = useToday();
  const [boot] = useState(() => {
    const storage = getBrowserStorage();
    return { storage, ...loadData(storage, toDateKey(new Date())) };
  });
  const { storage } = boot;

  const [data, setData] = useState<FamilyData>(boot.data);
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

  const actions = useMemo<FamilyActions>(() => {
    const now = () => toDateKey(new Date());
    const fromResult = (r: { ok: true; data: FamilyData } | { ok: false; error: string }): ActionResult => {
      if (!r.ok) return fail(r.error);
      commit(r.data);
      return OK;
    };
    const commitOk = (next: FamilyData): ActionResult => {
      commit(next);
      return OK;
    };
    return {
      toggleChore: async (choreId) => fromResult(toggleChore(dataRef.current, choreId, now())),
      redeemReward: async (childId, rewardId) => fromResult(redeemReward(dataRef.current, childId, rewardId, now())),
      dismissMealReminder: async () => commitOk(manage.updateSettings(dataRef.current, { mealReminderDismissedOn: now() })),
      saveChild: async (value, id) => commitOk(manage.saveChild(dataRef.current, value, id)),
      deleteChild: async (id) => commitOk(manage.deleteChild(dataRef.current, id)),
      saveChore: async (value, id) => commitOk(manage.saveChore(dataRef.current, value, id)),
      deleteChore: async (id) => commitOk(manage.deleteChore(dataRef.current, id)),
      saveReward: async (value, id) => commitOk(manage.saveReward(dataRef.current, value, id)),
      deleteReward: async (id) => commitOk(manage.deleteReward(dataRef.current, id)),
      saveMealWeek: async (childId, monday, rows) => fromResult(saveMealWeek(dataRef.current, childId, monday, rows, now())),
      addFoodOption: async (category, name) => fromResult(addFoodOption(dataRef.current, category, name)),
      removeFoodOption: async (category, id) => fromResult(removeFoodOption(dataRef.current, category, id, now())),
      updateFamilyName: async (name) => commitOk(manage.updateSettings(dataRef.current, { familyName: name })),
      updatePin: async (pin) => {
        const error = validatePin(pin);
        return error ? fail(error) : commitOk(manage.updateSettings(dataRef.current, { parentPin: pin }));
      },
      resetDemoData: async () => commitOk(resetData(storage, now())),
      loadDemoFamily: async () => unsupported('Use “Reset to sample data” in this version.'),
      versionOf: () => 0,
      exportData: async () => ({ ok: true, file: toExportFile(dataRef.current, 'browser') }),
      previewImport: async () => unsupported('Importing needs the shared family server.'),
      applyImport: async () => unsupported('Importing needs the shared family server.'),
      refresh: async () => {},
    };
  }, [commit, storage]);

  return {
    mode: 'local',
    status: 'ready',
    data,
    today,
    error: null,
    connectionLost: false,
    saveFailed,
    loadNotice: LOAD_MESSAGES[boot.status] ?? null,
    actions,
  };
}
