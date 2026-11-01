import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { claimBirthdayReward, setBirthday } from '../lib/celebrations';
import { makeFamily, MemoryStorage } from '../lib/testFixtures';
import { BirthdayBanner, BirthdayCelebration, SeasonBanner } from '../components/celebrations/Banners';
import { CelebrationLayers } from '../components/celebrations/CelebrationLayers';
import { displayAttributes, viewFromPublicTheme } from './celebrationHost';
import { celebrationView, joinNames } from './celebration';
import { celebrate, pendingBirthdays, readShown, shownKey, writeShown } from './birthdayTap';

const family = () => {
  const data = makeFamily();
  return setBirthday(data, { childId: 'a', month: 10, day: 31, reward: { enabled: true, points: 50, gift: 'Cinema trip' } });
};

describe('celebration view', () => {
  it('shows the scheduled theme and today’s birthdays', () => {
    const v = celebrationView(family(), '2026-10-31', [{ childId: 'a', rewardEnabled: true, claimed: false }], null);
    expect(v.occurrence?.themeId).toBe('halloween');
    expect(v.birthdayChildren.map((c) => c.name)).toEqual(['Alex']);
    expect(displayAttributes({ view: v, surface: 'child' })).toEqual({
      'data-celebration': 'halloween',
      'data-celebration-tone': 'dark',
      'data-celebration-surface': 'child',
      'data-celebration-birthday': 'true',
    });
    expect(displayAttributes({ view: celebrationView(family(), '2026-06-01', [], null), surface: 'work' })).toEqual({});
  });

  it('hides birthdays when the birthday theme is off', () => {
    const data = family();
    data.celebrations.birthdaysEnabled = false;
    expect(celebrationView(data, '2026-10-31', [{ childId: 'a', rewardEnabled: true, claimed: false }], null).birthdayChildren).toEqual([]);
  });

  it('previews a theme without touching the saved schedule, even a switched-off one', () => {
    const data = family();
    data.celebrations.themes.christmas.enabled = false;
    const before = JSON.stringify(data.celebrations);
    const v = celebrationView(data, '2026-10-31', [], { kind: 'theme', themeId: 'christmas' });
    expect(v.occurrence).toMatchObject({ themeId: 'christmas', start: '2026-11-01', end: '2026-12-25' });
    expect(v.greeting?.headline).toBe('55 days to Christmas!');
    expect(JSON.stringify(data.celebrations)).toBe(before);
    // Ending the preview (null) shows the schedule again.
    expect(celebrationView(data, '2026-10-31', [], null).occurrence?.themeId).toBe('halloween');
  });

  it('previews one child’s birthday on top of the scheduled theme, without any reward', () => {
    const data = family();
    const v = celebrationView(data, '2026-06-01', [], { kind: 'birthday', childId: 'b' });
    expect(v.birthdayChildren.map((c) => c.id)).toEqual(['b']);
    expect(v.occurrence).toBeNull();
    expect(data.bonusAwards).toEqual([]);
  });

  it('joins names naturally', () => {
    expect(joinNames(['Maya'])).toBe('Maya');
    expect(joinNames(['Maya', 'Leo'])).toBe('Maya and Leo');
    expect(joinNames(['Maya', 'Leo', 'Ivy'])).toBe('Maya, Leo and Ivy');
  });
});

