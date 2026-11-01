import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BonusAward, Child, ThemeId } from '../../types';
import { THEMES } from '../../lib/celebrations';
import { joinNames, type CelebrationView } from '../../state/celebration';
import { Modal } from '../Modal';
import {
  Balloon,
  Bat,
  Bunny,
  Cake,
  ChristmasTree,
  EasterEgg,
  FireworkBurst,
  Flower,
  Ghost,
  Heart,
  Present,
  Pumpkin,
  Rose,
  Snowflake,
  Sparkle,
} from './art';

// Banners for the home screen (and a slim one on a birthday child's own
// chart). They sit in the normal page flow, in their own space, so they
// never cover chores, points or buttons.

const TAGLINES: Record<ThemeId, string> = {
  halloween: 'Trick or treat! Every chore ticked is a spooky treat.',
  christmas: 'Ho ho ho! Santa’s helpers are doing their chores.',
  easter: 'Hop to it! Every chore is an egg in your basket.',
  valentines: 'Show some love: help someone today!',
  newYear: 'Here’s to a sparkling new year of super helpers!',
};

function SeasonArt({ themeId, side }: { themeId: ThemeId; side: 'start' | 'end' }) {
  switch (themeId) {
    case 'halloween':
      return side === 'start' ? (
        <>
          <span className="banner-glow" />
          <Pumpkin className="banner-art-main" />
          <Bat className="banner-art-float banner-bat" />
        </>
      ) : (
        <>
          <Ghost className="banner-art-float banner-ghost" />
          <span className="banner-glow" />
          <Pumpkin className="banner-art-main banner-art-small" />
        </>
      );
    case 'christmas':
      return side === 'start' ? (
        <>
          <ChristmasTree className="banner-art-main" />
          <Snowflake className="banner-art-float banner-flake" />
        </>
      ) : (
        <>
          <Present className="banner-art-main banner-art-small" />
          <Present className="banner-art-main banner-art-tiny" box="#2a9d8f" ribbon="#fff" />
          <Snowflake className="banner-art-float banner-flake" />
        </>
      );
    case 'easter':
      return side === 'start' ? (
        <>
          <Bunny className="banner-art-main" />
          <EasterEgg className="banner-art-float banner-egg" />
        </>
      ) : (
        <>
          <Flower className="banner-art-main banner-art-small" />
          <EasterEgg className="banner-art-float banner-egg" base="#d6f5ff" band="#ffd166" dots="#ff8fb1" />
          <Flower className="banner-art-main banner-art-tiny" petal="#cdb4ff" />
        </>
      );
    case 'valentines':
      return side === 'start' ? (
        <>
          <Rose className="banner-art-main" />
          <Heart className="banner-art-float banner-heart" />
        </>
      ) : (
        <>
          <Heart className="banner-art-main banner-art-small banner-heartbeat" />
          <Sparkle className="banner-art-float banner-sparkle" fill="#ffd166" />
        </>
      );
    case 'newYear':
      return side === 'start' ? (
        <>
          <FireworkBurst className="banner-art-main banner-burst" colour="#ffd166" />
          <Sparkle className="banner-art-float banner-sparkle" fill="#e0e0f0" />
        </>
      ) : (
        <>
          <FireworkBurst className="banner-art-main banner-burst banner-burst-late" colour="#ff8fab" />
          <Sparkle className="banner-art-float banner-sparkle" fill="#ffd166" />
        </>
      );
  }
}

function Countdown({ days, themeId }: { days: number; themeId: ThemeId }) {
  return (
    <span className="countdown" aria-hidden="true" data-testid={`${themeId}-countdown`}>
      <span className="countdown-number">{days}</span>
      <span className="countdown-label">{days === 1 ? 'sleep' : 'sleeps'}</span>
    </span>
  );
}

/** The seasonal banner on the home screen, with the Christmas and New Year countdowns. */
export function SeasonBanner({ view }: { view: CelebrationView }) {
  const occurrence = view.occurrence;
  const greeting = view.greeting;
  if (!occurrence || !greeting) return null;
  const { themeId } = occurrence;
  const showCountdown = (themeId === 'christmas' || themeId === 'newYear') && greeting.daysToGo !== null && greeting.daysToGo > 0;
  return (
    <section className={`season-banner season-${themeId}`} aria-label={`${THEMES[themeId].name} theme`} data-testid="season-banner">
      <span className="season-art season-art-start" aria-hidden="true">
        <SeasonArt themeId={themeId} side="start" />
      </span>
      <div className="season-text">
        <p className="season-headline" role="status">
          {greeting.headline}
        </p>
        <p className="season-tagline">{TAGLINES[themeId]}</p>
      </div>
      {showCountdown && <Countdown days={greeting.daysToGo!} themeId={themeId} />}
      <span className="season-art season-art-end" aria-hidden="true">
        <SeasonArt themeId={themeId} side="end" />
      </span>
    </section>
  );
}

