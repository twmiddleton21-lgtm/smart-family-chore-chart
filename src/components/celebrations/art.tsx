import type { CSSProperties } from 'react';

// Small hand-drawn SVG pieces for the seasonal themes and birthdays. All are
// decorative (aria-hidden), drawn inline (no downloads), and animated only
// with CSS transforms and opacity (see styles/celebrations.css), which the
// Raspberry Pi's GPU handles cheaply.

interface ArtProps {
  className?: string;
  style?: CSSProperties;
}

const svg = (className = '', style?: CSSProperties) => ({
  className: `art ${className}`,
  style,
  'aria-hidden': true as const,
  focusable: 'false' as const,
});

// ---------- Halloween ----------

export function Pumpkin({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 120 104" {...svg(className, style)}>
      <path d="M58 20 C56 10 60 4 68 2 L71 8 C66 10 64 14 65 20 Z" fill="#4f7a28" />
      <path d="M66 12 C76 4 88 8 90 14 C82 12 74 14 68 18 Z" fill="#6c9f37" />
      <ellipse cx="60" cy="62" rx="54" ry="40" fill="#d9590f" />
      <ellipse cx="60" cy="62" rx="40" ry="40" fill="#f07a1a" />
      <ellipse cx="60" cy="62" rx="22" ry="40" fill="#ff922e" />
      <path d="M38 30 C30 44 30 80 38 96 M82 30 C90 44 90 80 82 96" stroke="#c44d0a" strokeWidth="2.5" fill="none" opacity="0.6" />
      <g className="pumpkin-face">
        <path d="M30 52 L44 40 L50 58 Z" />
        <path d="M90 52 L76 40 L70 58 Z" />
        <path d="M56 62 L60 54 L64 62 Z" />
        <path d="M26 70 C40 90 80 90 94 70 L84 74 L78 68 L70 76 L60 70 L50 76 L42 68 L36 74 Z" />
      </g>
    </svg>
  );
}

export function Bat({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 120 56" {...svg(className, style)}>
      <g className="bat-wings">
        <path
          d="M60 26 C55 16 47 14 40 19 C36 9 22 6 2 16 C14 18 20 26 22 33 C29 29 36 31 41 38 C46 33 53 33 60 40 C67 33 74 33 79 38 C84 31 91 29 98 33 C100 26 106 18 118 16 C98 6 84 9 80 19 C73 14 65 16 60 26 Z"
          fill="#1d1430"
          stroke="#b79cf0"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </g>
      <ellipse cx="60" cy="28" rx="7" ry="9" fill="#1d1430" stroke="#b79cf0" strokeWidth="1.2" />
      <path d="M54 22 L55 13 L59 20 Z M66 22 L65 13 L61 20 Z" fill="#1d1430" />
      <circle cx="57.5" cy="26" r="1.4" fill="#ffcf4a" />
      <circle cx="62.5" cy="26" r="1.4" fill="#ffcf4a" />
    </svg>
  );
}

export function Spider({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 60 60" {...svg(className, style)}>
      <g stroke="#3a2a5c" strokeWidth="3" strokeLinecap="round" fill="none" className="spider-legs">
        <path d="M24 30 L12 20 L4 26 M24 33 L10 32 L3 40 M25 36 L13 44 L9 54 M27 38 L22 50 L20 58" />
        <path d="M36 30 L48 20 L56 26 M36 33 L50 32 L57 40 M35 36 L47 44 L51 54 M33 38 L38 50 L40 58" />
      </g>
      <ellipse cx="30" cy="34" rx="9" ry="10" fill="#1d1430" stroke="#c9b6f5" strokeWidth="1.4" />
      <circle cx="30" cy="22" r="6" fill="#2a1d44" stroke="#c9b6f5" strokeWidth="1.2" />
      <circle cx="27.5" cy="21" r="1.6" fill="#fff" />
      <circle cx="32.5" cy="21" r="1.6" fill="#fff" />
    </svg>
  );
}

