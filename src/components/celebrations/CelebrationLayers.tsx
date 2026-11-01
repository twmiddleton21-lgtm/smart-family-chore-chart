import type { CSSProperties, ReactNode } from 'react';
import type { ThemeId } from '../../types';
import type { CelebrationView } from '../../state/celebration';
import {
  Balloon,
  BatTorso,
  BatWing,
  Bunny,
  Bunting,
  ChristmasTree,
  Cobweb,
  EasterEgg,
  FireworkBurst,
  Flower,
  Ghost,
  Heart,
  Holly,
  Moon,
  Present,
  Pumpkin,
  Rose,
  Sparkle,
  Spider,
} from './art';
import { SantaFlyby } from './SantaFlyby';

// The seasonal decorations, drawn ONCE for the whole app by CelebrationHost
// (state/celebrationHost.tsx), on every screen.
//
//   backdrop    fixed, behind the app: the themed sky, snow, the moon and
//               ghosts, Easter eggs, twinkling sparkles and the ground strip.
//   frame       fixed, behind the app: the garland in the free band the
//               screens leave at the top of the page, and the corner pieces.
//   foreground  fixed, IN FRONT of the app: the things that fly or float
//               across (bats, hearts and roses, fireworks and confetti,
//               birthday balloons, Santa's sleigh), so a translucent panel
//               never hides them. Below the preview bar, messages and every
//               dialog (see the stacking order in styles/celebrations.css).
//
// No layer takes pointer events, so decorations never get in the way of a
// tap, a swipe or scrolling. Every animation uses fixed keyframes
// that change only transform and opacity (no CSS variables inside keyframes),
// so the browser runs them on the GPU. Positions are fixed numbers, so the
// layout is stable and, with motion switched off, every piece rests where it
// stands as a still picture.

/** Deterministic pseudo-random numbers in [0, 1), so decorations look scattered but never jump. */
function scatter(seed: number, count: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < count; i++) {
    x = (x * 9301 + 49297) % 233280;
    out.push(x / 233280);
  }
  return out;
}

type Vars = CSSProperties & Record<`--${string}`, string | number>;

function drift(count: number, seed: number, make: (i: number, r: (k: number) => number) => ReactNode) {
  const rnd = scatter(seed, count * 6);
  return Array.from({ length: count }, (_, i) => make(i, (k) => rnd[i * 6 + k]!));
}

// ---------- Snow: three depths of tiled flakes, plus a few big near flakes ----------

/**
 * Falling snow. Each depth is ONE element whose background is a tile of small
 * flakes, moved down by exactly one tile and repeated, so hundreds of flakes
 * fall continuously for three animations. Far flakes are small and slow, near
 * ones larger and faster; each depth also drifts sideways. A few big flakes
 * fall separately in front of them.
 */
function Snow() {
  return (
    <div className="deco-field snow" data-testid="snow">
      {(['far', 'mid', 'near'] as const).map((depth) => (
        <div key={depth} className={`snow-sway snow-sway-${depth}`}>
          <div className={`snow-sheet snow-${depth}`} />
        </div>
      ))}
      {drift(8, 7, (i, r) => {
        const size = `${(0.55 + r(2) * 0.4).toFixed(2)}rem`;
        return (
          <span
            key={i}
            className="fall-column"
            style={
              {
                left: `${(4 + r(0) * 92).toFixed(1)}vw`,
                '--y': (r(1) * 100).toFixed(1),
                animationDuration: `${(9 + r(3) * 6).toFixed(1)}s`,
                animationDelay: `-${(r(4) * 15).toFixed(1)}s`,
              } as Vars
            }
          >
            <span className="snowflake snowflake-sway" style={{ width: size, height: size, animationDuration: `${(2.5 + r(5) * 2).toFixed(1)}s` }} />
          </span>
        );
      })}
    </div>
  );
}

const CONFETTI_COLOURS = ['#ff4d6d', '#ffd166', '#4cc9f0', '#80ed99', '#c77dff', '#ff9f1c'];

