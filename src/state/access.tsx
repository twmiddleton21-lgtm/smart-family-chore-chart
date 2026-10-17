import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, AUTH_CHANGED_EVENT } from '../api/client';
import { authClient, type AuthClient, type AuthStatus } from '../api/auth';
import { confirmSignOut } from './signOut';

// Who is using this browser (server builds only): a signed-in parent, a
// paired device, both, or neither. The server decides; this only mirrors
// /api/auth/status so the screens can show the right thing. It is re-checked
// on start, when the window regains focus, and whenever any request reports
// that the session ended or a parent is needed.
//
// Signing out: the screen is locked at once (the parent is treated as signed
// out here), then the server is asked to end the session. If the server
// can't confirm it, the screen STAYS locked: `signOutProblem` explains that
// the session may still be active on the server, and the sign-out is retried
// in the background, on focus and from the "Try again" button, until the
// server confirms it or the parent signs in again. The lock is kept for this
// tab across page reloads. Locking the screen is not access control; only
// the server ending the session removes the parent's rights.

export interface Access {
  /** As shown to the app: `parent` is null while a sign-out is locked or unconfirmed. */
  status: AuthStatus;
  client: AuthClient;
  /** Re-read the sign-in state from the server. */
  refresh(): Promise<void>;
  /** Parent sign-in; also clears any unconfirmed sign-out on this browser. */
  login(username: string, password: string, remember: boolean): Promise<void>;
  /** Lock now and end the parent session on the server. True only if the server confirmed it. */
  signOut(): Promise<boolean>;
  /** A sign-out request is in progress. */
  signingOut: boolean;
  /** Set while the server hasn't confirmed a sign-out (the screen stays locked). */
  signOutProblem: string | null;
}

export type AccessLoad =
  | { state: 'loading' }
  | { state: 'error'; message: string; retry: () => void }
  | { state: 'ready'; access: Access };

const AccessContext = createContext<Access | null>(null);

/** Sign-in state for server builds; null in the browser-local build. */
export function useAccess(): Access | null {
  return useContext(AccessContext);
}

export function AccessProvider({ access, children }: { access: Access; children: ReactNode }) {
  return <AccessContext.Provider value={access}>{children}</AccessContext.Provider>;
}

type Lock = 'none' | 'signing-out' | 'unconfirmed';

/** Per-tab memory of an unconfirmed sign-out, so a reload doesn't unlock the screen. */
const LOCK_KEY = 'sfcc:sign-out-unconfirmed';
const RELOADED_MESSAGE = 'Couldn’t confirm sign-out with the family server before this page was reloaded.';
const RETRY_MS = 30_000;

function readStoredLock(): boolean {
  try {
    return window.sessionStorage.getItem(LOCK_KEY) === '1';
  } catch {
    return false;
  }
}
function storeLock(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(LOCK_KEY, '1');
    else window.sessionStorage.removeItem(LOCK_KEY);
  } catch {
    // Storage unavailable: the lock still holds until the page is reloaded.
  }
}

export function useAccessLoader(client: AuthClient = authClient): AccessLoad {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lock, setLockState] = useState<Lock>(() => (readStoredLock() ? 'unconfirmed' : 'none'));
  const [problem, setProblem] = useState<string | null>(() => (readStoredLock() ? RELOADED_MESSAGE : null));
  const seq = useRef(0);
  const lockRef = useRef(lock);
  const statusRef = useRef(status);
  const inFlight = useRef<Promise<boolean> | null>(null);
  /** Retry straight away once if the page was reloaded during an unconfirmed sign-out. */
  const retryOnLoad = useRef(lock === 'unconfirmed');

  const setLock = useCallback((next: Lock, message: string | null = null) => {
    lockRef.current = next;
    setLockState(next);
    // Keep showing the last problem while a retry is in progress.
    if (next === 'unconfirmed') setProblem(message);
    if (next === 'none') setProblem(null);
    storeLock(next !== 'none');
  }, []);

  const accept = useCallback(
    (next: AuthStatus) => {
      statusRef.current = next;
      setStatus(next);
      setError(null);
      // The server says no parent session exists for this browser: an
      // unconfirmed sign-out is now confirmed (e.g. it expired meanwhile).
      if (lockRef.current === 'unconfirmed' && next.parent === null) setLock('none');
    },
    [setLock],
  );

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await client.status();
      if (mine !== seq.current) return; // a newer check is in flight
      accept(next);
    } catch (e) {
      if (mine !== seq.current) return;
      // Keep the last known state if we had one; otherwise show the error.
      setError(e instanceof ApiError ? e.message : 'Can’t reach the family server.');
    }
  }, [accept, client]);

  const signOut = useCallback((): Promise<boolean> => {
    // One request at a time (the button, focus and the retry timer may overlap).
    if (inFlight.current) return inFlight.current;
    setLock('signing-out'); // lock this screen first, whatever happens next
    const run = (async () => {
      const previous = statusRef.current ?? { devMode: false, setupRequired: false, parent: null, device: null };
      const outcome = await confirmSignOut(client, previous);
      if (outcome.confirmed) {
        seq.current++; // ignore any older status read still in flight
        accept(outcome.status);
        setLock('none');
        return true;
      }
      setLock('unconfirmed', outcome.message);
      return false;
    })();
    inFlight.current = run;
    void run.finally(() => {
      inFlight.current = null;
    });
    return run;
  }, [accept, client, setLock]);

  const login = useCallback(
    async (username: string, password: string, remember: boolean) => {
      await client.login(username, password, remember);
      // The server replaced this browser's previous parent session (including
      // an unconfirmed one) with the new one.
      setLock('none');
      await refresh();
    },
    [client, refresh, setLock],
  );

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    window.addEventListener(AUTH_CHANGED_EVENT, onChange);
    window.addEventListener('focus', onChange);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, onChange);
      window.removeEventListener('focus', onChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // While a sign-out is unconfirmed, keep trying to end the session on the server.
  useEffect(() => {
    if (lock !== 'unconfirmed') return;
    const retry = () => void signOut();
    if (retryOnLoad.current) {
      retryOnLoad.current = false;
      retry();
    }
    const timer = window.setInterval(retry, RETRY_MS);
    window.addEventListener('focus', retry);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', retry);
    };
  }, [lock, signOut]);

  if (status) {
    const shown = lock === 'none' ? status : { ...status, parent: null };
    return {
      state: 'ready',
      access: { status: shown, client, refresh, login, signOut, signingOut: lock === 'signing-out', signOutProblem: lock === 'none' ? null : problem },
    };
  }
  if (error) return { state: 'error', message: error, retry: () => void refresh() };
  return { state: 'loading' };
}