/** A corner cobweb, drawn for the top-left corner (mirror it for the right). */
export function Cobweb({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 120 120" {...svg(className, style)}>
      <g stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round">
        <path d="M0 0 L120 6 M0 0 L110 46 M0 0 L84 84 M0 0 L46 110 M0 0 L6 120" />
        <path d="M30 2 Q26 12 28 12 Q22 20 24 24 Q16 24 12 28 Q12 22 2 30" />
        <path d="M60 3 Q52 20 55 23 Q44 38 48 48 Q34 46 24 55 Q22 46 3 60" />
        <path d="M92 5 Q80 30 83 35 Q66 58 70 70 Q52 68 36 84 Q32 70 5 92" />
      </g>
    </svg>
  );
}

export function Ghost({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 80 96" {...svg(className, style)}>
      <path d="M8 44 C8 18 24 4 40 4 C56 4 72 18 72 44 L72 88 L62 80 L52 90 L40 80 L28 90 L18 80 L8 88 Z" fill="#f6f2ff" />
      <ellipse cx="29" cy="40" rx="5" ry="7" fill="#2a1d44" />
      <ellipse cx="51" cy="40" rx="5" ry="7" fill="#2a1d44" />
      <ellipse cx="40" cy="58" rx="6" ry="8" fill="#2a1d44" />
    </svg>
  );
}

export function Moon({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 100 100" {...svg(className, style)}>
      <circle cx="50" cy="50" r="44" fill="#fff4c9" />
      <circle cx="36" cy="38" r="8" fill="#f1e2a4" />
      <circle cx="62" cy="62" r="11" fill="#f1e2a4" />
      <circle cx="64" cy="30" r="5" fill="#f1e2a4" />
    </svg>
  );
}

// ---------- Christmas ----------

const BAUBLES = ['#ff4d6d', '#ffd166', '#5ec8ff', '#ff9f1c', '#c77dff', '#ff4d6d', '#ffd166', '#5ec8ff'];

export function ChristmasTree({ className, style }: ArtProps) {
  const dots: [number, number][] = [
    [50, 34], [40, 48], [62, 50], [32, 66], [52, 66], [70, 70], [26, 86], [44, 84], [62, 88], [78, 86],
  ];
  return (
    <svg viewBox="0 0 100 120" {...svg(className, style)}>
      <rect x="44" y="100" width="12" height="16" rx="2" fill="#7a4a24" />
      <path d="M50 14 L74 50 L62 50 L82 76 L68 76 L92 102 L8 102 L32 76 L18 76 L38 50 L26 50 Z" fill="#1f8a4c" />
      <path d="M50 14 L74 50 L62 50 L82 76 L68 76 L92 102 L50 102 Z" fill="#17703c" />
      <path d="M30 58 Q50 66 70 56 M22 84 Q50 94 80 82" stroke="#ffe08a" strokeWidth="2.5" fill="none" strokeDasharray="1 5" strokeLinecap="round" />
      {/* Two groups that twinkle in turn: two animations, however many baubles. */}
      {[0, 1].map((g) => (
        <g key={g} className={`twinkle twinkle-${g}`}>
          {dots.map(([x, y], i) => (i % 2 === g ? <circle key={i} cx={x} cy={y} r="4" fill={BAUBLES[i % BAUBLES.length]} /> : null))}
        </g>
      ))}
      <path
        className="tree-star"
        d="M50 2 L54 11 L64 11 L56 17 L59 27 L50 21 L41 27 L44 17 L36 11 L46 11 Z"
        fill="#ffd23f"
        stroke="#f5a700"
        strokeWidth="1"
      />
    </svg>
  );
}

