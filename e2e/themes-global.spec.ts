import { expect, test, type Browser, type Page } from '@playwright/test';
import { AUTH_WEB_PORT, E2E_SETUP_CODE, LOCAL_WEB_PORT } from '../playwright.config';
import { THEME_IDS, type ThemeId } from '../src/types';
import { daysBetween, holidayDate } from '../src/lib/celebrations';

// Seasonal themes on EVERY screen, sign-in included, against the test server
// with sign-in on (and, at the end, the browser-only build with a fake clock).
// Today's date is whatever it is: the parent gives the nearest holiday's
// theme a one-day range covering today, and puts the settings back after.
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: `http://localhost:${AUTH_WEB_PORT}` });

const base = `http://localhost:${AUTH_WEB_PORT}`;
// Same test-only account as auth.spec.ts and signout.spec.ts.
const USERNAME = 'sam';
const PASSWORD = 'e2e correct horse battery';

const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** The theme whose holiday is nearest to today, and today's offset from it. */
function nearestTheme(today: string): { id: ThemeId; offset: number } {
  const year = Number(today.slice(0, 4));
  let best: { id: ThemeId; offset: number } | null = null;
  for (const id of THEME_IDS) {
    for (const y of [year - 1, year, year + 1]) {
      const offset = daysBetween(holidayDate(id, y), today);
      if (!best || Math.abs(offset) < Math.abs(best.offset)) best = { id, offset };
    }
  }
  return best!;
}

async function admin(browser: Browser) {
  const ctx = await browser.newContext({ baseURL: base });
  const status = await (await ctx.request.get('/api/auth/status')).json();
  if (status.setupRequired) {
    expect((await ctx.request.post('/api/auth/setup', { data: { setupCode: E2E_SETUP_CODE, username: USERNAME, displayName: 'Sam', password: PASSWORD } })).ok()).toBe(true);
  } else {
    expect((await ctx.request.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } })).ok()).toBe(true);
  }
  return ctx;
}

async function saveSettings(browser: Browser, change: (settings: Record<string, any>) => void) {
  const ctx = await admin(browser);
  const st = await (await ctx.request.get('/api/state')).json();
  const before = JSON.parse(JSON.stringify(st.family.celebrations));
  const settings = st.family.celebrations;
  change(settings);
  const r = await ctx.request.post('/api/commands', {
    data: { type: 'saveCelebrationSettings', payload: { settings }, expectedVersion: st.recordVersions['celebrations:household'] ?? 0 },
  });
  expect(r.ok(), await r.text()).toBe(true);
  await ctx.close();
  return before;
}

/** One decoration layer, the theme published on <html>, and it never takes a tap. */
async function expectThemed(page: Page, themeId: string, surface: 'child' | 'work') {
  await expect(page.locator('html')).toHaveAttribute('data-celebration', themeId);
  await expect(page.locator('html')).toHaveAttribute('data-celebration-surface', surface);
  await expect(page.locator('.celebration-layers')).toHaveCount(1);
  await expect(page.locator('.celebration-backdrop')).toHaveCount(1);
  expect(await page.locator('.celebration-layers').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
}

/** The control at the middle of this button is the button itself (nothing decorative on top). */
async function expectReachable(page: Page, name: RegExp | string) {
  const button = page.getByRole('button', { name }).first();
  await button.scrollIntoViewIfNeeded();
  expect(
    await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    }),
  ).toBe(true);
}

let saved: Record<string, unknown> | null = null;
let themeId: ThemeId;

test.beforeAll(async ({ browser }) => {
  const near = nearestTheme(londonToday());
  themeId = near.id;
  saved = await saveSettings(browser, (s) => {
    for (const id of THEME_IDS) s.themes[id].enabled = id === near.id;
    s.themes[near.id].custom = { startOffset: near.offset, endOffset: near.offset };
  });
});

test.afterAll(async ({ browser }) => {
  if (saved) await saveSettings(browser, (s) => Object.assign(s, saved));
});

