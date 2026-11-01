import type { Child, DateKey, FamilyData, ThemeId } from '../types';
import { activeTheme, seasonGreeting, themeStatus, type BirthdayToday, type Occurrence, type SeasonGreeting } from '../lib/celebrations';

// What the child-facing screens should celebrate right now: the scheduled
// seasonal theme and today's birthdays, or a parent's preview.
//
// A preview lives only in this browser tab's memory (App state). It never
// changes the saved schedule, is never sent to the server, and ends on
// "Back to scheduled theme", a reload, or the return home after inactivity.
// Previewing a birthday never gives the reward.

export type CelebrationPreview = { kind: 'theme'; themeId: ThemeId } | { kind: 'birthday'; childId: string };

export interface CelebrationView {
  /** The seasonal theme showing, or null. */
  occurrence: Occurrence | null;
  greeting: SeasonGreeting | null;
  /** Children whose birthday is celebrated (empty when the birthday theme is off). */
  birthdayChildren: Child[];
  preview: CelebrationPreview | null;
}

export const NO_CELEBRATION: CelebrationView = { occurrence: null, greeting: null, birthdayChildren: [], preview: null };

export function celebrationView(
  data: Pick<FamilyData, 'celebrations' | 'children'>,
  today: DateKey,
  birthdays: BirthdayToday[],
  preview: CelebrationPreview | null,
): CelebrationView {
  const settings = data.celebrations;
  let occurrence: Occurrence | null;
  let birthdayChildren: Child[];
  if (preview?.kind === 'theme') {
    // The showing that is on now or comes next, even if the theme is switched off.
    occurrence = themeStatus(preview.themeId, settings.themes[preview.themeId], today).occurrence;
    birthdayChildren = [];
  } else {
    occurrence = activeTheme(settings, today);
    if (preview?.kind === 'birthday') {
      const child = data.children.find((c) => c.id === preview.childId);
      birthdayChildren = child ? [child] : [];
    } else {
      birthdayChildren = settings.birthdaysEnabled
        ? birthdays.map((b) => data.children.find((c) => c.id === b.childId)).filter((c): c is Child => c !== undefined)
        : [];
    }
  }
  return { occurrence, greeting: occurrence ? seasonGreeting(occurrence, today) : null, birthdayChildren, preview };
}

/** Halloween, Christmas and New Year use a dark night-time background. */
export function isDarkTheme(id: ThemeId | undefined): boolean {
  return id === 'halloween' || id === 'christmas' || id === 'newYear';
}

/** "Maya", "Maya and Leo", "Maya, Leo and Ivy" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
