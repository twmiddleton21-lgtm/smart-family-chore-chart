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
//
// Every sign-out names the session it was started for, and its retries
// (also after a reload) keep naming that one; the server ends only that
// session. If the parent has since signed in again in another tab (same
// browser cookie), the retry stops without touching the newer session and
// this tab stays locked (`signOutSuperseded`) until someone signs in here.
// Signing in on this tab waits for a sign-out still in progress, pauses the
// retries, and ignores any sign-out result from before it.

/** How a sign-out ended (see Access.signOut). */
export type SignOutResult = 'confirmed' | 'unconfirmed' | 'superseded';

export interface Access {
  /** As shown to the app: `parent` is null while a sign-out is locked, unconfirmed or superseded. */
  status: AuthStatus;
  client: AuthClient;
  /** Re-read the sign-in state from the server. */
  refresh(): Promise<void>;
  /** Parent sign-in; also clears any unconfirmed or superseded sign-out on this tab. */
  login(username: string, password: string, remember: boolean): Promise<void>;
  /**
   * Lock now and end the parent session on the server. `confirmed` only if the
   * server confirmed it; `superseded` if that session was already replaced by
   * a newer sign-in on this browser (left alone).
   */
  signOut(): Promise<SignOutResult>;
  /** A sign-out request is in progress. */
  signingOut: boolean;
  /** Set while the server hasn't confirmed a sign-out (the screen stays locked). */
  signOutProblem: string | null;
  /** The session being signed out was replaced by a newer sign-in on this browser; this tab stays locked. */
  signOutSuperseded: boolean;
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

type Lock = 'none' | 'signing-out' | 'unconfirmed' | 'superseded';

/** Per-tab memory of a sign-out that isn't settled, so a reload doesn't unlock the screen. */
const LOCK_KEY = 'sfcc:sign-out-unconfirmed';
const RELOADED_MESSAGE = 'Couldn’t confirm sign-out with the family server before this page was reloaded.';
const RETRY_MS = 30_000;

interface StoredLock {
  lock: 'unconfirmed' | 'superseded';
  /** Public id of the session being signed out (null if unknown). */
  target: string | null;
}

function readStoredLock(): StoredLock | null {
  try {
    const raw = window.sessionStorage.getItem(LOCK_KEY);
    if (raw === null) return null;
    try {
      const v = JSON.parse(raw) as Partial<StoredLock>;
      const target = typeof v.target === 'string' ? v.target : null;
      return { lock: v.lock === 'superseded' ? 'superseded' : 'unconfirmed', target };
    } catch {
      // Unreadable (e.g. written by an older build): stay locked; the target is unknown.
      return { lock: 'unconfirmed', target: null };
    }
  } catch {
    return null;
  }
}
function storeLock(lock: Lock, target: string | null): void {
  try {
    if (lock === 'none') window.sessionStorage.removeItem(LOCK_KEY);
    else window.sessionStorage.setItem(LOCK_KEY, JSON.stringify({ lock: lock === 'superseded' ? 'superseded' : 'unconfirmed', target }));
  } catch {
    // Storage unavailable: the lock still holds until the page is reloaded.
  }
}

export function useAccessLoader(client: AuthClient = authClient): AccessLoad {
  const [stored] = useState(readStoredLock);
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lock, setLockState] = useState<Lock>(() => stored?.lock ?? 'none');
  const [problem, setProblem] = useState<string | null>(() => (stored?.lock === 'unconfirmed' ? RELOADED_MESSAGE : null));
  const seq = useRef(0);
  const lockRef = useRef(lock);
  /** The session the current sign-out is for. */
  const targetRef = useRef<string | null>(stored?.target ?? null);
  const statusRef = useRef(status);
  const inFlight = useRef<Promise<SignOutResult> | null>(null);
  /** Bumped by every sign-in: sign-out results from before it are ignored. */
  const generation = useRef(0);
  /** A sign-in is in progress on this tab: don't start sign-out retries meanwhile. */
  const signingIn = useRef(false);
  /** Retry straight away once if the page was reloaded during an unconfirmed sign-out. */
  const retryOnLoad = useRef(lock === 'unconfirmed');

  const setLock = useCallback((next: Lock, message: string | null = null) => {
    lockRef.current = next;
    setLockState(next);
    // Keep showing the last problem while a retry is in progress.
    if (next === 'unconfirmed') setProblem(message);
    if (next === 'none' || next === 'superseded') setProblem(null);
    if (next === 'none') targetRef.current = null;
    storeLock(next, targetRef.current);
  }, []);

  const accept = useCallback(
    (next: AuthStatus) => {
      statusRef.current = next;
      setStatus(next);
      setError(null);
      const current = lockRef.current;
      if (current !== 'unconfirmed' && current !== 'superseded') return;
      // The server says no parent session exists for this browser: the
      // sign-out is settled (e.g. it expired meanwhile).
      if (next.parent === null) setLock('none');
      // This browser now holds a different session than the one being signed
      // out: that one is gone, and the newer one must be left alone.
      else if (current === 'unconfirmed' && targetRef.current && next.sessionId !== targetRef.current) setLock('superseded');
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

  const signOut = useCallback((): Promise<SignOutResult> => {
    // One request at a time (the button, focus and the retry timer may overlap).
    if (inFlight.current) return inFlight.current;
    // Never while this tab is signing in: that will replace the session anyway.
    if (signingIn.current) return Promise.resolve('unconfirmed');
    // A new sign-out is for the session shown now; a retry keeps its original target.
    if (lockRef.current === 'none') targetRef.current = statusRef.current?.sessionId ?? null;
    else if (lockRef.current === 'superseded') return Promise.resolve('superseded');
    setLock('signing-out'); // lock this screen first, whatever happens next
    const mine = generation.current;
    const run = (async (): Promise<SignOutResult> => {
      const previous = { ...(statusRef.current ?? { devMode: false, setupRequired: false, parent: null, device: null, sessionId: null }), sessionId: targetRef.current };
      const outcome = await confirmSignOut(client, previous);
      if (mine !== generation.current) return 'superseded'; // signed in again meanwhile: stale
      if (outcome.confirmed) {
        seq.current++; // ignore any older status read still in flight
        statusRef.current = outcome.status;
        setStatus(outcome.status);
        setError(null);
        if (outcome.superseded) {
          setLock('superseded');
          return 'superseded';
        }
        setLock('none');
        return 'confirmed';
      }
      setLock('unconfirmed', outcome.message);
      return 'unconfirmed';
    })();
    inFlight.current = run;
    void run.finally(() => {
      inFlight.current = null;
    });
    return run;
  }, [client, setLock]);

  const login = useCallback(
    async (username: string, password: string, remember: boolean) => {
      signingIn.current = true;
      try {
        // Let a sign-out already on its way finish first (it is bounded by a
        // timeout and never throws), so its answer can't arrive after ours.
        await inFlight.current;
        await client.login(username, password, remember);
        generation.current++;
        // The server replaced this browser's previous parent session (including
        // an unconfirmed one) with the new one.
        setLock('none');
      } finally {
        signingIn.current = false;
      }
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
    const shown = lock === 'none' ? status : { ...status, parent: null, sessionId: null };
    return {
      state: 'ready',
      access: {
        status: shown,
        client,
        refresh,
        login,
        signOut,
        signingOut: lock === 'signing-out',
        signOutProblem: lock === 'unconfirmed' || lock === 'signing-out' ? problem : null,
        signOutSuperseded: lock === 'superseded',
      },
    };
  }
  if (error) return { state: 'error', message: error, retry: () => void refresh() };
  return { state: 'loading' };
}
