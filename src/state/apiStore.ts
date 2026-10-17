import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, createApiClient, toFamilyData, type ApiClient, type ApiErrorKind, type CommandBody, type ServerState } from '../api/client';
import type { FamilyData } from '../types';
import { commands } from './apiCommands';
import type { ActionResult, FamilyActions, FamilyStore } from './storeTypes';
import { useToday } from './time';

// Server-backed data source (shared-backend development build). The server
// holds the single authoritative family dataset; this hook keeps a copy of
// the latest state for display and sends every change as a command. After
// each command it re-reads the state, so what the screen shows is always
// what the server stored. There is no offline queue: if the server cannot
// be reached, changes are refused with a clear message.

const CONFLICT_MESSAGE = 'This was changed on another device, so your change was not saved. The latest version has been loaded.';

export function useApiFamilyStore(client: ApiClient = defaultClient): FamilyStore {
  const localToday = useToday();
  const [server, setServer] = useState<ServerState | null>(null);
  const [status, setStatus] = useState<FamilyStore['status']>('loading');
  const [error, setError] = useState<FamilyStore['error']>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const serverRef = useRef<ServerState | null>(null);

  /** Apply a fetched state unless an even newer one is already shown. */
  const accept = useCallback((next: ServerState) => {
    const current = serverRef.current;
    if (current && next.stateVersion < current.stateVersion) return;
    serverRef.current = next;
    setServer(next);
    setStatus('ready');
    setError(null);
    setConnectionLost(false);
  }, []);

  const load = useCallback(async () => {
    try {
      accept(await client.getState());
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('server', 'Unexpected error.');
      if (serverRef.current) {
        // Keep showing the last good data; flag the connection problem.
        setConnectionLost(err.kind === 'unreachable' || err.kind === 'server');
      } else {
        setStatus('error');
        setError({ kind: err.kind, message: err.message });
      }
    }
  }, [accept, client]);

  // First load, and re-read when the window regains focus or the local date
  // changes (the server decides "today" in the household time zone).
  useEffect(() => {
    void load();
  }, [load, localToday]);
  useEffect(() => {
    const onFocus = () => void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const actions = useMemo<FamilyActions>(() => {
    const versionOf = (key: string) => serverRef.current?.recordVersions[key] ?? 0;

    async function run(command: CommandBody): Promise<ActionResult> {
      try {
        await client.sendCommand(command);
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError('server', 'Unexpected error.');
        if (err.kind === 'unreachable') setConnectionLost(true);
        if (err.kind === 'conflict' || err.kind === 'not_found') {
          await load(); // show the latest data
          return { ok: false, kind: err.kind, error: err.kind === 'conflict' && err.body?.record ? CONFLICT_MESSAGE : err.message };
        }
        return { ok: false, kind: err.kind, error: rejectionMessage(err) };
      }
      await load();
      return { ok: true };
    }

    const unsupported = (error: string): ActionResult => ({ ok: false, error, kind: 'unsupported' });

    return {
      toggleChore: (choreId) => run(commands.toggleChore(choreId)),
      redeemReward: (childId, rewardId) => run(commands.redeemReward(childId, rewardId)),
      dismissMealReminder: () => run(commands.dismissMealReminder()),
      saveChild: (value, id, base) => run(commands.saveChild(value, id, base, versionOf)),
      deleteChild: (id, base) => run(commands.deleteChild(id, base, versionOf)),
      saveChore: (value, id, base) => run(commands.saveChore(value, id, base, versionOf)),
      deleteChore: (id, base) => run(commands.deleteChore(id, base, versionOf)),
      saveReward: (value, id, base) => run(commands.saveReward(value, id, base, versionOf)),
      deleteReward: (id, base) => run(commands.deleteReward(id, base, versionOf)),
      saveMealWeek: (childId, monday, rows, base) => run(commands.saveMealWeek(childId, monday, rows, base, versionOf)),
      addFoodOption: (category, name) => run(commands.addFoodOption(category, name)),
      removeFoodOption: (category, id) => run(commands.removeFoodOption(category, id)),
      updateFamilyName: (name, base) => run(commands.updateFamilyName(name, base, versionOf)),
      updatePin: async () => unsupported('The PIN is not used with the shared family server. Parents sign in with their own accounts instead.'),
      resetDemoData: async () => unsupported('Resetting is not available with the shared family server.'),
      loadDemoFamily: () => run(commands.loadDemoFamily()),
      versionOf,
      exportData: async () => {
        try {
          const { stateVersion: _v, ...file } = await client.exportData();
          return { ok: true, file };
        } catch (e) {
          return { ok: false, error: e instanceof ApiError ? e.message : 'Export failed.' };
        }
      },
      previewImport: async (data) => {
        try {
          return { ok: true, preview: await client.previewImport(data) };
        } catch (e) {
          const err = e instanceof ApiError ? e : new ApiError('server', 'Unexpected error.');
          return { ok: false, kind: err.kind, error: importMessage(err) };
        }
      },
      applyImport: async (data, preview, replace) => {
        try {
          const result = await client.applyImport({ data, checksum: preview.checksum, expectedStateVersion: preview.server.stateVersion, replace });
          await load();
          return { ok: true, backup: result.backup };
        } catch (e) {
          const err = e instanceof ApiError ? e : new ApiError('server', 'Unexpected error.');
          await load();
          return { ok: false, kind: err.kind, error: importMessage(err) };
        }
      },
      refresh: load,
    };
  }, [client, load]);

  const data: FamilyData | null = useMemo(() => (server ? toFamilyData(server.family) : null), [server]);

  return {
    mode: 'api',
    status,
    data,
    today: server?.today ?? localToday,
    error,
    connectionLost,
    saveFailed: false,
    loadNotice: null,
    actions,
  };
}

const defaultClient = createApiClient();

function rejectionMessage(err: ApiError): string {
  // Show the first field error if the server listed any (forms validate
  // first, so this is rare).
  const fields = err.body?.fields;
  if (fields && typeof fields === 'object') {
    const first = Object.values(fields as Record<string, unknown>).find((v) => typeof v === 'string');
    if (typeof first === 'string') return first;
  }
  return err.message;
}

function importMessage(err: ApiError): string {
  if (err.kind === 'rejected' || err.kind === 'conflict') {
    const msg = err.body?.message;
    if (typeof msg === 'string') return msg;
  }
  if (err.kind === 'invalid' && err.status === 413) return 'The file is too large to import (limit 5 MB).';
  return err.message;
}

export type { ApiErrorKind };
