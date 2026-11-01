import type { AnimationEvent } from 'react';
import { useFlybys, useReducedMotion, type Flyby } from '../../state/flyby';
import { Reindeer, ReindeerLegs, SantaSleigh, Sparkle } from './art';

// Santa's sleigh and four reindeer crossing the screen now and then
// (Christmas, foreground layer). Scheduling lives in state/flyby.ts; this
// draws one crossing and reports when it has gone.
//
//   .santa-flyby   a full-width line at the flight's height; mirrored for right-to-left
//   .santa-cross   carries the team across (and up or down a little), linear
//   .santa-arc     an optional gentle dip or hump on the way
//   .santa-scale   this crossing's size
//   .santa-bob     the team's steady rise and fall, and the parts:
//                  reindeer (each bobbing, legs galloping), reins, sleigh,
//                  its glow and a trail of sparkles behind it.
// Only transform and opacity change, on separate elements, so the GPU does
// the work. Everything here is removed from the page when the crossing ends.

const TEAM = [
  { left: 34, top: 47, delay: -0.15 },
  { left: 51, top: 39, delay: -0.45 },
  { left: 67, top: 31, delay: -0.05 },
  { left: 83, top: 23, delay: -0.3, rudolph: true },
] as const;

/** Sparkles trailing behind the sleigh: distance behind (% of the team's width), height (%), size (rem). */
const TRAIL = [
  { x: -3, y: 78, size: 1.15 },
  { x: -8, y: 66, size: 0.95 },
  { x: -13, y: 84, size: 0.85 },
  { x: -18, y: 71, size: 0.75 },
  { x: -24, y: 80, size: 0.6 },
  { x: -30, y: 69, size: 0.5 },
  { x: -36, y: 77, size: 0.42 },
] as const;

// Reins from Santa's hand to the first reindeer's collar, then along the team
// (coordinates: % of the team's width, and % of its height x 0.3).
const HAND = { x: 21.6, y: 63 };
const collar = (r: (typeof TEAM)[number]) => ({ x: r.left + 0.64 * 17, y: r.top + (40 / 70) * 40 });

function Reins() {
  const points = [HAND, ...TEAM.map(collar)];
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${(p.y * 0.3).toFixed(1)}`).join(' ');
  return (
    <svg className="santa-reins" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d={d} stroke="#ffd166" strokeWidth="1.6" fill="none" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Team({ flyby, onDone }: { flyby: Flyby; onDone: () => void }) {
  const crossed = (e: AnimationEvent) => {
    if (e.target === e.currentTarget) onDone();
  };
  const timing = { animationDuration: `${flyby.durationS}s` };
  return (
    <div
      className={`santa-flyby santa-${flyby.direction}`}
      style={{ top: `${flyby.topVh}vh` }}
      data-testid="santa-flyby"
      data-direction={flyby.direction}
      data-path={`${flyby.climb}-${flyby.arc}`}
    >
      <div className={`santa-cross santa-cross-${flyby.climb}`} style={timing} onAnimationEnd={crossed}>
        <div className={`santa-arc santa-arc-${flyby.arc}`} style={timing}>
          <div className="santa-scale" style={{ transform: `scale(${flyby.scale})` }}>
            <div className="santa-bob" style={{ animationDelay: `${flyby.bobDelayS}s` }}>
              {TRAIL.map((s, i) => (
                <span key={i} className="santa-spark" style={{ left: `${s.x}%`, top: `${s.y}%`, width: `${s.size}rem`, animationDelay: `${-i * 0.17}s` }}>
                  <Sparkle fill={i % 3 === 1 ? '#ffffff' : '#ffe08a'} />
                </span>
              ))}
              <span className="sleigh-glow" />
              <Reins />
              {TEAM.map((r, i) => (
                <span key={i} className="reindeer" data-testid="reindeer" style={{ left: `${r.left}%`, top: `${r.top}%`, animationDelay: `${r.delay}s` }}>
                  <ReindeerLegs pair="back" className="reindeer-legs legs-back" style={{ animationDelay: `${r.delay}s` }} />
                  <Reindeer rudolph={'rudolph' in r} className="reindeer-body" />
                  <ReindeerLegs pair="front" className="reindeer-legs legs-front" style={{ animationDelay: `${r.delay}s` }} />
                  {'rudolph' in r && <span className="rudolph-glow" />}
                </span>
              ))}
              <SantaSleigh className="santa-sleigh" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Occasional Santa fly-bys. Mount with a key per preview so a new preview starts afresh. */
export function SantaFlyby({ paused, preview }: { paused: boolean; preview: boolean }) {
  const reduced = useReducedMotion();
  const { flyby, finish } = useFlybys({ active: !paused && !reduced, preview });
  return flyby ? <Team key={flyby.id} flyby={flyby} onDone={finish} /> : null;
}