function Confetti({ count = 16, seed = 11, colours = CONFETTI_COLOURS }: { count?: number; seed?: number; colours?: string[] }) {
  return (
    <div className="deco-field">
      {drift(count, seed, (i, r) => (
        <span
          key={i}
          className="fall-column"
          style={
            {
              left: `${(r(0) * 100).toFixed(1)}vw`,
              '--y': (r(1) * 100).toFixed(1),
              animationDuration: `${(9 + r(2) * 8).toFixed(1)}s`,
              animationDelay: `-${(r(3) * 16).toFixed(1)}s`,
            } as Vars
          }
        >
          <span className="confetti" style={{ background: colours[i % colours.length], animationDuration: `${(1.2 + r(4) * 1.6).toFixed(1)}s` }} />
        </span>
      ))}
    </div>
  );
}

/** Pieces that bob in place (Easter eggs) or twinkle (sparkles). */
function Floaters({ count, seed, render, className }: { count: number; seed: number; className: string; render: (i: number) => ReactNode }) {
  return (
    <div className="deco-field">
      {drift(count, seed, (i, r) => (
        <span
          key={i}
          className={`floater ${className}`}
          style={{
            left: `${(4 + r(0) * 90).toFixed(1)}vw`,
            top: `${(10 + r(1) * 85).toFixed(1)}vh`,
            width: `${(2.2 + r(2) * 2.2).toFixed(2)}rem`,
            animationDuration: `${(3.5 + r(3) * 2.5).toFixed(1)}s`,
            animationDelay: `-${(r(4) * 6).toFixed(1)}s`,
          }}
        >
          {render(i)}
        </span>
      ))}
    </div>
  );
}

/** Pieces that rise from the bottom of the screen to the top (hearts, balloons). */
function Risers({ count, seed, render, className, slow = 1 }: { count: number; seed: number; className: string; slow?: number; render: (i: number) => ReactNode }) {
  return (
    <div className="deco-field">
      {drift(count, seed, (i, r) => (
        <span
          key={i}
          className="rise-column"
          style={
            {
              left: `${(4 + r(0) * 90).toFixed(1)}vw`,
              '--y': (10 + r(1) * 80).toFixed(1),
              animationDuration: `${((14 + r(3) * 10) * slow).toFixed(1)}s`,
              animationDelay: `-${(r(4) * 24).toFixed(1)}s`,
            } as Vars
          }
        >
          <span className={`floater-sway ${className}`} style={{ width: `${(2.2 + r(2) * 2.2).toFixed(2)}rem`, animationDelay: `-${(r(5) * 4).toFixed(1)}s` }}>
            {render(i)}
          </span>
        </span>
      ))}
    </div>
  );
}

// ---------- Halloween ----------

/**
 * Seven bats, each with its own route, speed, size and wingbeat. Some cross
 * the whole screen, one turns back the way it came, one loops and escapes
 * over the top, one climbs away diagonally. Far bats are smaller, fainter
 * and slower. Each bat's wings flap on their own (a quick downstroke and a
 * slower recovery) while its body lifts a little with each beat.
 *
 *   x     the route across (.bat-flight, a full-width strip; % = screen width)
 *   y     the rise and fall on the way (.bat-lift), same duration and start
 *   rest  where the bat rests, as a still picture, with reduced motion (% across)
 */