export function Present({ className, style, box = '#e63946', ribbon = '#ffd166' }: ArtProps & { box?: string; ribbon?: string }) {
  return (
    <svg viewBox="0 0 80 80" {...svg(className, style)}>
      <rect x="8" y="30" width="64" height="46" rx="4" fill={box} />
      <rect x="4" y="22" width="72" height="14" rx="3" fill={box} />
      <rect x="4" y="22" width="72" height="14" rx="3" fill="#000" opacity="0.08" />
      <rect x="35" y="22" width="10" height="54" fill={ribbon} />
      <path d="M40 22 C30 8 14 10 18 18 C21 24 34 22 40 22 C46 22 59 24 62 18 C66 10 50 8 40 22 Z" fill={ribbon} />
    </svg>
  );
}

export function Holly({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 100 70" {...svg(className, style)}>
      <path d="M50 36 C40 22 24 18 6 22 C12 26 10 32 16 34 C12 40 18 44 24 42 C26 48 34 46 36 44 C40 46 46 42 50 36 Z" fill="#1f8a4c" />
      <path d="M50 36 C60 22 76 18 94 22 C88 26 90 32 84 34 C88 40 82 44 76 42 C74 48 66 46 64 44 C60 46 54 42 50 36 Z" fill="#17703c" />
      <circle cx="44" cy="40" r="7" fill="#d62839" />
      <circle cx="56" cy="40" r="7" fill="#e63946" />
      <circle cx="50" cy="30" r="7" fill="#c1121f" />
    </svg>
  );
}

export function Snowflake({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 40 40" {...svg(className, style)}>
      <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M20 2 V38 M4.4 11 L35.6 29 M4.4 29 L35.6 11" />
        <path d="M14 6 L20 11 L26 6 M14 34 L20 29 L26 34" />
      </g>
    </svg>
  );
}

// ---------- Easter ----------

export function EasterEgg({ className, style, base = '#ffd6e8', band = '#b39cf5', dots = '#7bdcb5' }: ArtProps & { base?: string; band?: string; dots?: string }) {
  return (
    <svg viewBox="0 0 60 76" {...svg(className, style)}>
      <path d="M30 2 C46 2 58 28 58 46 C58 64 46 74 30 74 C14 74 2 64 2 46 C2 28 14 2 30 2 Z" fill={base} />
      <path d="M4 40 L12 34 L20 40 L28 34 L36 40 L44 34 L52 40 L57 36 L58 46 L50 50 L42 44 L34 50 L26 44 L18 50 L10 44 L2 48 Z" fill={band} />
      <circle cx="20" cy="22" r="3.5" fill={dots} />
      <circle cx="38" cy="18" r="3" fill={dots} />
      <circle cx="30" cy="62" r="4" fill={dots} />
      <circle cx="16" cy="60" r="2.5" fill={dots} />
      <circle cx="44" cy="60" r="2.5" fill={dots} />
      <path d="M18 10 C22 6 28 4 32 5" stroke="#fff" strokeWidth="3" strokeLinecap="round" fill="none" opacity="0.7" />
    </svg>
  );
}

export function Bunny({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 100 120" {...svg(className, style)}>
      <g className="bunny-ears">
        <ellipse cx="36" cy="30" rx="10" ry="28" fill="#f4eee8" transform="rotate(-10 36 30)" />
        <ellipse cx="36" cy="32" rx="5" ry="20" fill="#ffc2d6" transform="rotate(-10 36 32)" />
        <ellipse cx="64" cy="30" rx="10" ry="28" fill="#f4eee8" transform="rotate(10 64 30)" />
        <ellipse cx="64" cy="32" rx="5" ry="20" fill="#ffc2d6" transform="rotate(10 64 32)" />
      </g>
      <ellipse cx="50" cy="96" rx="34" ry="24" fill="#f4eee8" />
      <circle cx="50" cy="66" r="26" fill="#fbf7f2" />
      <circle cx="40" cy="62" r="4" fill="#3b2f4a" />
      <circle cx="60" cy="62" r="4" fill="#3b2f4a" />
      <circle cx="41.5" cy="60.5" r="1.3" fill="#fff" />
      <circle cx="61.5" cy="60.5" r="1.3" fill="#fff" />
      <path d="M46 72 L50 76 L54 72 Z" fill="#ff8fb1" />
      <circle cx="32" cy="74" r="5" fill="#ffc2d6" opacity="0.7" />
      <circle cx="68" cy="74" r="5" fill="#ffc2d6" opacity="0.7" />
    </svg>
  );
}

