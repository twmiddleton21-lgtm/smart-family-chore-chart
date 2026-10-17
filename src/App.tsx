import { useEffect, useState } from 'react';
import { DATA_SOURCE } from './config';
import { AccessProvider, useAccess, useAccessLoader } from './state/access';
import { useToast } from './state/toast';
import { SetupScreen } from './screens/auth/SetupScreen';
import { LockedScreen } from './screens/auth/LockedScreen';
import { ParentSignInDialog } from './screens/auth/ParentSignInDialog';
import { useFamilyStore } from './state/useFamilyStore';
import type { FamilyStore } from './state/storeTypes';
import { ToastProvider } from './state/toast';
import { Dashboard } from './screens/Dashboard';
import { ChildChart } from './screens/ChildChart';
import { RewardsScreen } from './screens/RewardsScreen';
import { ParentGate } from './screens/ParentGate';
import { DevParentNotice } from './screens/DevParentNotice';
import { ParentArea, type ParentTab } from './screens/parent/ParentArea';
import { MealReminderDialog } from './components/MealReminderDialog';
import { AccessStatusScreen, DevBuildBanner, ServerStatusScreen, SignOutProblemBanner } from './components/ServerStatus';
import { mealReminders, shouldShowMealReminder } from './lib/meals';
import type { FamilyData } from './types';

type Screen =
  | { name: 'dashboard' }
  | { name: 'child'; childId: string }
  | { name: 'rewards'; childId: string }
  | { name: 'parent' };

export function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}

function AppShell() {
  return DATA_SOURCE === 'api' ? <AccessGate /> : <StoreShell />;
}

/**
 * Server builds: nothing of the family is loaded until the server says this
 * browser may see it (a signed-in parent or a paired device). The server
 * enforces this on every request; the gate only decides what to show.
 */
function AccessGate() {
  const load = useAccessLoader();
  if (load.state !== 'ready') {
    return (
      <div className="app">
        <DevBuildBanner />
        <AccessStatusScreen load={load} />
      </div>
    );
  }
  const { status } = load.access;
  const locked = status.setupRequired || (!status.parent && !status.device);
  return (
    <AccessProvider access={load.access}>
      {status.devMode || !locked ? (
        <StoreShell />
      ) : (
        <div className="app">
          <DevBuildBanner />
          <SignOutProblemBanner />
          {status.setupRequired ? <SetupScreen access={load.access} /> : <LockedScreen access={load.access} />}
        </div>
      )}
    </AccessProvider>
  );
}

function StoreShell() {
  const store = useFamilyStore();
  if (!store.data) {
    return (
      <div className="app">
        {store.mode === 'api' && <DevBuildBanner />}
        <ServerStatusScreen store={store} />
      </div>
    );
  }
  return <AppContent store={store} data={store.data} />;
}