const BATS = [
  { x: 'cross-ltr', y: 'wave', top: 14, width: 4.4, depth: 'near', dur: 21, delay: -4, flap: 0.42, rest: 18 },
  { x: 'cross-rtl', y: 'swoop', top: 30, width: 3.2, depth: 'mid', dur: 26, delay: -14, flap: 0.34, rest: 72 },
  { x: 'turn-back', y: 'flutter', top: 47, width: 3.6, depth: 'mid', dur: 17, delay: -6, flap: 0.36, rest: 30 },
  { x: 'loop-up', y: 'escape', top: 62, width: 4.8, depth: 'near', dur: 23, delay: -18, flap: 0.46, rest: 84 },
  { x: 'drift-rtl', y: 'wave', top: 9, width: 2.3, depth: 'far', dur: 37, delay: -25, flap: 0.28, rest: 56 },
  { x: 'diagonal', y: 'climb', top: 74, width: 3.3, depth: 'mid', dur: 29, delay: -10, flap: 0.32, rest: 8 },
  { x: 'dart-ltr', y: 'dip', top: 40, width: 2.6, depth: 'far', dur: 15, delay: -2, flap: 0.27, rest: 44 },
] as const;

/** A bat's width: `rem` on a typical screen, larger on a big kiosk screen, never tiny on a phone. */
const batWidth = (rem: number) => `clamp(${(rem * 0.85).toFixed(2)}rem, ${(rem * 1.9).toFixed(1)}vmin, ${(rem * 1.6).toFixed(2)}rem)`;

function Bats() {
  return (
    <>
      {BATS.map((b, i) => {
        const route = { animationDuration: `${b.dur}s`, animationDelay: `${b.delay}s` };
        const beat = { animationDuration: `${b.flap}s` };
        return (
          <span key={i} className={`bat-flight bat-x-${b.x}`} data-testid="bat" style={{ top: `${b.top}vh`, ...route, ['--rest' as string]: `${b.rest}%` }}>
            <span className={`bat-lift bat-y-${b.y}`} style={route}>
              <span className={`bat bat-${b.depth}`} style={{ width: batWidth(b.width) }}>
                <span className="bat-bob" style={beat}>
                  <BatWing side="left" className="bat-wing bat-wing-left" style={beat} />
                  <BatTorso className="bat-torso" />
                  <BatWing side="right" className="bat-wing bat-wing-right" style={beat} />
                </span>
              </span>
            </span>
          </span>
        );
      })}
    </>
  );
}

/** A jack-o'-lantern with two layers of candle light: a wide soft glow and a warm core. */
function GlowingPumpkin({ className }: { className: string }) {
  return (
    <span className={`ground-pumpkin ${className}`} data-testid="pumpkin">
      <span className="pumpkin-glow" />
      <span className="pumpkin-core" />
      <Pumpkin />
    </span>
  );
}

// ---------- Christmas ----------

const LIGHT_COLOURS = ['#ff3b5c', '#ffcf3f', '#3fc8ff', '#5ff08f', '#c77dff', '#ff8f3f'];
const LIGHT_COUNT = 28;

/**
 * Fairy lights on a drooping wire across the top. Each bulb glows up and
 * dims in turn (a gentle chase along the string); the glow is a soft halo
 * whose opacity changes, never a flash.
 */
function FairyLights() {
  const scallops = Array.from({ length: LIGHT_COUNT }, (_, i) => {
    const x0 = (i / LIGHT_COUNT) * 1000;
    const x1 = ((i + 1) / LIGHT_COUNT) * 1000;
    return `${i === 0 ? `M${x0} 6 ` : ''}Q${(x0 + x1) / 2} 34 ${x1} 6`;
  }).join(' ');
  return (
    <div className="fairy-lights" data-testid="fairy-lights">
      <svg className="fairy-wire" viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <path d={scallops} stroke="#8fb07e" strokeWidth="2" fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      {Array.from({ length: LIGHT_COUNT }, (_, i) => (
        <span
          key={i}
          className="fairy-bulb"
          style={
            {
              left: `${((i + 0.5) / LIGHT_COUNT) * 100}%`,
              '--bulb': LIGHT_COLOURS[i % LIGHT_COLOURS.length],
            } as Vars
          }
        >
          <span className="bulb-cap" />
          <span className="bulb-body" />
          <span className="bulb-light" style={{ animationDelay: `${-((i % 7) * 0.55).toFixed(2)}s` }} />
        </span>
      ))}
    </div>
  );
}