export function Flower({ className, style, petal = '#ffb3c6', centre = '#ffd166' }: ArtProps & { petal?: string; centre?: string }) {
  return (
    <svg viewBox="0 0 60 90" {...svg(className, style)}>
      <path d="M30 40 C30 60 28 72 30 90" stroke="#5aa95f" strokeWidth="4" fill="none" />
      <path d="M30 70 C18 64 12 66 8 70 C14 76 22 76 30 72 Z" fill="#6cc070" />
      <path d="M31 62 C42 54 50 56 54 60 C48 66 40 68 31 64 Z" fill="#6cc070" />
      {[0, 72, 144, 216, 288].map((a) => (
        <ellipse key={a} cx="30" cy="16" rx="9" ry="14" fill={petal} transform={`rotate(${a} 30 30)`} />
      ))}
      <circle cx="30" cy="30" r="9" fill={centre} />
    </svg>
  );
}

// ---------- Valentine's Day ----------

export const HEART_PATH = 'M50 90 C22 70 4 52 4 32 C4 16 16 6 30 6 C40 6 46 12 50 20 C54 12 60 6 70 6 C84 6 96 16 96 32 C96 52 78 70 50 90 Z';

export function Heart({ className, style, fill = '#ff4d6d' }: ArtProps & { fill?: string }) {
  return (
    <svg viewBox="0 0 100 96" {...svg(className, style)}>
      <path d={HEART_PATH} fill={fill} />
      <path d="M24 22 C18 26 16 32 17 38" stroke="#fff" strokeWidth="5" strokeLinecap="round" fill="none" opacity="0.45" />
    </svg>
  );
}

export function Rose({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 70 110" {...svg(className, style)}>
      <path d="M35 44 C33 70 36 86 34 110" stroke="#2f7d3b" strokeWidth="4" fill="none" />
      <path d="M34 78 C22 70 12 72 8 78 C16 86 26 84 34 80 Z" fill="#3e9b4c" />
      <path d="M36 66 C48 58 58 60 62 66 C54 74 44 72 36 68 Z" fill="#3e9b4c" />
      <path d="M12 26 C10 10 22 2 35 4 C48 2 60 10 58 26 C56 42 46 48 35 48 C24 48 14 42 12 26 Z" fill="#c9184a" />
      <path d="M20 22 C22 12 32 8 40 12 C48 16 46 26 38 28 C32 30 28 24 32 20" stroke="#800f2f" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M16 30 C22 40 46 42 54 30" stroke="#a4133c" strokeWidth="2.5" fill="none" />
    </svg>
  );
}

export function Sparkle({ className, style, fill = '#ffd166' }: ArtProps & { fill?: string }) {
  return (
    <svg viewBox="0 0 100 100" {...svg(className, style)}>
      <path d="M50 0 C54 34 66 46 100 50 C66 54 54 66 50 100 C46 66 34 54 0 50 C34 46 46 34 50 0 Z" fill={fill} />
    </svg>
  );
}

// ---------- New Year ----------

