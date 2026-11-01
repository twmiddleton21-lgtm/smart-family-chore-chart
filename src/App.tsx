import { useEffect, useMemo, useRef, useState } from 'react';
import { DATA_SOURCE } from './config';
import { AccessProvider, useAccess, useAccessLoader } from './state/access';
import { localStorageActivity, PARENT_IDLE_MS, watchIdle } from './state/idle';
import { editingInProgress, HOME_CHECK_EVERY_MS, HOME_IDLE_MS, mayReturnHome, trackPending } from './state/homeIdle';
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
import { CalendarScreen } from './screens/CalendarScreen';
import { ParentGate } from './screens/ParentGate';
import { DevParentNotice } from './screens/DevParentNotice';
import { ParentArea, type ParentTab } from './screens/parent/ParentArea';
import { MealReminderDialog } from './components/MealReminderDialog';
import { AccessStatusScreen, DevModeBanner, ServerStatusScreen, SignOutProblemBanner } from './components/ServerStatus';
import { mealReminders, shouldShowMealReminder } from './lib/meals';
import { CONNECT_RESULTS, connectResultFromHash } from './lib/calendar';
import type { BirthdayReward, FamilyData } from './types';
import { THEMES } from './lib/celebrations';
import { celebrationView, type CelebrationPreview } from './state/celebration';
import { useBirthdayFirstTap } from './state/birthdayTap';
import { CelebrationHost, useCelebrationDisplay } from './state/celebrationHost';
import { BirthdayCelebration, PreviewBar, type CelebrationEntry } from './components/celebrations/Banners';

type Screen =
  | { name: 'dashboard' }
  | { name: 'child'; childId: string }
  | { name: 'rewards'; childId: string }
  | { name: 'calendar' }
  | { name: 'parent' };

export function App() {
  return (
    <ToastProvider>
      {/* One seasonal decoration layer for every screen (state/celebrationHost.tsx). */}
      <CelebrationHost publicTheme={DATA_SOURCE === 'api'}>
        <AppShell />
      </CelebrationHost>
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
        <DevModeBanner />
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
          <DevModeBanner />
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
        {store.mode === 'api' && <DevModeBanner />}
        <ServerStatusScreen store={store} />
      </div>
    );
  }
  return <AppContent store={store} data={store.data} />;
}

