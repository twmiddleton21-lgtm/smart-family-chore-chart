import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, AUTH_CHANGED_EVENT } from '../api/client';
import { authClient, type AuthClient, type AuthStatus } from '../api/auth';

// Who is using this browser (server builds only): a signed-in parent, a
// paired device, both, or neither. The server decides; this only mirrors
// /api/auth/status so the screens can show the right thing. It is re-checked
// on start, when the window regains focus, and whenever any request reports
// that the session ended or a parent is needed.

export interface Access {
  status: AuthStatus;
  client: AuthClient;
  /** Re-read the sign-in state from the server. */
  refresh(): Promise<void>;
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

export function useAccessLoader(client: AuthClient = authClient): AccessLoad {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await client.status();
      if (mine !== seq.current) return; // a newer check is in flight
      setStatus(next);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      // Keep the last known state if we had one; otherwise show the error.
      setError(e instanceof ApiError ? e.message : 'Can’t reach the family server.');
    }
  }, [client]);

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

  if (status) return { state: 'ready', access: { status, client, refresh } };
  if (error) return { state: 'error', message: error, retry: () => void refresh() };
  return { state: 'loading' };
}