/** One firework burst: rays and sparks that expand and fade (CSS). */
export function FireworkBurst({ className, style, colour = '#ffd166' }: ArtProps & { colour?: string }) {
  const rays = Array.from({ length: 12 }, (_, i) => (i * 360) / 12);
  return (
    <svg viewBox="0 0 120 120" {...svg(className, style)}>
      <g stroke={colour} strokeWidth="3.5" strokeLinecap="round">
        {rays.map((a) => (
          <path key={a} d="M60 40 L60 16" transform={`rotate(${a} 60 60)`} />
        ))}
      </g>
      <g fill="#fff">
        {rays.map((a) => (
          <circle key={a} cx="60" cy="8" r="2.6" transform={`rotate(${a + 15} 60 60)`} />
        ))}
      </g>
    </svg>
  );
}

// ---------- Birthdays ----------

export function Balloon({ className, style, fill = '#ff6b9a' }: ArtProps & { fill?: string }) {
  return (
    <svg viewBox="0 0 60 130" {...svg(className, style)}>
      <path d="M30 76 C26 92 36 100 30 112 C26 120 32 124 30 130" stroke="#8a7f99" strokeWidth="1.6" fill="none" />
      <path d="M30 2 C46 2 56 16 56 32 C56 52 42 70 30 72 C18 70 4 52 4 32 C4 16 14 2 30 2 Z" fill={fill} />
      <path d="M26 72 L34 72 L31 78 L29 78 Z" fill={fill} />
      <ellipse cx="19" cy="22" rx="5" ry="9" fill="#fff" opacity="0.45" transform="rotate(20 19 22)" />
    </svg>
  );
}

export function Cake({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 120 120" {...svg(className, style)}>
      <ellipse cx="60" cy="110" rx="54" ry="7" fill="#e4d7f5" />
      <rect x="14" y="66" width="92" height="42" rx="8" fill="#ff9ec0" />
      <path d="M14 76 C20 86 26 86 30 76 C34 86 42 86 46 76 C50 86 58 86 62 76 C66 86 74 86 78 76 C82 86 90 86 94 76 C98 86 104 84 106 76 L106 72 C106 68 102 66 98 66 L22 66 C18 66 14 68 14 72 Z" fill="#fff4f8" />
      <rect x="26" y="40" width="68" height="28" rx="7" fill="#b39cf5" />
      <path d="M26 48 C32 56 38 56 42 48 C46 56 54 56 58 48 C62 56 70 56 74 48 C78 56 86 56 90 48 L94 46 C94 42 90 40 86 40 L34 40 C30 40 26 42 26 46 Z" fill="#fff4f8" />
      <circle cx="30" cy="96" r="3" fill="#ffd166" />
      <circle cx="52" cy="98" r="3" fill="#7bdcb5" />
      <circle cx="74" cy="96" r="3" fill="#5ec8ff" />
      <circle cx="94" cy="98" r="3" fill="#ffd166" />
      {[42, 60, 78].map((x, i) => (
        <g key={x}>
          <rect x={x - 3} y="18" width="6" height="22" rx="2" fill={['#5ec8ff', '#ffd166', '#7bdcb5'][i]} />
          <path className="flame" d={`M${x} 4 C${x + 5} 10 ${x + 5} 16 ${x} 18 C${x - 5} 16 ${x - 5} 10 ${x} 4 Z`} fill="#ffb703" style={{ animationDelay: `${i * 0.3}s` }} />
        </g>
      ))}
    </svg>
  );
}

/** Party bunting (triangle flags) along the top. */
export function Bunting({ className, style, colours, count = 12 }: ArtProps & { colours: string[]; count?: number }) {
  const width = count * 50;
  return (
    <svg viewBox={`0 0 ${width} 46`} preserveAspectRatio="xMinYMin meet" {...svg(className, style)}>
      <path d={Array.from({ length: Math.ceil(count / 4) }, (_, i) => `${i === 0 ? 'M0 4 ' : ''}Q${i * 200 + 100} 16 ${i * 200 + 200} 4`).join(' ')} stroke="#8a7f99" strokeWidth="2" fill="none" />
      {Array.from({ length: count }, (_, i) => {
        const x = i * 50 + 5;
        const t = ((i % 4) + 0.5) / 4;
        const sag = 4 + 12 * 4 * t * (1 - t) * 0.75;
        return <path key={i} d={`M${x} ${sag} L${x + 40} ${sag} L${x + 20} ${sag + 34} Z`} fill={colours[i % colours.length]} />;
      })}
    </svg>
  );
}

