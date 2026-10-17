import { useAccess, type AccessLoad } from '../state/access';
import type { FamilyStore } from '../state/storeTypes';

/** Server builds, before the sign-in state is known. */
export function AccessStatusScreen({ load }: { load: Exclude<AccessLoad, { state: 'ready' }> }) {
  if (load.state === 'loading') {
    return (
      <main className="screen status-screen" aria-busy="true">
        <div className="status-card">
          <p className="status-emoji" aria-hidden="true">
            ⏳
          </p>
          <h1 className="screen-title">Connecting to your family server…</h1>
        </div>
      </main>
    );
  }
  return (
    <main className="screen status-screen">
      <div className="status-card" role="alert">
        <p className="status-emoji" aria-hidden="true">
          📡
        </p>
        <h1 className="screen-title">Can’t reach the family server</h1>
        <p className="status-message">{load.message}</p>
        <button type="button" className="button button-primary" onClick={load.retry}>
          Try again
        </button>
      </div>
    </main>
  );
}

/** Full-page state shown before the first successful load from the server. */
export function ServerStatusScreen({ store }: { store: FamilyStore }) {
  if (store.status === 'loading') {
    return (
      <main className="screen status-screen" aria-busy="true">
        <div className="status-card">
          <p className="status-emoji" aria-hidden="true">
            ⏳
          </p>
          <h1 className="screen-title">Loading your family chart…</h1>
        </div>
      </main>
    );
  }
  const disabled = store.error?.kind === 'disabled';
  return (
    <main className="screen status-screen">
      <div className="status-card" role="alert">
        <p className="status-emoji" aria-hidden="true">
          {disabled ? '🔒' : '📡'}
        </p>
        <h1 className="screen-title">{disabled ? 'Family data is switched off on this server' : 'Can’t reach the family server'}</h1>
        <p className="status-message">{store.error?.message ?? 'Something went wrong.'}</p>
        {disabled ? (
          <p className="muted">Ask whoever runs the family server to check its settings.</p>
        ) : (
          <p className="muted">Your data is safe on the server. Nothing has been changed.</p>
        )}
        <button type="button" className="button button-primary" onClick={() => void store.actions.refresh()}>
          Try again
        </button>
      </div>
    </main>
  );
}

/** Persistent strip in server builds: not released for real families yet. */
export function DevBuildBanner() {
  const access = useAccess();
  if (access?.status.devMode) {
    return (
      <div className="banner banner-dev" role="note">
        🧪 Development mode: shared family server with <strong>no sign-in</strong>. Not for real family data.
      </div>
    );
  }
  return (
    <div className="banner banner-dev" role="note">
      🧪 Pre-release build of the shared family server. Not ready for real family data yet.
    </div>
  );
}

/**
 * A sign-out the server hasn't confirmed. The parent area stays locked on this
 * screen, but the session may still be active on the server, so say so
 * plainly and offer to try again (it is also retried automatically).
 */
export function SignOutProblemBanner() {
  const access = useAccess();
  if (access?.signOutSuperseded) {
    // The session this tab was signing out is gone; a newer sign-in on this
    // browser (e.g. another tab) was left alone. This tab stays locked.
    return (
      <div className="banner banner-info" role="status">
        <span>
          ℹ️ The parent session this screen was signing out has ended. A parent has signed in again on this browser (in
          another tab or window), and that sign-in was left alone. Sign in here to use the parent area on this screen.
        </span>
      </div>
    );
  }
  if (!access?.signOutProblem) return null;
  return (
    <div className="banner banner-warning" role="alert">
      <span>
        ⚠️ {access.signOutProblem} The parent area is locked on this screen, but the parent session may still be active
        on the server until sign-out is confirmed.
      </span>
      <button type="button" className="button button-ghost" disabled={access.signingOut} onClick={() => void access.signOut()}>
        {access.signingOut ? 'Trying…' : 'Try signing out again'}
      </button>
    </div>
  );
}