function AppContent({ store, data }: { store: FamilyStore; data: FamilyData }) {
  const { today } = store;
  // Screens get actions that count their saves still on the way, so the
  // return home after inactivity never interrupts one (state/homeIdle.ts).
  const pendingSaves = useRef(0);
  const actions = useMemo(() => trackPending(store.actions, pendingSaves), [store.actions]);
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
  // A parent's theme or birthday preview: this tab's memory only, never saved.
  const [preview, setPreview] = useState<CelebrationPreview | null>(null);
  // The birthday celebration pop-up (after the first tap, or a preview).
  const [celebrating, setCelebrating] = useState<{ entries: CelebrationEntry[]; preview: BirthdayReward | null } | null>(null);

  const goHome = () => setScreen({ name: 'dashboard' });

  // Back from Google's consent page (/#google-calendar=<result>): say how it
  // went, tidy the address, and return a signed-in parent to Settings. (A
  // kiosk signs parents out on reload, so there only the message shows.)
  useEffect(() => {
    const result = connectResultFromHash(window.location.hash);
    if (!result) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    const shown = CONNECT_RESULTS[result] ?? CONNECT_RESULTS.failed!;
    notify(shown.message, shown.kind);
    if (parentSignedIn || (access?.status.devMode ?? false)) {
      setParentTab('settings');
      setScreen({ name: 'parent' });
    }
    // Only once, on the page load that came back from Google.
  }, []);

  // If the selected child disappears (e.g. removed on another device), fall back home.
  const selectedChild =
    screen.name === 'child' || screen.name === 'rewards' ? data.children.find((c) => c.id === screen.childId) : undefined;
  const effective: Screen = (screen.name === 'child' || screen.name === 'rewards') && !selectedChild ? { name: 'dashboard' } : screen;

  const openParent = () => {
    setGateOpen(false);
    setScreen({ name: 'parent' });
  };

  // Seasonal theme and birthdays on the child-facing screens (home, a
  // child's chart and rewards). The parent area and calendar stay plain.
  // Seasonal theme and birthdays, on every screen. The children's screens
  // carry the full themed sky; the parent area and calendar ("work" screens)
  // get a readable panel over dark skies.
  const childFacing = effective.name === 'dashboard' || effective.name === 'child' || effective.name === 'rewards';
  const view = celebrationView(data, today, store.birthdaysToday, preview);
  useCelebrationDisplay({ view, surface: childFacing ? 'child' : 'work' });

  const startPreview = (next: CelebrationPreview, reward?: BirthdayReward) => {
    setPreview(next);
    setGateOpen(false);
    setScreen({ name: 'dashboard' });
    if (next.kind === 'birthday') {
      const child = data.children.find((c) => c.id === next.childId);
      if (child) setCelebrating({ entries: [{ child, award: null, problem: null }], preview: reward ?? { enabled: false, points: 0, gift: '' } });
    }
  };
  /**
   * End a preview. From a child-facing screen, go back to Themes &
   * Celebrations (if the parent is still signed in); inside the parent area,
   * stay on the current tab.
   */
  const endPreview = () => {
    setPreview(null);
    setCelebrating(null);
    if (screen.name !== 'parent' && (!signIn || parentSignedIn)) {
      setParentTab('celebrations');
      setScreen({ name: 'parent' });
    }
  };
  const previewLabel =
    preview?.kind === 'theme'
      ? `the ${THEMES[preview.themeId].name} theme`
      : preview?.kind === 'birthday'
        ? `${data.children.find((c) => c.id === preview.childId)?.name ?? 'a child'}’s birthday`
        : '';

  /**
   * End the parent session: lock this screen at once, then ask the server to
   * end the session. Only a confirmed sign-out is reported as one; otherwise
   * the screen stays locked and a warning (with retry) is shown.
   */
  const endParentSession = async (confirmedMessage: string) => {
    if (!signIn) return;
    const result = await access.signOut();
    if (result === 'confirmed') notify(confirmedMessage);
    else if (result === 'superseded') notify('That parent session has ended. A newer sign-in on this browser (another tab or window) was left signed in.', 'info');
    else notify('Couldn’t confirm sign-out with the family server. The parent area is locked on this screen.', 'error');
  };
  /** Leave the parent area. On a shared family device this also signs the parent out. */
  const exitParent = async (message = 'Parent area locked and signed out.') => {
    goHome();
    if (signIn && access.status.device && access.status.parent) await endParentSession(message);
  };
  const signOut = async () => {
    goHome();
    await endParentSession('Signed out.');
  };

  // If the parent session ends (expired, signed out elsewhere, removed, or a
  // sign-out locked this screen), leave the parent area.
  const inParentArea = screen.name === 'parent';
  const signOutUnderway = signIn && (access.signingOut || access.signOutProblem !== null || access.signOutSuperseded);
  useEffect(() => {
    if (inParentArea && signIn && !parentSignedIn) {
      setScreen({ name: 'dashboard' });
      if (!signOutUnderway) notify('The parent session ended. Please sign in again.', 'info');
    }
  }, [inParentArea, signIn, parentSignedIn, signOutUnderway, notify]);

  // After 30 minutes without input in the parent area, lock it and end the
  // parent session, exactly like "Sign out" (see state/idle.ts). The idle
  // check itself never contacts the server, because authenticated requests
  // extend the server's idle timeout. The existing focus and data refreshes
  // still happen as before, but don't count as user activity.
  const lockAfterIdle = useRef<() => void>(() => undefined);
  lockAfterIdle.current = () => {
    goHome();
    void endParentSession('Parent area locked and signed out after 30 minutes without activity.');
  };
  useEffect(() => {
    if (!inParentArea || !parentSignedIn) return;
    return watchIdle({
      idleMs: PARENT_IDLE_MS,
      onIdle: () => lockAfterIdle.current(),
      target: window,
      visibility: document,
      shared: localStorageActivity,
    });
  }, [inParentArea, parentSignedIn]);

  // Shared family screens (a paired kiosk, or the browser-only build) return
  // to the home screen after 2 minutes without input, when the kiosk dims its
  // display. Leaving the parent area this way is the same as "Done – lock &
  // exit", so a kiosk also signs the parent out. A parent's own signed-in
  // device keeps the 30-minute parent idle lock above instead.
  const homeAfterIdle = !(signIn && access.status.device === null);
  const awayFromHome = effective.name !== 'dashboard' || gateOpen || preview !== null;
  const returnHomeAfterIdle = useRef<() => void>(() => undefined);
  returnHomeAfterIdle.current = () => {
    setGateOpen(false);
    setParentTab('chores');
    // A preview left running ends too; on a kiosk the parent who started it is signed out.
    const previewing = preview !== null;
    setPreview(null);
    if (previewing) setCelebrating(null);
    if (screen.name === 'parent' || previewing) void exitParent('Parent area locked and signed out after 2 minutes without activity.');
    else goHome();
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    if (!homeAfterIdle || !awayFromHome) return;
    return watchIdle({
      idleMs: HOME_IDLE_MS,
      onIdle: () => returnHomeAfterIdle.current(),
      target: window,
      visibility: document,
      checkEveryMs: HOME_CHECK_EVERY_MS,
      canFire: (idleFor) => mayReturnHome(idleFor, pendingSaves.current > 0 || editingInProgress(document)),
    });
  }, [homeAfterIdle, awayFromHome]);

  // A parent's birthdays and reward settings are only sent to signed-in
  // parents, so read the family data again when a parent signs in or out.
  const firstSignInState = useRef(true);
  useEffect(() => {
    if (firstSignInState.current) {
      firstSignInState.current = false;
      return;
    }
    if (signIn) void actions.refresh();
  }, [signIn, parentSignedIn, actions]);

  // The birthday moment: the first tap on a shared screen on a child's birthday.
  useBirthdayFirstTap({
    active: homeAfterIdle && childFacing && preview === null && !gateOpen && celebrating === null,
    today,
    birthdays: store.birthdaysToday,
    visual: data.celebrations.birthdaysEnabled,
    data,
    claim: actions.claimBirthdayReward,
    onCelebrate: (entries) => setCelebrating({ entries, preview: null }),
  });

  return (
    <div className="app">
      {store.mode === 'api' && <DevModeBanner />}
      <SignOutProblemBanner />
      {preview && <PreviewBar label={previewLabel} onEnd={endPreview} />}
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
          // The calendar is fetched by the family server, so only server builds have it.
          onOpenCalendar={store.mode === 'api' ? () => setScreen({ name: 'calendar' }) : undefined}
          onOpenParent={() => {
            setParentTab('chores');
            setGateOpen(true);
          }}
          celebration={view}
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
          birthday={view.birthdayChildren.some((c) => c.id === selectedChild.id)}
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
      {effective.name === 'calendar' && <CalendarScreen today={today} onBack={goHome} />}
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
          onPreview={startPreview}
        />
      )}

      {celebrating && (
        <BirthdayCelebration
          entries={celebrating.entries}
          preview={celebrating.preview}
          onClose={() => setCelebrating(null)}
        />
      )}

      {effective.name === 'dashboard' && !gateOpen && !reminderHidden && !preview && !celebrating && shouldShowMealReminder(data, today) && (
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
