import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DateKey } from '../types';
import { seasonGreeting, type Occurrence } from '../lib/celebrations';
import { CelebrationLayers } from '../components/celebrations/CelebrationLayers';
import { isDarkTheme, NO_CELEBRATION, type CelebrationView } from './celebration';
import { useAnimationPause } from './animationPause';

// ONE decoration layer for the whole app, mounted once at the root (App), so
// every screen is seasonal without any screen having to include it: sign-in,
// pairing, loading and error screens, the children's screens, the parent
// area, the Family Calendar and anything shown over them. Navigating,
// signing in or out and opening dialogs never mounts a second layer.
//
// What to show comes from the app (the scheduled theme, today's birthdays or
// a parent's preview) once family data is loaded. Before that (not signed in
// or paired yet, or still connecting), server builds ask the server's public
// GET /api/celebrations/theme, which only says which theme shows today.
//
// The theme is published on <html> for CSS:
//   data-celebration="halloween|christmas|…|birthday"   (absent: nothing to show)
//   data-celebration-tone="dark|light"
//   data-celebration-surface="child|work"   work = parent area, calendar: text
//                                            there gets a readable panel on dark skies

export type CelebrationSurface = 'child' | 'work';

export interface CelebrationDisplay {
  view: CelebrationView;
  surface: CelebrationSurface;
}

type Register = (display: CelebrationDisplay | null) => void;
const RegisterContext = createContext<Register>(() => undefined);

/** Called by the screen tree that knows the family data; the latest call wins. */
export function useCelebrationDisplay(display: CelebrationDisplay): void {
  const register = useContext(RegisterContext);
  const latest = useRef(display);
  latest.current = display;
  const v = display.view;
  const key = JSON.stringify([
    v.occurrence,
    v.greeting,
    v.birthdayChildren.map((c) => c.id),
    v.preview,
    display.surface,
  ]);
  useEffect(() => register(latest.current), [key, register]);
  useEffect(() => () => register(null), [register]);
}

export function displayAttributes(display: CelebrationDisplay | null): Record<string, string> {
  const id = display?.view.occurrence?.themeId;
  const birthday = (display?.view.birthdayChildren.length ?? 0) > 0;
  if (!display || (!id && !birthday)) return {};
  return {
    'data-celebration': id ?? 'birthday',
    'data-celebration-tone': isDarkTheme(id) ? 'dark' : 'light',
    'data-celebration-surface': display.surface,
    ...(birthday ? { 'data-celebration-birthday': 'true' } : {}),
    ...(display.view.preview ? { 'data-celebration-preview': 'true' } : {}),
  };
}

const ATTRS = ['data-celebration', 'data-celebration-tone', 'data-celebration-surface', 'data-celebration-birthday', 'data-celebration-preview'];

export interface PublicTheme {
  today: DateKey;
  occurrence: Pick<Occurrence, 'themeId' | 'holiday' | 'start' | 'end' | 'custom'> | null;
}

export function viewFromPublicTheme(theme: PublicTheme | null): CelebrationView {
  if (!theme?.occurrence) return NO_CELEBRATION;
  const occurrence: Occurrence = { ...theme.occurrence };
  return { occurrence, greeting: seasonGreeting(occurrence, theme.today), birthdayChildren: [], preview: null };
}

const REFRESH_MS = 30 * 60 * 1000;

/** Today's theme from the server's public endpoint, while nothing better is registered. */
function usePublicTheme(enabled: boolean): CelebrationDisplay | null {
  const [theme, setTheme] = useState<PublicTheme | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/celebrations/theme', { credentials: 'same-origin', headers: { accept: 'application/json' } });
        if (r.ok && alive) setTheme((await r.json()) as PublicTheme);
      } catch {
        // No theme is fine; the screens work without one.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled]);
  return enabled && theme ? { view: viewFromPublicTheme(theme), surface: 'child' } : null;
}

export function CelebrationHost({ children, publicTheme }: { children: ReactNode; publicTheme: boolean }) {
  const [registered, setRegistered] = useState<CelebrationDisplay | null>(null);
  const fallback = usePublicTheme(publicTheme && registered === null);
  const display = registered ?? fallback;
  const paused = useAnimationPause();
  const attrs = displayAttributes(display);
  const attrKey = JSON.stringify(attrs);

  useEffect(() => {
    const root = document.documentElement;
    for (const a of ATTRS) root.removeAttribute(a);
    for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
    return () => {
      for (const a of ATTRS) root.removeAttribute(a);
    };
    // attrKey stands for attrs.
  }, [attrKey]);

  return (
    <RegisterContext.Provider value={setRegistered}>
      {display && <CelebrationLayers view={display.view} paused={paused} />}
      {children}
    </RegisterContext.Provider>
  );
}