describe('first tap on a birthday', () => {
  it('waits for an unclaimed reward, or a celebration this screen has not shown', () => {
    const b = [
      { childId: 'a', rewardEnabled: true, claimed: false },
      { childId: 'b', rewardEnabled: false, claimed: false },
    ];
    expect(pendingBirthdays(b, [], true).map((x) => x.childId)).toEqual(['a', 'b']);
    expect(pendingBirthdays(b, ['a', 'b'], true).map((x) => x.childId)).toEqual(['a']); // reward still due
    expect(pendingBirthdays([{ ...b[0]!, claimed: true }, b[1]!], ['a', 'b'], true)).toEqual([]);
    expect(pendingBirthdays(b, [], false).map((x) => x.childId)).toEqual(['a']); // theme off: reward only
  });

  it('asks for the reward once per pending child and reports what was given', async () => {
    let data = family();
    const claim = vi.fn(async (childId: string) => {
      const r = claimBirthdayReward(data, childId, '2026-10-31', new Date('2026-10-31T08:00:00Z'));
      if (!r.ok) return { ok: false as const, error: r.error, kind: 'local' as const };
      data = r.data;
      return { ok: true as const, awarded: r.awarded, award: r.award };
    });
    const entries = await celebrate([{ childId: 'a', rewardEnabled: true, claimed: false }], data, '2026-10-31', claim);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(entries[0]).toMatchObject({ child: { id: 'a' }, award: { points: 50, note: 'Cinema trip' }, problem: null });
    // A second screen (or a reload) gets the same award back; nothing new is added.
    const again = await celebrate([{ childId: 'a', rewardEnabled: true, claimed: false }], data, '2026-10-31', claim);
    expect(again[0]!.award?.id).toBe(entries[0]!.award?.id);
    expect(data.bonusAwards).toHaveLength(1);
  });

  it('shows the moment but keeps the reward due when it fails', async () => {
    const claim = vi.fn(async () => ({ ok: false as const, error: 'Can’t reach the family server.', kind: 'unreachable' as const }));
    const entries = await celebrate([{ childId: 'a', rewardEnabled: true, claimed: false }], family(), '2026-10-31', claim);
    expect(entries[0]).toMatchObject({ award: null, problem: 'Can’t reach the family server.' });
  });

  it('remembers per screen and day which celebrations were shown, forgetting earlier days', () => {
    class ListedStorage extends MemoryStorage {
      get length() {
        return this.store.size;
      }
      key(i: number) {
        return [...this.store.keys()][i] ?? null;
      }
    }
    const storage = new ListedStorage();
    storage.setItem(shownKey('2026-10-30'), '["x"]');
    writeShown(storage, '2026-10-31', ['a', 'a']);
    expect(readShown(storage, '2026-10-31')).toEqual(['a']);
    expect(storage.getItem(shownKey('2026-10-30'))).toBeNull();
    expect(readShown(null, '2026-10-31')).toEqual([]);
  });
});

describe('celebration markup (static render)', () => {
  const data = family();
  const view = celebrationView(data, '2026-11-01', [{ childId: 'a', rewardEnabled: true, claimed: false }], null);

  it('draws the Christmas banner with its countdown and decorative layers', () => {
    const banner = renderToStaticMarkup(<SeasonBanner view={view} />);
    expect(banner).toContain('54 days to Christmas!');
    expect(banner).toContain('data-testid="christmas-countdown"');
    const layers = renderToStaticMarkup(<CelebrationLayers view={view} />);
    expect(layers).toContain('backdrop-christmas');
    // Snow: three tiled sheets (hundreds of flakes) plus a few big flakes.
    expect(layers.match(/class="snow-sheet snow-(far|mid|near)"/g)).toHaveLength(3);
    expect(layers.match(/class="snowflake[ "]/g)?.length).toBeLessThanOrEqual(10);
    // Fairy lights: a wire and bulbs that each have their own light.
    expect(layers.match(/class="bulb-light"/g)).toHaveLength(28);
    expect(layers.match(/class="floater-sway balloon-rise"/g)?.length).toBe(6); // birthday on top of Christmas
    // Decorations are hidden from screen readers.
    expect(layers).toMatch(/^<div class="celebration-layers" data-theme="christmas" aria-hidden="true">/);
  });

  it('greets the birthday child by name', () => {
    expect(renderToStaticMarkup(<BirthdayBanner children={[data.children[0]!]} />)).toContain('Happy Birthday, Alex!');
  });

  it('says plainly that a preview gives nothing', () => {
    const html = renderToStaticMarkup(
      <BirthdayCelebration entries={[{ child: data.children[0]!, award: null, problem: null }]} preview={{ enabled: true, points: 50, gift: 'Cinema trip' }} onClose={() => {}} />,
    );
    expect(html).toContain('Preview only: nothing was saved and no points were given.');
    expect(html).toContain('+50 bonus points');
  });

  it('renders nothing when there is nothing to celebrate', () => {
    const none = celebrationView(data, '2026-06-01', [], null);
    expect(renderToStaticMarkup(<CelebrationLayers view={none} />)).toBe('');
    expect(renderToStaticMarkup(<SeasonBanner view={none} />)).toBe('');
  });
});