// ---------- Flying pieces (foreground layer) ----------
// Drawn in parts so each moving part is its own element: the browser then
// moves them on the GPU (animating shapes INSIDE one svg would repaint it
// every frame).

const BAT_FILL = '#170d26';
const BAT_RIM = 'rgb(214 196 255 / 0.85)';
const WING =
  'M58 7 C50 1 38 -1 27 3 C18 6 9 4 1 9 C5 12 7 17 6 22 C10 18 15 19 18 24 C21 18 27 18 30 25 C33 18 40 17 43 23 C46 17 52 15 58 15 Z';
const WING_BONES = 'M58 9 L27 4 M58 10 L9 7 M58 11 L18 23 M58 12 L30 24 M58 13 L43 22';

/** One bat wing, drawn as the LEFT wing (shoulder at the right edge); `side="right"` mirrors it. */
export function BatWing({ className, style, side }: ArtProps & { side: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 60 34" {...svg(className, style)}>
      <g transform={side === 'right' ? 'matrix(-1 0 0 1 60 0)' : undefined}>
        <path d={WING} fill={BAT_FILL} stroke={BAT_RIM} strokeWidth="1.1" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <path d={WING_BONES} stroke={BAT_RIM} strokeWidth="0.7" opacity="0.4" fill="none" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}

/** A bat's head, ears and body, seen from the front. */
export function BatTorso({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 16 30" {...svg(className, style)}>
      <path
        d="M3 8 L3.5 0 L7 5 L9 5 L12.5 0 L13 8 C14 11 13 13 12 14 C14 18 13.5 25 8 29 C2.5 25 2 18 4 14 C3 13 2 11 3 8 Z"
        fill={BAT_FILL}
        stroke={BAT_RIM}
        strokeWidth="1"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx="6" cy="9" r="1.1" fill="#ffcf4a" />
      <circle cx="10" cy="9" r="1.1" fill="#ffcf4a" />
    </svg>
  );
}

const DEER = '#8a5a33';
const DEER_DARK = '#6a4325';

/** A flying reindeer seen from the side, facing right, without its legs (see ReindeerLegs). */
export function Reindeer({ className, style, rudolph = false }: ArtProps & { rudolph?: boolean }) {
  return (
    <svg viewBox="0 0 100 70" {...svg(className, style)}>
      <g stroke="#ecd9b0" strokeWidth="2.2" strokeLinecap="round" fill="none">
        <path d="M80 13 C78 5 74 2 69 1 M77 7 L72 8 M80 13 C83 5 88 2 93 1 M85 6 L89 9" />
      </g>
      <path d="M19 35 C14 33 12 36 13 39 C16 40 19 39 21 38 Z" fill="#f4ead8" />
      <ellipse cx="44" cy="40" rx="26" ry="12" fill={DEER} />
      <ellipse cx="46" cy="46" rx="18" ry="5" fill="#c49a6c" opacity="0.7" />
      <path d="M60 31 C66 27 71 21 75 16 L84 21 C80 28 74 37 69 43 Z" fill={DEER} />
      <path d="M75 14 C81 9 91 13 96 19 C97 23 93 25 88 24 C84 25 78 23 75 19 Z" fill={DEER} />
      <path d="M78 13 L72 8 L77 16 Z" fill={DEER_DARK} />
      <circle cx="85" cy="16.5" r="1.4" fill="#1b120c" />
      <circle cx="96" cy="20.5" r={rudolph ? 3.4 : 2.3} fill={rudolph ? '#ff2a2a' : '#3b2416'} />
      <path d="M62 29 C65 37 67 45 65 52" stroke="#c1121f" strokeWidth="3.2" fill="none" strokeLinecap="round" />
      <circle cx="65.5" cy="45" r="2.2" fill="#ffd166" />
    </svg>
  );
}

/** One pair of a reindeer's legs, on the same canvas as Reindeer so they line up. */
export function ReindeerLegs({ className, style, pair }: ArtProps & { pair: 'front' | 'back' }) {
  const d = pair === 'front' ? 'M63 46 L70 57 L77 58 M58 47 L63 59 L70 62' : 'M30 46 L23 57 L15 58 M35 47 L30 59 L22 62';
  return (
    <svg viewBox="0 0 100 70" {...svg(className, style)}>
      <path d={d} stroke={DEER_DARK} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** Santa in his sleigh with a sack of presents, facing right. */
export function SantaSleigh({ className, style }: ArtProps) {
  return (
    <svg viewBox="0 0 140 90" {...svg(className, style)}>
      <path d="M8 34 C3 16 16 4 29 9 C40 4 50 15 46 34 Z" fill="#7a4a2a" />
      <path d="M22 9 C26 13 32 13 36 9" stroke="#5a3418" strokeWidth="2" fill="none" />
      <rect x="15" y="1" width="11" height="11" rx="1.5" fill="#2a9d8f" transform="rotate(-10 20 6)" />
      <path d="M20.5 1 V12 M15 6.5 H26" stroke="#ffd166" strokeWidth="1.8" transform="rotate(-10 20 6)" />
      <rect x="29" y="-2" width="10" height="13" rx="1.5" fill="#ffd166" transform="rotate(8 34 4)" />
      <path d="M34 -2 V11" stroke="#d62828" strokeWidth="1.8" transform="rotate(8 34 4)" />
      <path d="M50 52 C48 31 57 22 71 22 C85 22 91 33 89 52 Z" fill="#d62828" />
      <rect x="51" y="40" width="37" height="5" rx="2" fill="#2b2d42" />
      <rect x="66" y="39" width="7" height="7" rx="1" fill="#ffd166" />
      <path d="M80 31 C89 32 96 35 101 38" stroke="#d62828" strokeWidth="6.5" strokeLinecap="round" fill="none" />
      <circle cx="102" cy="38.5" r="3.6" fill="#2b2d42" />
      <circle cx="73" cy="16" r="8" fill="#f6c9a8" />
      <path d="M64 15 C63 30 84 32 83 15 C79 21 68 21 64 15 Z" fill="#ffffff" />
      <path d="M68 20 C71 18 75 18 78 20" stroke="#e8e8e8" strokeWidth="2" fill="none" />
      <circle cx="76.5" cy="13.5" r="1.2" fill="#2b2d42" />
      <circle cx="80.5" cy="16.5" r="1.8" fill="#ef8f8f" />
      <path d="M64 10 C64 1 74 -3 81 3 C84 6 85 8 85 10 Z" fill="#d62828" />
      <path d="M66 4 C60 1 55 3 52 8" stroke="#d62828" strokeWidth="4.5" strokeLinecap="round" fill="none" />
      <circle cx="51" cy="9" r="3.4" fill="#ffffff" />
      <rect x="62" y="8" width="24" height="5" rx="2.5" fill="#ffffff" />
      <path
        d="M8 46 L104 46 C111 46 115 40 117 31 C124 30 127 38 123 47 C117 62 99 67 79 67 L25 67 C14 67 8 59 8 46 Z"
        fill="#b5121b"
        stroke="#ffd166"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M26 57 C32 50 42 51 43 57 C44 61 38 62 37 58" stroke="#ffd166" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M30 67 L27 74 M90 67 L93 74" stroke="#ffd166" strokeWidth="3" strokeLinecap="round" />
      <path d="M12 74 L113 74 C123 74 129 68 127 60 C126 56 122 56 121 60" stroke="#ffd166" strokeWidth="3.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}