// ---------- Shared palettes ----------

const HEART_COLOURS = ['#ff4d6d', '#ff8fab', '#c9184a', '#ffb3c6'];
const EGG_STYLES = [
  { base: '#ffd6e8', band: '#b39cf5', dots: '#7bdcb5' },
  { base: '#d6f5ff', band: '#ffd166', dots: '#ff8fb1' },
  { base: '#e8ffd6', band: '#ff9ec0', dots: '#5ec8ff' },
  { base: '#fff3c4', band: '#7bdcb5', dots: '#c77dff' },
];
const BALLOON_COLOURS = ['#ff6b9a', '#ffd166', '#5ec8ff', '#7bdcb5', '#c77dff', '#ff9f1c'];

// ---------- Ground strip (bottom of the screen) ----------

function Ground({ themeId }: { themeId: ThemeId | null }) {
  if (themeId === 'halloween') {
    return (
      <div className="deco-ground ground-halloween">
        {[0, 1, 2, 3].map((i) => (
          <GlowingPumpkin key={i} className={`ground-pumpkin-${i}`} />
        ))}
      </div>
    );
  }
  if (themeId === 'christmas') {
    return (
      <div className="deco-ground ground-christmas">
        <span className="snow-drift" />
        <ChristmasTree className="ground-tree ground-tree-0" />
        <Present className="ground-present ground-present-0" />
        <Present className="ground-present ground-present-1" box="#2a9d8f" ribbon="#ffffff" />
        <ChristmasTree className="ground-tree ground-tree-1" />
      </div>
    );
  }
  if (themeId === 'easter') {
    return (
      <div className="deco-ground ground-easter">
        <span className="grass" />
        <Flower className="ground-flower ground-flower-0" />
        <EasterEgg className="ground-egg ground-egg-0" {...EGG_STYLES[1]!} />
        <Flower className="ground-flower ground-flower-1" petal="#cdb4ff" />
        <Bunny className="ground-bunny" />
        <EasterEgg className="ground-egg ground-egg-1" {...EGG_STYLES[0]!} />
        <Flower className="ground-flower ground-flower-2" petal="#fff3b0" centre="#ff9f1c" />
      </div>
    );
  }
  return null;
}

// ---------- Backdrop ----------

function Backdrop({ themeId }: { themeId: ThemeId | null }) {
  return (
    <div className={`celebration-backdrop ${themeId ? `backdrop-${themeId}` : 'backdrop-birthday'}`} data-testid="celebration-backdrop">
      {themeId === 'halloween' && (
        <>
          <Moon className="deco-moon" />
          <span className="ghost-drift ghost-drift-0">
            <Ghost className="deco-ghost" />
          </span>
          <span className="ghost-drift ghost-drift-1">
            <Ghost className="deco-ghost" />
          </span>
        </>
      )}
      {themeId === 'christmas' && <Snow />}
      {themeId === 'easter' && (
        <Floaters count={7} seed={5} className="egg-float" render={(i) => <EasterEgg {...EGG_STYLES[i % EGG_STYLES.length]!} />} />
      )}
      {themeId === 'valentines' && <Floaters count={8} seed={17} className="sparkle-twinkle" render={() => <Sparkle fill="#ffd6e0" />} />}
      {themeId === 'newYear' && (
        <Floaters count={10} seed={29} className="sparkle-twinkle" render={(i) => <Sparkle fill={i % 2 ? '#e0e0f0' : '#ffd166'} />} />
      )}
      <Ground themeId={themeId} />
    </div>
  );
}

// ---------- Foreground (in front of the app) ----------