test('the sign-in and pairing screen is decorated, with every control usable', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  await expectThemed(page, themeId, 'child');
  await expectReachable(page, 'Pair this device');
  await expectReachable(page, 'Parent sign in');
  // The flying pieces (foreground) are here too, take no taps, and step
  // aside while someone types the pairing code.
  await expect(page.locator('.celebration-foreground')).toHaveCount(1);
  const fg = () => page.locator('.celebration-foreground').evaluate((el) => getComputedStyle(el).opacity);
  expect(await fg()).toBe('1');
  await page.getByLabel('Pairing code').focus();
  await expect.poll(fg).toBe('0');
  await page.getByLabel('Pairing code').blur();
  await expect.poll(fg).toBe('1');
  // Only the theme is public: nothing about the family.
  const pub = await (await ctx.request.get('/api/celebrations/theme')).json();
  expect(pub.occurrence.themeId).toBe(themeId);
  expect(Object.keys(pub).sort()).toEqual(['occurrence', 'today']);
  await ctx.close();
});

test('the theme stays through the kiosk, parent sign-in, the whole parent area, the calendar and sign-out', async ({ browser }) => {
  const adminCtx = await admin(browser);
  const { code } = await (await adminCtx.request.post('/api/devices/pairing-codes', { data: { name: `Kiosk ${Date.now()}` } })).json();
  await adminCtx.close();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair this device' }).click();
  await expect(page.getByRole('button', { name: /Parent area/ }).first()).toBeVisible();
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible().catch(() => false)) await later.click();
  await expectThemed(page, themeId, 'child');

  await page.getByRole('button', { name: 'Family Calendar' }).click();
  await expectThemed(page, themeId, 'work');
  await expectReachable(page, /Back to chore chart/);
  await page.getByRole('button', { name: /Back to chore chart/ }).click();

  await page.getByRole('button', { name: /Parent area/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Parent sign in' });
  await expect(dialog).toBeVisible();
  await expectThemed(page, themeId, 'child');
  // Sign-in is a dialog: drawn above every decoration layer, controls usable.
  expect(await dialog.evaluate((el) => el.matches(':modal'))).toBe(true);
  await expectReachable(page, 'Sign in');
  await dialog.getByLabel('Username').fill(USERNAME);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Parent area/ })).toBeVisible();

  for (const tab of ['Chores', 'Chore history', 'Children', 'School meals', 'Rewards', 'Themes & Celebrations', 'Settings', 'Family access']) {
    await page.getByRole('tab', { name: tab }).click();
    await expectThemed(page, themeId, 'work');
  }
  await expectReachable(page, /lock & exit/);
  await page.getByRole('button', { name: /lock & exit/ }).click();
  await expect(page.getByText(/signed out/i).first()).toBeVisible();
  await expectThemed(page, themeId, 'child');
  await page.reload();
  await expectThemed(page, themeId, 'child');
  await ctx.close();
});