function AppContent({ store, data }: { store: FamilyStore; data: FamilyData }) {
  const { actions, today } = store;
  const access = useAccess();
  const notify = useToast();
  // Server build with real sign-in (not development mode).
  const signIn = access !== null && !access.status.devMode;
  const parentSignedIn = signIn && access.status.parent !== null;
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' });
  const [gateOpen, setGateOpen] = useState(false);
  const [loadNotice, setLoadNotice] = useState(store.loadNotice);
  const [parentTab, setParentTab] = useState<ParentTab>('chores');
  // "Plan meals now" hides the reminder for this visit; "Remind me tomorrow" persists.
  const [reminderHidden, setReminderHidden] = useState(false);

  const goHome = () => setScreen({ name: 'dashboard' });

  // If the selected child disappears (e.g. removed on another device), fall back home.
  const selectedChild =
    screen.name === 'child' || screen.name === 'rewards' ? data.children.find((c) => c.id === screen.childId) : undefined;
  const effective: Screen = (screen.name === 'child' || screen.name === 'rewards') && !selectedChild ? { name: 'dashboard' } : screen;

  const openParent = () => {
    setGateOpen(false);
    setScreen({ name: 'parent' });
  };

  /**
   * End the parent session: lock this screen at once, then ask the server to
   * end the session. Only a confirmed sign-out is reported as one; otherwise
   * the screen stays locked and a warning (with retry) is shown.
   */
  const endParentSession = async (confirmedMessage: string) => {
    if (!signIn) return;
    const confirmed = await access.signOut();
    if (confirmed) notify(confirmedMessage);
    else notify('Couldn’t confirm sign-out with the family server. The parent area is locked on this screen.', 'error');
  };
  /** Leave the parent area. On a shared family device this also signs the parent out. */
  const exitParent = async () => {
    goHome();
    if (signIn && access.status.device && access.status.parent) await endParentSession('Parent area locked and signed out.');
  };
  const signOut = async () => {
    goHome();
    await endParentSession('Signed out.');
  };

  // If the parent session ends (expired, signed out elsewhere, removed, or a
  // sign-out locked this screen), leave the parent area.
  const inParentArea = screen.name === 'parent';
  const signOutUnderway = signIn && (access.signingOut || access.signOutProblem !== null);
  useEffect(() => {
    if (inParentArea && signIn && !parentSignedIn) {
      setScreen({ name: 'dashboard' });
      if (!signOutUnderway) notify('The parent session ended. Please sign in again.', 'info');
    }
  }, [inParentArea, signIn, parentSignedIn, signOutUnderway, notify]);

  // After 30 minutes without any input in the parent area, ask the server
  // again: if the session has expired there, the effect above locks the area.
  useEffect(() => {
    if (!inParentArea || !signIn) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - last > 30 * 60 * 1000) void access.refresh();
    }, 60 * 1000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      window.clearInterval(timer);
    };
  }, [inParentArea, signIn, access]);

  return (
    <div className="app">
      {store.mode === 'api' && <DevBuildBanner />}
      <SignOutProblemBanner />
      {store.saveFailed && (
        <div className="banner banner-warning" role="alert">
          ⚠️ This browser is not letting the app save. Changes will be lost when the page is closed. Check that site
          storage is allowed and the browser is not in private mode.
        </div>
      )}
      {store.connectionLost && (
        <div className="banner banner-warning" role="alert">
          <span>📡 Can’t reach the family server. You’re seeing the last loaded data; changes can’t be saved right now.</span>
          <button type="button" className="button button-ghost" onClick={() => void actions.refresh()}>
            Try again
          </button>
        </div>
      )}
      {loadNotice && (
        <div className="banner banner-info" role="status">
          <span>ℹ️ {loadNotice}</span>
          <button type="button" className="button button-ghost" onClick={() => setLoadNotice(null)}>
            OK
          </button>
        </div>
      )}

      {effective.name === 'dashboard' && (
        <Dashboard
          data={data}
          today={today}
          onSelectChild={(child) => setScreen({ name: 'child', childId: child.id })}
          onOpenParent={() => {
            setParentTab('chores');
            setGateOpen(true);
          }}
        />
      )}
      {effective.name === 'child' && selectedChild && (
        <ChildChart
          key={selectedChild.id}
          data={data}
          child={selectedChild}
          today={today}
          actions={actions}
          onBack={goHome}
          onOpenRewards={() => setScreen({ name: 'rewards', childId: selectedChild.id })}
        />
      )}
      {effective.name === 'rewards' && selectedChild && (
        <RewardsScreen
          key={selectedChild.id}
          data={data}
          child={selectedChild}
          actions={actions}
          onBack={() => setScreen({ name: 'child', childId: selectedChild.id })}
        />
      )}
      {effective.name === 'parent' && (
        <ParentArea
          data={data}
          actions={actions}
          mode={store.mode}
          today={today}
          initialTab={parentTab}
          access={signIn ? access : null}
          onExit={() => void exitParent()}
          onSignOut={() => void signOut()}
        />
      )}

      {effective.name === 'dashboard' && !gateOpen && !reminderHidden && shouldShowMealReminder(data, today) && (
        <MealReminderDialog
          reminders={mealReminders(data, today)}
          today={today}
          onLater={() => void actions.dismissMealReminder()}
          onPlanNow={() => {
            setReminderHidden(true);
            setParentTab('meals');
            setGateOpen(true);
          }}
        />
      )}

      {gateOpen &&
        (signIn ? (
          parentSignedIn ? (
            <AutoOpen onOpen={openParent} />
          ) : (
            <ParentSignInDialog access={access} onCancel={() => setGateOpen(false)} onSignedIn={openParent} />
          )
        ) : store.mode === 'api' ? (
          <DevParentNotice onCancel={() => setGateOpen(false)} onContinue={openParent} />
        ) : (
          <ParentGate pin={data.settings.parentPin} onCancel={() => setGateOpen(false)} onUnlock={openParent} />
        ))}
    </div>
  );
}

/** A parent is already signed in: go straight to the parent area. */
function AutoOpen({ onOpen }: { onOpen: () => void }) {
  useEffect(() => onOpen(), [onOpen]);
  return null;
}