function Foreground({ themeId, birthday, preview, paused }: { themeId: ThemeId | null; birthday: boolean; preview: boolean; paused: boolean }) {
  return (
    <div className="celebration-foreground" data-testid="celebration-foreground">
      {themeId === 'halloween' && <Bats />}
      {themeId === 'christmas' && <SantaFlyby key={preview ? 'preview' : 'scheduled'} paused={paused} preview={preview} />}
      {themeId === 'valentines' && (
        <>
          <Risers count={10} seed={3} className="heart-rise" render={(i) => <Heart fill={HEART_COLOURS[i % HEART_COLOURS.length]} />} />
          <Risers count={4} seed={19} slow={1.2} className="rose-rise" render={() => <Rose />} />
        </>
      )}
      {themeId === 'newYear' && (
        <>
          {['#ffd166', '#e0e0f0', '#ff8fab', '#7ae7ff'].map((colour, i) => (
            <span key={colour} className={`firework-slot firework-${i}`}>
              <span className="firework">
                <FireworkBurst colour={colour} />
              </span>
            </span>
          ))}
          <Confetti count={18} seed={23} colours={['#ffd166', '#f5f5ff', '#e8c66a', '#c0c4d6', '#fff1b8']} />
        </>
      )}
      {birthday && (
        <>
          <Risers count={6} seed={41} slow={1.3} className="balloon-rise" render={(i) => <Balloon fill={BALLOON_COLOURS[i % BALLOON_COLOURS.length]} />} />
          {themeId !== 'newYear' && <Confetti count={12} seed={43} />}
        </>
      )}
    </div>
  );
}

// ---------- Frame (top garland and corners) ----------

function Frame({ themeId, birthday }: { themeId: ThemeId | null; birthday: boolean }) {
  return (
    <div className={`celebration-frame ${themeId ? `frame-${themeId}` : 'frame-birthday'}`}>
      {themeId === 'halloween' && (
        <>
          <Cobweb className="deco-web deco-web-left" />
          <Cobweb className="deco-web deco-web-right" />
          <span className="spider-drop spider-drop-left">
            <span className="spider-thread" />
            <Spider className="deco-spider" />
          </span>
          <span className="spider-drop spider-drop-right">
            <span className="spider-thread" />
            <Spider className="deco-spider" />
          </span>
          <span className="spider-crawl">
            <Spider className="deco-spider deco-spider-small" />
          </span>
        </>
      )}
      {themeId === 'christmas' && (
        <>
          <FairyLights />
          <Holly className="deco-corner deco-corner-left" />
          <Holly className="deco-corner deco-corner-right" />
        </>
      )}
      {themeId === 'easter' && <Bunting className="deco-garland" colours={['#ffc2d6', '#cdb4ff', '#b5e8ff', '#c7f9cc', '#fff3b0']} count={48} />}
      {themeId === 'valentines' && (
        <>
          <Bunting className="deco-garland" colours={['#ff4d6d', '#ffb3c6', '#c9184a', '#ff8fab']} count={48} />
          <Rose className="deco-corner deco-corner-left deco-rose" />
          <Rose className="deco-corner deco-corner-right deco-rose" />
        </>
      )}
      {themeId === 'newYear' && <Bunting className="deco-garland" colours={['#ffd166', '#d9dbe8', '#e8c66a', '#ffffff']} count={48} />}
      {!themeId && birthday && <Bunting className="deco-garland" colours={BALLOON_COLOURS} count={48} />}
    </div>
  );
}

/** All decorations for the current celebration, or nothing. Mount it once (CelebrationHost). */
export function CelebrationLayers({ view, paused = false }: { view: CelebrationView; paused?: boolean }) {
  const themeId = view.occurrence?.themeId ?? null;
  const birthday = view.birthdayChildren.length > 0;
  if (!themeId && !birthday) return null;
  return (
    <div className={`celebration-layers${paused ? ' celebration-paused' : ''}`} data-theme={themeId ?? 'birthday'} aria-hidden="true">
      <Backdrop themeId={themeId} />
      <Frame themeId={themeId} birthday={birthday} />
      <Foreground themeId={themeId} birthday={birthday} preview={view.preview !== null} paused={paused} />
    </div>
  );
}