describe('Halloween decorations', () => {
  it('has four glowing pumpkins and seven bats on different routes, in front of the app', () => {
    const html = renderToStaticMarkup(<CelebrationLayers view={celebrationView(family(), '2026-10-31', [], null)} />);
    expect(html.match(/data-testid="pumpkin"/g)).toHaveLength(4);
    expect(html.match(/class="pumpkin-glow"/g)).toHaveLength(4);
    expect(html.match(/class="pumpkin-core"/g)).toHaveLength(4);
    const routes = [...html.matchAll(/class="bat-flight bat-x-([a-z-]+)"/g)].map((m) => m[1]);
    expect(routes).toHaveLength(7);
    expect(new Set(routes).size).toBe(7);
    expect(new Set([...html.matchAll(/class="bat-lift bat-y-([a-z]+)"/g)].map((m) => m[1])).size).toBeGreaterThanOrEqual(5);
    const durations = [...html.matchAll(/class="bat-flight[^"]*" data-testid="bat" style="top:[^;]+;animation-duration:([\d.]+)s/g)].map((m) => m[1]);
    expect(new Set(durations).size).toBe(7);
    // Each bat: two wings that flap on their own, a body, and a depth (size and faintness).
    expect(html.match(/class="art bat-wing bat-wing-left"/g)).toHaveLength(7);
    expect(html.match(/class="art bat-wing bat-wing-right"/g)).toHaveLength(7);
    expect(html.match(/class="art bat-torso"/g)).toHaveLength(7);
    expect(new Set([...html.matchAll(/class="bat bat-(near|mid|far)"/g)].map((m) => m[1]))).toEqual(new Set(['near', 'mid', 'far']));
    // Bats fly in the foreground layer; the cobwebs and spiders stay in the frame.
    expect(foreground(html)).toContain('bat-flight');
    expect(html.indexOf('bat-flight')).toBeGreaterThan(html.indexOf('celebration-foreground'));
    expect(html).toContain('deco-web-left');
    expect(html).toContain('spider-crawl');
  });
});

/** The markup of the foreground layer (it is the last layer). */
function foreground(html: string): string {
  const at = html.indexOf('class="celebration-foreground"');
  expect(at).toBeGreaterThan(html.indexOf('class="celebration-frame'));
  return html.slice(at);
}
function backdrop(html: string): string {
  return html.slice(html.indexOf('class="celebration-backdrop'), html.indexOf('class="celebration-frame'));
}

describe('foreground celebration layer', () => {
  const layers = (date: string, birthdays = false) =>
    renderToStaticMarkup(
      <CelebrationLayers view={celebrationView(family(), date, birthdays ? [{ childId: 'a', rewardEnabled: true, claimed: false }] : [], null)} />,
    );

  it('puts Valentine’s hearts and roses in front, sparkles behind', () => {
    const html = layers('2026-02-14');
    expect(foreground(html).match(/class="floater-sway heart-rise"/g)).toHaveLength(10);
    expect(foreground(html).match(/class="floater-sway rose-rise"/g)).toHaveLength(4);
    expect(backdrop(html)).not.toContain('heart-rise');
    expect(backdrop(html)).toContain('sparkle-twinkle');
  });

  it('puts New Year fireworks and confetti in front', () => {
    const html = layers('2026-12-31');
    expect(foreground(html).match(/class="firework-slot firework-\d"/g)).toHaveLength(4);
    expect(foreground(html)).toContain('class="confetti"');
    expect(backdrop(html)).not.toContain('firework');
  });

  it('puts Christmas snow in its own layer over the content and under the flying pieces; Santa is planned, not drawn up front', () => {
    const html = layers('2026-12-10', true);
    // Order in the page: backdrop, frame, ambient (snow), foreground.
    const at = (cls: string) => html.indexOf(`class="${cls}`);
    expect(at('celebration-frame')).toBeLessThan(at('celebration-ambient'));
    expect(at('celebration-ambient')).toBeLessThan(at('celebration-foreground'));
    const ambient = html.slice(at('celebration-ambient'), at('celebration-foreground'));
    expect(ambient.match(/class="snow-sheet snow-(far|mid|near)"/g)).toHaveLength(3);
    // Falling snow is not behind the content any more (the static snowbank in the ground strip is).
    expect(backdrop(html)).not.toMatch(/snow-sheet|snowflake/);
    expect(backdrop(html)).toContain('snow-drift');
    expect(foreground(html)).not.toContain('snow-sheet');
    expect(html).not.toContain('santa-flyby');
    // Birthday balloons and confetti fly in front too.
    expect(foreground(html).match(/class="floater-sway balloon-rise"/g)).toHaveLength(6);
  });
});