test('a paired kiosk shows birthday rewards by year only and never receives the day; a parent signed in on it sees everything', async ({ browser }) => {
  const today = londonToday();
  const year = Number(today.slice(0, 4));
  const [, month, day] = today.split('-').map(Number) as [number, number, number];
  const name = `Bday${Date.now().toString(36).slice(-5)}`;
  type Award = Record<string, unknown> & { childId: string };

  // A parent adds a child whose birthday is today, with a reward, and pairs a kiosk.
  const adminCtx = await admin(browser);
  const send = async (type: string, payload: object, expectedVersion?: number) => {
    const r = await adminCtx.request.post('/api/commands', { data: { type, payload, ...(expectedVersion === undefined ? {} : { expectedVersion }) } });
    expect(r.ok(), await r.text()).toBe(true);
  };
  await send('saveChild', { name, avatar: '🦄', color: 'pink' });
  const childId = (await (await adminCtx.request.get('/api/state')).json()).family.children.find((c: { name: string }) => c.name === name).id as string;
  try {
    await send('saveBirthday', { childId, month, day, rewardEnabled: true, points: 15, gift: 'Kite' }, 0);
    const { code } = await (await adminCtx.request.post('/api/devices/pairing-codes', { data: { name: `Kiosk ${Date.now()}` } })).json();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/');
    await page.getByLabel('Pairing code').fill(code);
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await expect(page.getByRole('button', { name: /Parent area/ }).first()).toBeVisible();
    const later = page.getByRole('button', { name: 'Remind me tomorrow' });
    if (await later.isVisible().catch(() => false)) await later.click();

    // The kiosk's first tap gives the reward, as before.
    await expect(page.getByTestId('birthday-banner')).toContainText(name);
    await page.mouse.click(20, 400);
    await expect(page.getByTestId('birthday-celebration')).toContainText('+15 bonus points');
    await page.getByRole('button', { name: /Thank you/ }).click();

    // What the kiosk's screens load: the award by year, without its day or time,
    // no birthday list and no birthday record versions.
    const loaded = page.waitForResponse((r) => r.url().endsWith('/api/state') && r.request().method() === 'GET');
    await page.reload();
    const kioskView = await (await loaded).json();
    const kioskAward = (kioskView.family.bonusAwards as Award[]).find((a) => a.childId === childId)!;
    expect(Object.keys(kioskAward).sort()).toEqual(['childId', 'id', 'kind', 'note', 'points', 'year']);
    expect(kioskAward).toMatchObject({ year, points: 15, note: 'Kite' });
    expect(kioskView.family.birthdays).toEqual([]);
    expect(Object.keys(kioskView.recordVersions).filter((k) => k.startsWith('birthday:'))).toEqual([]);

    // The child's Rewards screen: "Birthday bonus <year>", never the day.
    await page.getByRole('button', { name: new RegExp(`Open ${name}'s chore chart`) }).click();
    await page.getByRole('button', { name: /Rewards/ }).click();
    const gifts = page.locator('section[aria-labelledby="bonus-title"]');
    await expect(gifts).toContainText(`Birthday bonus ${year} · +15 points`);
    const shown = await gifts.innerText();
    const dayText = await page.evaluate(
      ([y, m, d]) => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(y!, m! - 1, d)),
      [year, month, day],
    );
    expect(shown).not.toContain(dayText);
    expect(shown).not.toContain(new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(year, month - 1, day)));

    // A parent signing in on the same kiosk gets the full records back.
    await page.goto('/');
    await page.getByRole('button', { name: /Parent area/ }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Parent sign in' });
    await dialog.getByLabel('Username').fill(USERNAME);
    await dialog.getByLabel('Password').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: /Parent area/ })).toBeVisible();
    const parentView = await (await ctx.request.get('/api/state')).json();
    expect((parentView.family.bonusAwards as Award[]).find((a) => a.childId === childId)).toMatchObject({ date: today, awardedAt: expect.any(String), year });
    expect(parentView.family.birthdays).toContainEqual(expect.objectContaining({ childId, month, day }));
    expect(parentView.recordVersions[`birthday:${childId}`]).toBeGreaterThan(0);
    await page.getByRole('tab', { name: 'Themes & Celebrations' }).click();
    await expect(page.getByTestId('theme-card-birthday')).toContainText(new RegExp(`${year} birthday reward given on .*\\+15 points and Kite`));
    await page.getByRole('tab', { name: 'Chore history' }).click();
    await expect(page.getByText('Birthday reward: Kite')).toBeVisible();

    // Signing out on the kiosk returns it to the device view.
    await page.getByRole('button', { name: /lock & exit/ }).click();
    await expect(page.getByText(/signed out/i).first()).toBeVisible();
    const after = await (await ctx.request.get('/api/state')).json();
    expect(Object.keys((after.family.bonusAwards as Award[]).find((a) => a.childId === childId)!)).not.toContain('date');
    expect(after.family.birthdays).toEqual([]);
    await ctx.close();
  } finally {
    // Tidy up: removing the child removes its birthday and reward.
    const st = await (await adminCtx.request.get('/api/state')).json();
    await send('deleteChild', { id: childId }, st.recordVersions[`child:${childId}`]);
    await adminCtx.close();
  }
});

