import { expect, test, type Page } from '@playwright/test';

// Seasonal themes and birthdays in a real browser, against the throwaway
// development server (household time zone Europe/London). Runs after
// shared-data.spec.ts, whose last import leaves two children (Alex and Bea,
// from e2e/fixtures/v030-browser-data.json). These
// checks don't depend on today's date: themes are switched off, previewed
// and switched back on, and the birthday is set to whatever today is.
test.describe.configure({ mode: 'serial' });

const API = 'http://127.0.0.1:3199';
const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function serverState(page: Page) {
  const r = await page.request.get(`${API}/api/state`);
  expect(r.ok()).toBe(true);
  return r.json();
}
async function alexPoints(page: Page): Promise<number> {
  const label = await page.getByRole('button', { name: /Open Alex's chore chart/ }).getAttribute('aria-label');
  return Number(/(\d+) points/.exec(label ?? '')![1]);
}
async function dismissMealReminder(page: Page) {
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible().catch(() => false)) await later.click();
}
async function openThemes(page: Page) {
  await page.goto('/');
  await dismissMealReminder(page);
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await page.getByRole('button', { name: 'Continue to parent area' }).click();
  await page.getByRole('tab', { name: /Themes & Celebrations/ }).click();
  await expect(page.getByRole('heading', { name: 'On the home screen today' })).toBeVisible();
}
async function setAllThemes(page: Page, on: boolean) {
  for (const name of ['New Year', 'Valentine’s Day', 'Easter', 'Halloween', 'Christmas']) {
    const toggle = page.getByRole('switch', { name: `Show the ${name} theme` });
    if ((await toggle.isChecked()) !== on) {
      await toggle.locator('..').click();
      await expect(toggle).toBeChecked({ checked: on });
    }
  }
}

test('Settings links to Themes & Celebrations, which lists every theme with its dates', async ({ page }) => {
  await page.goto('/');
  await dismissMealReminder(page);
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await page.getByRole('button', { name: 'Continue to parent area' }).click();
  await page.getByRole('tab', { name: /Settings/ }).click();
  await page.getByRole('button', { name: 'Open Themes & Celebrations' }).click();
  for (const id of ['newYear', 'valentines', 'easter', 'halloween', 'christmas', 'birthday']) {
    await expect(page.getByTestId(`theme-card-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('theme-card-christmas')).toContainText('1 November to Christmas Day');
});

test('a preview shows a theme on this screen only and leaves the saved schedule alone', async ({ page }) => {
  await openThemes(page);
  await setAllThemes(page, false);
  const saved = (await serverState(page)).family.celebrations;

  await page.getByTestId('theme-card-christmas').getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('preview-bar')).toContainText('the Christmas theme');
  await expect(page.getByTestId('season-banner')).toContainText(/Christmas/);
  await expect(page.locator('html')).toHaveAttribute('data-celebration', 'christmas');
  // Another device sees the real (empty) schedule.
  const other = await (await page.context().browser()!.newContext()).newPage();
  await other.goto('/');
  await expect(other.getByRole('heading', { name: /Who’s doing chores/ })).toBeVisible();
  await expect(other.getByTestId('season-banner')).toHaveCount(0);
  await other.close();

  await page.getByRole('button', { name: 'Back to scheduled theme' }).click();
  await expect(page.getByRole('heading', { name: 'On the home screen today' })).toBeVisible();
  expect((await serverState(page)).family.celebrations).toEqual(saved);
  await page.getByRole('button', { name: /lock & exit/ }).click();
  await expect(page.getByTestId('season-banner')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-celebration', /.+/);
});

test('custom dates are saved, shown and restored to the defaults', async ({ page }) => {
  await openThemes(page);
  const card = page.getByTestId('theme-card-valentines');
  await card.getByRole('button', { name: 'Change dates' }).click();
  const start = card.getByLabel('Start');
  const startValue = await start.inputValue(); // this year's Monday of the week
  const year = startValue.slice(0, 4);
  await start.fill(`${year}-02-10`);
  await card.getByLabel('End').fill(`${year}-02-15`);
  await card.getByRole('button', { name: 'Save dates' }).click();
  await expect(card).toContainText('Your own dates');
  expect((await serverState(page)).family.celebrations.themes.valentines.custom).toEqual({ startOffset: -4, endOffset: 1 });
  await card.getByRole('button', { name: 'Restore default dates' }).click();
  await expect(card).toContainText('Default:');
  expect((await serverState(page)).family.celebrations.themes.valentines.custom).toBeNull();
});

test('decorations respect reduced motion and never take a tap', async ({ page }) => {
  await openThemes(page);
  await page.getByTestId('theme-card-christmas').getByRole('button', { name: 'Preview' }).click();
  await expect(page.locator('.snowflake').first()).toBeAttached();

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await page.locator('.fall-column').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('fall');
  expect(await page.evaluate(() => document.getAnimations().length)).toBeGreaterThan(20);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.fall-column').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  // The still flakes are scattered down the screen, not parked above it.
  expect(await page.locator('.fall-column').evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().bottom > 0).length)).toBeGreaterThanOrEqual(6);
  for (const sel of ['.snow-sheet', '.bulb-light']) {
    expect(await page.locator(sel).first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  }
  // Still lights: most bulbs show lit.
  expect(Number(await page.locator('.fairy-bulb:nth-child(3) .bulb-light').evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0.8);
  expect(
    await page.evaluate(() =>
      document
        .getAnimations()
        // Animations only: the app's own reduced-motion rule shortens
        // transitions to 0.001ms (base.css), which may be caught mid-flight.
        .filter((a) => a instanceof CSSAnimation && a.playState === 'running')
        .map((a) => `${(a as CSSAnimation).animationName}@${((a.effect as KeyframeEffect).target as Element).className}`),
    ),
  ).toEqual([]);
  // Still decorated, just still; and Santa doesn't fly with reduced motion.
  await expect(page.getByTestId('season-banner')).toBeVisible();
  await page.waitForTimeout(4500);
  await expect(page.getByTestId('santa-flyby')).toHaveCount(0);

  // The topmost element at the middle of Alex's card is the card itself.
  const card = page.getByRole('button', { name: /Open Alex's chore chart/ });
  await card.scrollIntoViewIfNeeded();
  const hit = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el.contains(top);
  });
  expect(hit).toBe(true);
  expect(await page.locator('.celebration-layers').first().evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  await card.click();
  await expect(page.getByRole('heading', { name: 'Alex’s chores' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to scheduled theme' }).click();
  await setAllThemes(page, true);
});

/** Running animations on elements matching `selector`, by animation name. */
async function running(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(
    (sel) =>
      document
        .getAnimations()
        .filter((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target;
          return a.playState === 'running' && target instanceof Element && target.matches(sel);
        })
        .map((a) => (a as CSSAnimation).animationName),
    selector,
  );
}
/** Whether a computed style changes within a few seconds. */
async function changesOverTime(page: Page, selector: string, prop: 'transform' | 'opacity', index = 0): Promise<boolean> {
  const read = () => page.locator(selector).nth(index).evaluate((el, p) => getComputedStyle(el)[p as 'transform'], prop);
  const first = await read();
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(250);
    if ((await read()) !== first) return true;
  }
  return false;
}
async function reachable(page: Page, name: RegExp | string): Promise<boolean> {
  const button = page.getByRole('button', { name }).first();
  await button.scrollIntoViewIfNeeded();
  return button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
}

test('Halloween: glowing, flickering pumpkins and bats with flapping wings on different routes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openThemes(page);
  await page.getByTestId('theme-card-halloween').getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('pumpkin')).toHaveCount(4);
  expect(await running(page, '.pumpkin-glow')).toEqual(Array(4).fill('glow-breathe'));
  expect(await running(page, '.pumpkin-core')).toEqual(Array(4).fill('candle'));
  expect(await changesOverTime(page, '.pumpkin-core', 'opacity')).toBe(true);
  // A visible warm glow: a large orange halo around each pumpkin.
  const halo = await page.locator('.pumpkin-glow').first().evaluate((el) => ({
    bg: getComputedStyle(el).backgroundImage,
    w: el.getBoundingClientRect().width,
    pw: el.parentElement!.getBoundingClientRect().width,
  }));
  expect(halo.bg).toMatch(/radial-gradient\(.*rgba\(255, 168, 52/);
  expect(halo.w).toBeGreaterThan(halo.pw * 1.8);

  await expect(page.getByTestId('bat')).toHaveCount(7);
  const routes = await running(page, '.bat-flight');
  expect(routes).toHaveLength(7);
  expect(new Set(routes).size).toBe(7); // seven different routes
  expect(new Set(await running(page, '.bat-lift')).size).toBeGreaterThanOrEqual(5); // and rises and falls
  // Different speeds and wingbeats.
  const timing = await page.locator('.bat-flight').evaluateAll((els) => els.map((el) => getComputedStyle(el).animationDuration));
  expect(new Set(timing).size).toBe(7);
  expect(new Set(await page.locator('.bat-wing-left').evaluateAll((els) => els.map((el) => getComputedStyle(el).animationDuration)))).toHaveProperty('size', 7);
  // Both directions: some bats move right, some left, over the same moment.
  const xs = () => page.locator('.bat-flight').evaluateAll((els) => els.map((el) => new DOMMatrix(getComputedStyle(el).transform).m41));
  const x0 = await xs();
  await page.waitForTimeout(600);
  const x1 = await xs();
  const moves = x1.map((x, i) => Math.sign(Math.round(x - x0[i]!)));
  expect(moves).toContain(1);
  expect(moves).toContain(-1);
  // Each wing flaps on its own (a real wingbeat, not the whole bat squashing).
  expect(await running(page, '.bat-wing-left')).toEqual(Array(7).fill('wing-left'));
  expect(await running(page, '.bat-wing-right')).toEqual(Array(7).fill('wing-right'));
  expect(await running(page, '.bat-bob')).toEqual(Array(7).fill('bat-bob'));
  const angles = await page.locator('.bat-wing-left').nth(0).evaluate(async (el) => {
    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) {
      const m = new DOMMatrix(getComputedStyle(el).transform);
      seen.add(Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI / 5) * 5);
      await new Promise((r) => setTimeout(r, 45));
    }
    return [...seen];
  });
  expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThanOrEqual(25);
  // In the foreground layer, in front of the app; cobwebs and spiders kept behind.
  await expect(page.locator('.celebration-foreground [data-testid="bat"]')).toHaveCount(7);
  await expect(page.locator('.celebration-backdrop [data-testid="bat"]')).toHaveCount(0);
  expect(await page.locator('.celebration-backdrop').evaluate((el) => getComputedStyle(el).zIndex)).toBe('-2');
  await expect(page.locator('.celebration-ambient')).toHaveCount(0); // no snow at Halloween
  await expect(page.locator('.deco-web')).toHaveCount(2);
  expect(await running(page, '.spider-crawl')).toEqual(['spider-crawl']);
  expect(await reachable(page, /Open Alex's chore chart/)).toBe(true);
  await page.getByRole('button', { name: 'Back to scheduled theme' }).click();
});

test('Christmas: fairy lights glow in turn and snow keeps falling', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openThemes(page);
  await page.getByTestId('theme-card-christmas').getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('fairy-lights')).toBeVisible();
  await expect(page.locator('.fairy-wire path')).toHaveCount(1);
  expect(await running(page, '.bulb-light')).toEqual(Array(28).fill('bulb-glow'));
  // Bulbs are at different points of the glow at any moment: a chase, not a flash.
  const opacities = await page.locator('.bulb-light').evaluateAll((els) => els.slice(0, 7).map((el) => Number(getComputedStyle(el).opacity).toFixed(2)));
  expect(new Set(opacities).size).toBeGreaterThan(3);
  expect(await changesOverTime(page, '.bulb-light', 'opacity', 2)).toBe(true);

  expect((await running(page, '.snow-sheet')).sort()).toEqual(['snow-far', 'snow-mid', 'snow-near']);
  expect(await changesOverTime(page, '.snow-sheet', 'transform', 2)).toBe(true);

  // Snow falls in front of the page content (its own layer), not behind the cards.
  await expect(page.locator('.celebration-ambient .snow-sheet')).toHaveCount(3);
  await expect(page.locator('.celebration-backdrop .snow-sheet')).toHaveCount(0);
  expect(await page.locator('.celebration-ambient').evaluate((el) => getComputedStyle(el).zIndex)).toBe('10');
  expect(await inRootStackingOrder(page, '.celebration-ambient')).toEqual([]);
  const viewport = page.viewportSize()!;
  expect(await page.locator('.celebration-ambient').boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  // Painted over a child's profile card (content)...
  await page.getByRole('button', { name: /Open Alex's chore chart/ }).scrollIntoViewIfNeeded();
  expect(await topAt(page, '.celebration-ambient', '.profile-card')).toBe('layer');
  // ...but under the controls: the preview bar's button and the Parent area button stay on top.
  expect(await topAt(page, '.celebration-ambient', '.preview-bar button')).toBe('target');
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await topAt(page, '.celebration-ambient', '.topbar .button')).toBe('target');
  // And it never takes a tap or a scroll.
  expect(
    await page.locator('.celebration-ambient, .celebration-ambient *').evaluateAll((els) => els.filter((el) => getComputedStyle(el).pointerEvents !== 'none').length),
  ).toBe(0);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.mouse.wheel(0, -2000);
  await expect(page.locator('.deco-corner')).toHaveCount(2); // holly
  await expect(page.getByTestId('christmas-countdown')).toBeVisible();
  expect(await reachable(page, /Open Alex's chore chart/)).toBe(true);
  await page.getByRole('button', { name: 'Back to scheduled theme' }).click();
});

test('Christmas: Santa and his reindeer fly across now and then, and are gone in between', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openThemes(page);
  await page.getByTestId('theme-card-christmas').getByRole('button', { name: 'Preview' }).click();
  // A preview shows the first fly-by within a few seconds.
  const santa = page.getByTestId('santa-flyby');
  await expect(santa).toHaveCount(1, { timeout: 6000 });
  await expect(page.locator('.celebration-foreground [data-testid="santa-flyby"]')).toHaveCount(1);
  await expect(page.locator('.santa-sleigh')).toBeVisible();
  await expect(santa.getByTestId('reindeer')).toHaveCount(4);
  expect(await santa.getAttribute('data-direction')).toMatch(/^(ltr|rtl)$/);
  expect(await santa.getAttribute('data-path')).toMatch(/^(up|down|level)-(dip|hump|none)$/);
  // The reindeer gallop (legs) and bob, each at its own point; a sparkle trail and glow.
  expect(await running(page, '.legs-front')).toEqual(Array(4).fill('legs-front'));
  expect(await running(page, '.legs-back')).toEqual(Array(4).fill('legs-back'));
  expect(await running(page, '.reindeer')).toEqual(Array(4).fill('reindeer-bob'));
  expect(await changesOverTime(page, '.legs-front', 'transform')).toBe(true);
  expect((await running(page, '.santa-spark')).length).toBeGreaterThanOrEqual(5);
  expect(await running(page, '.sleigh-glow')).toEqual(['sleigh-glow']);
  // The crossing moves on.
  const cross = await running(page, '.santa-cross');
  expect(cross).toHaveLength(1);
  expect(cross[0]).toMatch(/^santa-cross-(up|down|level)$/);
  const progress = () =>
    page.locator('.santa-cross').evaluate((el) => {
      const a = el.getAnimations()[0]!;
      return Number(a.currentTime) / Number(a.effect!.getTiming().duration);
    });
  const p0 = await progress();
  await page.waitForTimeout(700);
  expect(await progress()).toBeGreaterThan(p0);
  // Mid-crossing, the complete group (sleigh with Santa and his sack, four reindeer,
  // Rudolph's glowing nose) is on screen, drawn in front of the page content.
  const seek = (at: number | null) =>
    page.locator('.santa-cross, .santa-arc').evaluateAll(
      (els, t) =>
        els.forEach((el) =>
          el.getAnimations().forEach((a) => {
            if (t === null) a.play();
            else {
              a.pause();
              a.currentTime = Number(a.effect!.getTiming().duration) * t;
            }
          }),
        ),
      at,
    );
  await seek(0.5);
  const vp = page.viewportSize()!;
  for (const sel of ['.santa-sleigh', '.reindeer', '.rudolph-glow']) {
    for (const b of await page.locator(sel).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect))) {
      expect(b.width, sel).toBeGreaterThan(10);
      expect(b.left, sel).toBeGreaterThanOrEqual(-1);
      expect(b.right, sel).toBeLessThanOrEqual(vp.width + 1);
      expect(b.top, sel).toBeGreaterThanOrEqual(0);
      expect(b.bottom, sel).toBeLessThanOrEqual(vp.height);
    }
  }
  await expect(page.locator('.rudolph-glow')).toHaveCount(1);
  expect(await page.locator('.santa-sleigh').evaluate((el) => el.querySelectorAll('path, rect, circle, ellipse').length)).toBeGreaterThan(10);
  for (const sel of ['.celebration-foreground', '.santa-flyby', '.santa-sleigh']) {
    expect(await page.locator(sel).first().evaluate((el) => getComputedStyle(el).visibility), sel).toBe('visible');
  }
  expect(await page.locator('.celebration-foreground').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  expect(await inRootStackingOrder(page, '.celebration-foreground')).toEqual([]);
  // Nothing on the page is painted over the middle reindeer.
  expect(await topAt(page, '.celebration-foreground', '.reindeer', 1)).toBe('target');
  await seek(null);
  // Reaching the far side ends the fly-by: it's removed from the page.
  await page.locator('.santa-cross').evaluate((el) => el.getAnimations()[0]!.finish());
  await expect(santa).toHaveCount(0);
  // Occasional: nothing more for a good while (even a preview waits 25 s or more).
  await page.waitForTimeout(3000);
  await expect(santa).toHaveCount(0);
  expect(await page.locator('.celebration-foreground').evaluate((el) => el.childElementCount)).toBe(0);
  await page.getByRole('button', { name: 'Back to scheduled theme' }).click();
});

/**
 * What is painted on top at the middle of the `nth` element matching
 * `target`, if the decoration layer `layer` took pointer events (it never
 * does: this only asks the browser for the paint order, then puts
 * everything back). Returns 'layer', 'target', or the class of whatever
 * else is on top.
 */
async function topAt(page: Page, layer: string, target: string, nth = 0): Promise<string> {
  return page.evaluate(
    ([layerSel, targetSel, i]) => {
      const el = document.querySelectorAll(targetSel)[Number(i)] as HTMLElement;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const style = document.createElement('style');
      style.textContent = `${layerSel}, ${layerSel} * { pointer-events: auto !important; }`;
      document.head.append(style);
      const hit = document.elementFromPoint(x, y);
      style.remove();
      if (!hit) return 'nothing';
      if (el.contains(hit)) return 'target';
      if (hit.closest(layerSel)) return 'layer';
      return String(hit.className);
    },
    [layer, target, String(nth)],
  );
}

/** Every ancestor up to <html> leaves the element in the page's main stacking order, unclipped. */
async function inRootStackingOrder(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const problems: string[] = [];
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const name = `${a.tagName.toLowerCase()}.${a.className}`;
      if (cs.transform !== 'none' || cs.filter !== 'none' || cs.opacity !== '1' || cs.isolation !== 'auto' || cs.contain !== 'none') problems.push(`${name} groups`);
      if (cs.position !== 'static' && cs.zIndex !== 'auto') problems.push(`${name} z-index ${cs.zIndex}`);
      if (cs.overflow !== 'visible') problems.push(`${name} clips`);
    }
    return problems;
  });
}

test('flying pieces are a foreground layer: in front of the app, behind the preview bar, messages and dialogs, and never in the way', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openThemes(page);
  await page.getByTestId('theme-card-valentines').getByRole('button', { name: 'Preview' }).click();
  // Valentine's: hearts and roses float up in front.
  await expect(page.locator('.celebration-foreground .heart-rise')).toHaveCount(10);
  await expect(page.locator('.celebration-foreground .rose-rise')).toHaveCount(4);
  expect((await running(page, '.celebration-foreground .rise-column')).length).toBe(14);

  // The stacking order, all in the page's main order: seasonal background -2 < content (.app has no z-index of
  // its own, so it isn't a stacking context) < snow 10 < flying pieces 20 < controls 30 < preview bar 40 < messages 50.
  const zOf = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).zIndex);
  const z = async (sel: string) => Number(await zOf(sel));
  expect(await z('.celebration-backdrop')).toBe(-2);
  expect(await z('.celebration-frame')).toBe(-2);
  expect(await zOf('.app')).toBe('auto');
  expect(await z('.celebration-foreground')).toBe(20);
  expect(await z('.topbar .button')).toBe(30);
  expect(await zOf('.profile-card')).toBe('auto'); // the children's tiles are content
  expect(await z('.preview-bar')).toBe(40);
  expect(await z('.toast-region')).toBe(50);
  for (const sel of ['.celebration-foreground', '.app', '.topbar .button', '.preview-bar', '.toast-region']) {
    expect(await inRootStackingOrder(page, sel), sel).toEqual([]);
  }
  // Paint order at real points: a heart over a profile card, the Parent area button over the hearts.
  expect(await topAt(page, '.celebration-foreground', '.topbar .button')).toBe('target');
  // Covers the whole screen, clipped only by its edges.
  const box = await page.locator('.celebration-foreground').boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: page.viewportSize()!.width, height: page.viewportSize()!.height });

  // Never takes a tap, swipe or scroll: nothing in it accepts pointer events...
  expect(
    await page.locator('.celebration-foreground, .celebration-foreground *').evaluateAll((els) => els.filter((el) => getComputedStyle(el).pointerEvents !== 'none').length),
  ).toBe(0);
  // ...so the controls under a floating heart are the ones that get the tap.
  const underHearts = await page.locator('.celebration-foreground .heart-rise').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit ? Boolean(hit.closest('.celebration-layers')) : false;
    }),
  );
  expect(underHearts.every((onDecoration) => !onDecoration)).toBe(true);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.mouse.wheel(0, -2000);
  expect(await reachable(page, /Open Alex's chore chart/)).toBe(true);

  // New Year: fireworks and confetti in front too.
  await page.getByRole('button', { name: 'Back to scheduled theme' }).click();
  await page.getByTestId('theme-card-newYear').getByRole('button', { name: 'Preview' }).click();
  await expect(page.locator('.celebration-foreground .firework')).toHaveCount(4);
  expect(await running(page, '.celebration-foreground .firework')).toEqual(Array(4).fill('burst'));
  expect((await running(page, '.celebration-foreground .confetti')).length).toBe(18);
  await expect(page.locator('.celebration-backdrop .firework')).toHaveCount(0);

  // Dialogs are drawn above everything (the browser's top layer) and work normally.
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Parent area (development mode)' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.matches(':modal'))).toBe(true);
  expect(await reachable(page, 'Continue to parent area')).toBe(true);
  await dialog.getByRole('button', { name: 'Continue to parent area' }).click();
  await page.getByRole('tab', { name: /Themes & Celebrations/ }).click();
  // Fainter over work screens, so text stays easy to read.
  expect(await page.locator('.firework-slot').first().evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.7);
  // Typing in a field: the flying pieces step aside, and come back after.
  const card = page.getByTestId('theme-card-newYear');
  await card.getByRole('button', { name: 'Change dates' }).click();
  const field = card.getByLabel('Start');
  await field.focus();
  await expect.poll(() => page.locator('.celebration-foreground').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => page.locator('.celebration-foreground').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await page.getByRole('button', { name: 'Back to scheduled theme' }).click();
});

test('a preview stays on every screen while navigating, with one decoration layer', async ({ page }) => {
  await openThemes(page);
  await page.getByTestId('theme-card-christmas').getByRole('button', { name: 'Preview' }).click();
  const check = async (surface: string) => {
    await expect(page.locator('html')).toHaveAttribute('data-celebration', 'christmas');
    await expect(page.locator('html')).toHaveAttribute('data-celebration-surface', surface);
    await expect(page.locator('.celebration-layers')).toHaveCount(1);
  };
  await check('child');
  await page.getByRole('button', { name: /Open Alex's chore chart/ }).click();
  await check('child');
  await page.getByRole('button', { name: /Rewards/ }).click();
  await check('child');
  await page.getByRole('button', { name: /Back to chores/ }).click();
  await page.getByRole('button', { name: /All profiles/ }).click();
  await page.getByRole('button', { name: 'Family Calendar' }).click();
  await check('work');
  await page.getByRole('button', { name: /Back to chore chart/ }).click();
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Parent area (development mode)' })).toBeVisible();
  await check('child');
  await page.getByRole('button', { name: 'Continue to parent area' }).click();
  for (const tab of ['Chores', 'Chore history', 'Children', 'Rewards', 'Themes & Celebrations', 'Settings']) {
    await page.getByRole('tab', { name: tab }).click();
    await check('work');
  }
  expect(await reachable(page, /lock & exit/)).toBe(true);
  // The preview bar floats at the bottom, leaving the garland at the top visible.
  const bar = await page.getByTestId('preview-bar').boundingBox();
  expect(bar!.y).toBeGreaterThan((page.viewportSize()?.height ?? 720) / 2);
  // Ending the preview inside the parent area stays on the same tab.
  await page.getByRole('button', { name: 'Back to scheduled theme' }).click();
  await expect(page.getByTestId('preview-bar')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('html')).not.toHaveAttribute('data-celebration-preview', /.+/);
});

test('a birthday preview celebrates without giving anything', async ({ page }) => {
  await openThemes(page);
  const before = await serverState(page);
  await page.getByRole('button', { name: 'Set up Bea’s birthday' }).click();
  await page.getByLabel('Month').selectOption({ index: 3 });
  await page.getByLabel('Day', { exact: true }).selectOption('7');
  await page.getByLabel('Bonus points').fill('30');
  await page.getByRole('button', { name: 'Preview celebration' }).click();
  const dialog = page.getByTestId('birthday-celebration');
  await expect(dialog).toContainText('Preview only: nothing was saved and no points were given.');
  await expect(dialog).toContainText('+30 bonus points');
  await page.getByRole('button', { name: /Thank you/ }).click();
  await expect(page.getByTestId('birthday-banner')).toContainText('Happy Birthday, Bea!');
  const after = await serverState(page);
  expect(after.family.bonusAwards).toEqual(before.family.bonusAwards);
  expect(after.family.birthdays).toEqual(before.family.birthdays); // the unsaved form saved nothing
  await page.getByRole('button', { name: 'Back to scheduled theme' }).click();
  await expect(page.getByTestId('birthday-banner')).toHaveCount(0);
});

test('on a child’s birthday the first tap gives the reward exactly once, on every device', async ({ page, browser }) => {
  const today = londonToday();
  const [, month, day] = today.split('-').map(Number) as [number, number, number];
  await openThemes(page);
  await page.getByRole('button', { name: 'Set up Alex’s birthday' }).click();
  await page.getByLabel('Month').selectOption(String(month));
  await page.getByLabel('Day', { exact: true }).selectOption(String(day));
  await page.getByLabel('Bonus points').fill('25');
  await page.getByLabel('Gift or treat (optional)').fill('Pizza night');
  await page.getByRole('button', { name: 'Save birthday' }).click();
  await expect(page.getByTestId('theme-card-birthday')).toContainText('Today is Alex’s birthday!');
  await page.getByRole('button', { name: /lock & exit/ }).click();

  // Two kiosks (separate browsers) open the home screen.
  const kioskA = await (await browser.newContext()).newPage();
  const kioskB = await (await browser.newContext()).newPage();
  for (const k of [kioskA, kioskB]) {
    await k.goto('/');
    await expect(k.getByTestId('birthday-banner')).toContainText('Happy Birthday, Alex!');
  }
  const points = await alexPoints(kioskA);
  expect((await serverState(kioskA)).birthdaysToday).toEqual([expect.objectContaining({ claimed: false })]);

  // Both are tapped at the same moment.
  await Promise.all([kioskA.mouse.click(20, 400), kioskB.mouse.click(20, 400)]);
  for (const k of [kioskA, kioskB]) {
    const dialog = k.getByTestId('birthday-celebration');
    await expect(dialog).toContainText('Your birthday gift: Pizza night');
    await expect(dialog).toContainText('+25 bonus points');
    await k.getByRole('button', { name: /Thank you/ }).click();
  }
  const s = await serverState(kioskA);
  expect(s.family.bonusAwards.filter((a: { year: number }) => a.year === Number(today.slice(0, 4)))).toHaveLength(1);
  await expect.poll(() => alexPoints(kioskA)).toBe(points + 25);

  // Reloads, profile switches and more taps add nothing.
  await kioskA.reload();
  await expect(kioskA.getByTestId('birthday-banner')).toBeVisible();
  await kioskA.mouse.click(20, 400);
  await kioskA.getByRole('button', { name: /Open Bea's chore chart/ }).click();
  await kioskA.getByRole('button', { name: /All profiles/ }).click();
  await kioskA.getByRole('button', { name: /Open Alex's chore chart/ }).click();
  await expect(kioskA.getByTestId('birthday-banner')).toContainText('Happy Birthday, Alex!');
  await kioskA.getByRole('button', { name: /Rewards/ }).click();
  await expect(kioskA.getByRole('heading', { name: 'Birthday gifts' })).toBeVisible();
  await expect(kioskA.getByText('Pizza night')).toBeVisible();
  await expect(kioskA.getByTestId('birthday-celebration')).toHaveCount(0);
  expect((await serverState(kioskA)).family.bonusAwards).toHaveLength(1);

  // Parents can see it was given, in the birthday settings and the chore
  // history. This screen hasn't celebrated yet, so its first tap does (and
  // still gives nothing more).
  await page.goto('/');
  await expect(page.getByTestId('birthday-banner')).toBeVisible();
  await page.mouse.click(20, 400);
  await expect(page.getByTestId('birthday-celebration')).toContainText('+25 bonus points');
  await page.getByRole('button', { name: /Thank you/ }).click();
  expect((await serverState(page)).family.bonusAwards).toHaveLength(1);
  await openThemes(page);
  await expect(page.getByTestId('theme-card-birthday')).toContainText(/birthday reward given on .*\+25 points and Pizza night/);
  await page.getByRole('tab', { name: /Chore history/ }).click();
  await expect(page.getByText('Birthday reward: Pizza night')).toBeVisible();

  // Tidy up for any later runs: remove the birthday (the reward stays).
  await page.getByRole('tab', { name: /Children/ }).click();
  await page.getByRole('button', { name: 'Alex’s birthday' }).click();
  await page.getByRole('button', { name: 'Remove birthday' }).click();
  await expect(page.getByText(/Removed Alex’s birthday/)).toBeVisible();
  await kioskA.close();
  await kioskB.close();
});