describe('ambient layer only where there is snow', () => {
  it('is drawn for Christmas only (Halloween keeps its bats in front and nothing ambient)', () => {
    const halloween = renderToStaticMarkup(<CelebrationLayers view={celebrationView(family(), '2026-10-31', [], null)} />);
    expect(halloween).not.toContain('celebration-ambient');
    expect(halloween.match(/data-testid="bat"/g)).toHaveLength(7);
  });
});

describe('public theme (sign-in screens)', () => {
  it('turns the server’s answer into a view with no birthdays', () => {
    const v = viewFromPublicTheme({ today: '2026-11-01', occurrence: { themeId: 'christmas', holiday: '2026-12-25', start: '2026-11-01', end: '2026-12-25', custom: false } });
    expect(v.occurrence?.themeId).toBe('christmas');
    expect(v.greeting?.headline).toBe('54 days to Christmas!');
    expect(v.birthdayChildren).toEqual([]);
    expect(viewFromPublicTheme({ today: '2026-06-01', occurrence: null }).occurrence).toBeNull();
    expect(viewFromPublicTheme(null).occurrence).toBeNull();
  });
});

describe('motion and touch safety (stylesheet)', () => {
  const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles/celebrations.css'), 'utf8');

  it('switches every celebration animation off for prefers-reduced-motion', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const sel of ['.celebration-layers *', '.season-banner *', '.birthday-banner *', '.birthday-celebration *']) expect(block).toContain(sel);
    expect(block).toContain('animation: none !important');
  });

  it('stacks page background < seasonal background < content < snow < flying pieces < controls < preview bar < messages', () => {
    const z = (name: string) => Number(new RegExp(`--z-${name}:\\s*(-?\\d+);`).exec(css)?.[1]);
    const order = ['celebration-back', 'celebration-ambient', 'celebration-front', 'controls', 'preview-bar', 'toast'].map(z);
    for (const v of order) expect(Number.isFinite(v)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The back layers sit below the page content (negative), above the canvas background.
    expect(z('celebration-back')).toBeLessThan(-1);
    // .app must NOT become a stacking context, or every control is trapped under the decorations
    // and the work panel (z-index -1) drops behind the sky.
    const app = /:root\[data-celebration\] \.app \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(app).toContain('position: relative');
    expect(app).not.toContain('z-index');
    expect(css).toMatch(/\.celebration-ambient \{[^}]*z-index: var\(--z-celebration-ambient\)/);
    expect(css).toMatch(/\.celebration-foreground \{[^}]*z-index: var\(--z-celebration-front\)/);
    expect(css).toMatch(/\.celebration-backdrop \{[^}]*z-index: var\(--z-celebration-back\)/);
    // Controls are lifted with zero specificity, and the children's big tiles stay content.
    const lift = /:where\(:root\[data-celebration\] \.app :is\(([^)]*)\):not\(([^)]*)\)\) \{([^}]*)\}/.exec(css);
    expect(lift?.[1]).toContain('button');
    expect(lift?.[2]).toBe('.profile-card, .chore');
    expect(lift?.[3]).toContain('z-index: var(--z-controls)');
  });

  it('never lets decorations take taps, and animates only transform and opacity', () => {
    expect(css).toMatch(/\.celebration-layers \*\s*\{\s*pointer-events: none;/);
    const keyframes = css.match(/@keyframes [\s\S]*?\n\}/g) ?? [];
    expect(keyframes.length).toBeGreaterThan(10);
    for (const k of keyframes) {
      const props = [...k.matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
      for (const p of props) expect(['transform', 'opacity']).toContain(p);
      // CSS variables inside keyframes would keep the animation off the GPU.
      expect(k).not.toContain('var(');
    }
  });
});