test('a switched-off theme disappears from the sign-in screen too', async ({ browser }) => {
  await saveSettings(browser, (s) => {
    s.themes[themeId].enabled = false;
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-celebration', /.+/);
  await expect(page.locator('.celebration-layers')).toHaveCount(0);
  await ctx.close();
  await saveSettings(browser, (s) => {
    s.themes[themeId].enabled = true;
  });
});

test.describe('browser-only build in December (fake clock)', () => {
  test.use({ baseURL: `http://localhost:${LOCAL_WEB_PORT}`, reducedMotion: 'no-preference' });

  test('Christmas is scheduled; animations pause after 10 minutes without input and the 2-minute return home still works', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-12-10T10:00:00') });
    await page.goto('/');
    const later = page.getByRole('button', { name: 'Remind me tomorrow' });
    if (await later.isVisible().catch(() => false)) await later.click();
    await expectThemed(page, 'christmas', 'child');
    await expect(page.getByTestId('season-banner')).toContainText('15 days to Christmas!');

    // Santa flies while someone is using the screen: not at once, then within 15-40 s of it waking.
    const santa = page.getByTestId('santa-flyby');
    const waitForSanta = async (maxSeconds: number) => {
      for (let s = 0; s < maxSeconds && (await santa.count()) === 0; s++) await page.clock.runFor(1000);
    };
    await page.clock.runFor(14 * 1000);
    await expect(santa).toHaveCount(0);
    await waitForSanta(27);
    await expect(santa).toHaveCount(1);
    await expect(santa.getByTestId('reindeer')).toHaveCount(4);
    await page.locator('.santa-cross').evaluate((el) => el.getAnimations()[0]!.finish());
    await expect(santa).toHaveCount(0); // removed when it has crossed
    // Then nobody touches the kiosk (its display dims after 2 minutes): no fly-by over the dim
    // screen, even though the next one falls due (4-10 minutes after the last).
    await page.mouse.click(5, 5);
    await page.clock.runFor(9 * 60 * 1000 + 50 * 1000);
    await expect(santa).toHaveCount(0);
    await expect(page.locator('.celebration-layers')).not.toHaveClass(/celebration-paused/);
    // A child taps: Santa comes within 40 s, not after another long gap.
    await page.mouse.click(5, 5);
    await waitForSanta(41);
    await expect(santa).toHaveCount(1);
    await page.locator('.santa-cross').evaluate((el) => el.getAnimations()[0]!.finish());
    await expect(santa).toHaveCount(0);

    // Return home after 2 minutes is unchanged by the theme.
    await page.getByRole('button', { name: /Open Maya's chore chart/ }).click();
    await expect(page.getByRole('heading', { name: 'Maya’s chores' })).toBeVisible();
    await page.clock.runFor(2 * 60 * 1000 + 1500);
    await expect(page.getByRole('heading', { name: /Who’s doing chores/ })).toBeVisible();
    await expectThemed(page, 'christmas', 'child');

    // PIN entry is a dialog above every decoration, its keypad usable.
    await page.getByRole('button', { name: /Parent area/ }).first().click();
    const pin = page.getByRole('dialog', { name: 'Parent area' });
    await expect(pin).toBeVisible();
    expect(await pin.evaluate((el) => el.matches(':modal'))).toBe(true);
    await expectReachable(page, /^1$/);
    await expectReachable(page, 'Unlock');
    await pin.getByRole('button', { name: '1', exact: true }).click();
    await expect(pin.getByLabel('Enter the parent PIN')).toHaveValue('1');
    await page.keyboard.press('Escape');
    await expect(pin).toHaveCount(0);

    // 10 minutes after the last tap, decorations freeze and no fly-by is planned; the next tap starts them again.
    await expect(page.locator('.celebration-layers')).not.toHaveClass(/celebration-paused/);
    await page.clock.runFor(10 * 60 * 1000);
    await expect(page.locator('.celebration-layers')).toHaveClass(/celebration-paused/);
    expect(await page.locator('.snow-sheet').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('paused');
    await page.clock.runFor(30 * 60 * 1000);
    await expect(santa).toHaveCount(0);
    await page.mouse.click(5, 5);
    await expect(page.locator('.celebration-layers')).not.toHaveClass(/celebration-paused/);
    expect(await page.locator('.snow-sheet').first().evaluate((el) => getComputedStyle(el).animationPlayState)).toBe('running');
    // Waking the kiosk after the pause: Santa comes soon, so the child who tapped sees him.
    await page.clock.runFor(14 * 1000);
    await expect(santa).toHaveCount(0);
    await waitForSanta(27);
    await expect(santa).toHaveCount(1);
    await expect(page.locator('.celebration-foreground [data-testid="santa-flyby"]')).toHaveCount(1);
  });
});