/** "Happy Birthday, Maya!" on the home screen, or a slim ribbon on that child's own chart. */
export function BirthdayBanner({ children, compact = false }: { children: Child[]; compact?: boolean }) {
  if (children.length === 0) return null;
  const names = joinNames(children.map((c) => c.name));
  return (
    <section className={`birthday-banner${compact ? ' birthday-banner-compact' : ''}`} aria-label="Birthday" data-testid="birthday-banner">
      <span className="birthday-art birthday-art-start" aria-hidden="true">
        <Balloon className="banner-balloon banner-balloon-0" fill="#ff6b9a" />
        <Balloon className="banner-balloon banner-balloon-1" fill="#ffd166" />
        {!compact && <Balloon className="banner-balloon banner-balloon-2" fill="#5ec8ff" />}
      </span>
      <div className="birthday-text">
        <p className="birthday-headline">
          Happy Birthday, {names}! <span aria-hidden="true">🎉</span>
        </p>
        {!compact && <p className="birthday-tagline">Have the most wonderful day!</p>}
      </div>
      <span className="birthday-art birthday-art-end" aria-hidden="true">
        {!compact && <Present className="banner-present" box="#c77dff" ribbon="#ffd166" />}
        <Cake className="banner-cake" />
      </span>
    </section>
  );
}

export interface CelebrationEntry {
  child: Child;
  /** This year's award, if a reward was given (now or earlier). */
  award: BonusAward | null;
  /** The reward couldn't be given right now (e.g. the server can't be reached). */
  problem: string | null;
}

/**
 * The big birthday moment: shown on a shared screen after the first tap of
 * the day, or as a parent's preview (which gives nothing).
 */
export function BirthdayCelebration({
  entries,
  preview = null,
  onClose,
}: {
  entries: CelebrationEntry[];
  /** Preview: the reward that would be given, nothing is saved. */
  preview?: { points: number; gift: string; enabled: boolean } | null;
  onClose: () => void;
}) {
  const names = joinNames(entries.map((e) => e.child.name));
  const lines: ReactNode[] = [];
  if (preview) {
    if (preview.enabled) {
      if (preview.gift) lines.push(<li key="gift">🎁 Birthday gift: {preview.gift}</li>);
      if (preview.points > 0) lines.push(<li key="pts">⭐ +{preview.points} bonus points</li>);
    }
  } else {
    for (const e of entries) {
      const who = entries.length > 1 ? `${e.child.name}: ` : '';
      if (e.award) {
        if (e.award.note) lines.push(<li key={`${e.child.id}-gift`}>🎁 {who}Your birthday gift: {e.award.note}</li>);
        if (e.award.points > 0) lines.push(<li key={`${e.child.id}-pts`}>⭐ {who}+{e.award.points} bonus points added!</li>);
      } else if (e.problem) {
        lines.push(
          <li key={`${e.child.id}-problem`} className="celebration-problem">
            {who}Your birthday gift couldn’t be added just yet. It will be added after the next tap.
          </li>,
        );
      }
    }
  }
  return (
    <Modal title={`Happy Birthday, ${names}!`} onClose={onClose} size="md">
      <div className="birthday-celebration" data-testid="birthday-celebration">
        <div className="celebration-burst" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className="burst-piece" style={{ ['--i' as string]: i }} />
          ))}
          <Balloon className="celebration-balloon celebration-balloon-0" fill="#ff6b9a" />
          <Cake className="celebration-cake" />
          <Balloon className="celebration-balloon celebration-balloon-1" fill="#5ec8ff" />
        </div>
        <p className="celebration-message">
          {entries.length > 1 ? 'Happy birthday to you both — have an amazing day!' : `Have an amazing day, ${names}!`}
        </p>
        {lines.length > 0 && <ul className="celebration-rewards">{lines}</ul>}
        {preview && <p className="celebration-preview-note">Preview only: nothing was saved and no points were given.</p>}
        <div className="button-row">
          <button type="button" className="button button-primary button-celebrate" data-autofocus onClick={onClose}>
            Thank you! <span aria-hidden="true">🎉</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Shown while a parent previews a theme or birthday on this screen. Placed
 * at the end of <body> (not inside the app), so it floats above the
 * celebration foreground layer like the other messages (styles/celebrations.css).
 */
export function PreviewBar({ label, onEnd }: { label: string; onEnd: () => void }) {
  return createPortal(
    <div className="banner banner-info preview-bar" role="status" data-testid="preview-bar">
      <span>
        <span aria-hidden="true">👀</span> <strong>Preview:</strong> {label}. Only this screen shows it; nothing is saved.
      </span>
      <button type="button" className="button button-primary" onClick={onEnd}>
        Back to scheduled theme
      </button>
    </div>,
    document.body,
  );
}
