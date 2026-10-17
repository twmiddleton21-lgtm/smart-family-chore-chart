import type { FamilyStore } from '../state/storeTypes';

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
          <p className="muted">
            This development build needs the server started in its local development mode. Parent sign-in, which will allow
            normal use, comes in a later version.
          </p>
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

/** Persistent strip in the server development build: not for real families yet. */
export function DevBuildBanner() {
  return (
    <div className="banner banner-dev" role="note">
      🧪 Development build: shared family server with <strong>no sign-in yet</strong>. Not for real family data.
    </div>
  );
}
