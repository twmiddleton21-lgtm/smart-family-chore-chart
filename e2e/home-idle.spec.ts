import { expect, test, type Page, type Route } from '@playwright/test';

// Return to the home screen after 2 minutes without input, on the shared
// family screen (browser-only build, sample family, portrait kiosk size).
// The page's clock is faked, so minutes pass in milliseconds. The kiosk's
// own display dimming is set up on the device and isn't part of the app, so
// it can't be tested here (see the report for the on-device check).
test.use({ baseURL: 'http://localhost:4177', viewport: { width: 1080, height: 1920 }, hasTouch: true });

const SECOND = 1_000;
const MINUTE = 60_000;
const home = (page: Page) => page.locator('main.dashboard');

async function start(page: Page) {
  await page.clock.install({ time: new Date('2026-10-28T10:00:00') });
  await page.goto('/');
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible({ timeout: 1500 }).catch(() => false)) await later.click();
  await expect(home(page)).toBeVisible();
}

async function openParentArea(page: Page) {
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await page.getByLabel('Enter the parent PIN').fill('1234');
  await page.getByLabel('Enter the parent PIN').press('Enter');
  await expect(page.getByRole('heading', { name: /Parent area/ })).toBeVisible();
}

/** Not home after 1:59 without input; home a second or two later. */
async function expectHomeAfterTwoMinutes(page: Page) {
  await page.clock.runFor(2 * MINUTE - SECOND);
  await expect(home(page)).toHaveCount(0);
  await page.clock.runFor(2 * SECOND);
  await expect(home(page)).toBeVisible();
}

test('a child’s chore chart and rewards page return home after 2 minutes without input', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: /Open Maya's chore chart/ }).click();
  await expect(page.getByRole('heading', { name: 'Maya’s chores' })).toBeVisible();
  await expectHomeAfterTwoMinutes(page);

  await page.getByRole('button', { name: /Open Maya's chore chart/ }).click();
  await page.getByRole('button', { name: /Rewards/ }).click();
  await expect(page.getByRole('heading', { name: 'Maya’s rewards' })).toBeVisible();
  await expectHomeAfterTwoMinutes(page);
  // Home, not the previous page: going back in needs a tap on a profile again.
  await expect(page.getByRole('button', { name: /Open Maya's chore chart/ })).toBeVisible();
});

test('taps reset the 2 minutes; scripted events and the passing of time don’t', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: /Open Maya's chore chart/ }).click();
  const heading = page.getByRole('heading', { name: 'Maya’s chores' });
  for (let i = 0; i < 4; i++) {
    await page.clock.runFor(90 * SECOND);
    await heading.click(); // genuine (trusted) input
  }
  await expect(heading).toBeVisible(); // 6 minutes of use
  await page.clock.runFor(90 * SECOND);
  await page.evaluate(() => {
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.dispatchEvent(new Event(type));
  });
  await page.clock.runFor(31 * SECOND);
  await expect(home(page)).toBeVisible();
});

test('the parent area locks and returns home; its tab and the PIN gate are reset', async ({ page }) => {
  await start(page);
  await openParentArea(page);
  await page.getByRole('tab', { name: /Rewards/ }).click();
  await expectHomeAfterTwoMinutes(page);
  // Locked: the PIN is needed again, and the parent area opens on its first tab.
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(page.getByLabel('Enter the parent PIN')).toBeVisible();
  // An untouched PIN gate on the home screen closes too.
  await page.clock.runFor(2 * MINUTE + SECOND);
  await expect(page.getByLabel('Enter the parent PIN')).toHaveCount(0);
  await openParentArea(page);
  await expect(page.getByRole('tab', { name: /Chores/ }).first()).toHaveAttribute('aria-selected', 'true');
});

test('typing in a chore editor holds the screen; an abandoned editor still goes home after 10 minutes', async ({ page }) => {
  await start(page);
  await openParentArea(page);
  await page.getByRole('button', { name: /Add chore/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a chore' });
  await dialog.getByLabel('Chore name').fill('Water the plants');
  await page.clock.runFor(5 * MINUTE);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Chore name')).toHaveValue('Water the plants');
  await page.clock.runFor(5 * MINUTE - 2 * SECOND);
  await expect(dialog).toBeVisible();
  await page.clock.runFor(3 * SECOND);
  await expect(home(page)).toBeVisible();
});

test('unsaved meal changes hold the screen; once saved, it goes home', async ({ page }) => {
  await start(page);
  await openParentArea(page);
  await page.getByRole('tab', { name: /School meals/ }).click();
  const first = page.locator('form.meal-week select').first();
  const other = await first.evaluate((el: HTMLSelectElement) => [...el.options].find((o) => o.value !== el.value)!.value);
  await first.selectOption(other);
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.clock.runFor(4 * MINUTE);
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save week' }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  await expectHomeAfterTwoMinutes(page);
});

test('parents can step back through 42 days of stored chore history', async ({ page }) => {
  await start(page);
  // Stored completions for Maya's "Make your bed": yesterday, 41 days ago
  // (the oldest day shown) and 42 days ago (outside the window).
  await page.evaluate(() => {
    const key = 'smart-family-chore-chart:data';
    const data = JSON.parse(localStorage.getItem(key)!);
    const maya = data.children[0].id;
    const bed = data.chores.find((c: { childId: string; title: string }) => c.childId === maya && c.title === 'Make your bed');
    data.completions = data.completions.filter((c: { choreId: string }) => c.choreId !== bed.id);
    for (const [i, date] of ['2026-10-27', '2026-09-17', '2026-09-16'].entries()) {
      data.completions.push({ id: `seed-${i}`, choreId: bed.id, childId: maya, date, points: 7, completedAt: `${date}T07:30:00.000Z` });
    }
    localStorage.setItem(key, JSON.stringify(data));
  });
  await page.reload();
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible({ timeout: 1500 }).catch(() => false)) await later.click();
  const countBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('smart-family-chore-chart:data')!).completions.length);
  await openParentArea(page);
  await page.getByRole('tab', { name: /Chore history/ }).click();

  const date = page.locator('.history-date-main');
  const maya = page.getByRole('region', { name: /^Maya's chores on/ });
  const bedRow = maya.locator('.history-row').filter({ hasText: 'Make your bed' });
  await expect(date).toHaveText('Today');
  await expect(page.getByRole('button', { name: 'Next day' })).toBeDisabled();
  await expect(bedRow).toContainText('To do');

  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(date).toHaveText('Yesterday');
  await expect(bedRow).toContainText('Done');
  await expect(bedRow).toContainText('7 points');

  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(date).not.toHaveText(/Today|Yesterday/);
  await expect(bedRow).toContainText('Not done');

  // The oldest week, then its first day in the window: Thursday 17 September.
  const weeks = page.getByRole('group', { name: 'Choose week' }).getByRole('button');
  await expect(weeks).toHaveCount(7);
  await weeks.first().click();
  const days = page.getByRole('group', { name: 'Choose a day this week' });
  await expect(days.getByRole('button', { name: /16/ })).toBeDisabled();
  await days.getByRole('button', { name: /17/ }).click();
  await expect(page.locator('.history-date-full, .history-date-main').first()).toContainText('17');
  await expect(bedRow).toContainText('Done');
  await expect(page.getByRole('button', { name: 'Previous day' })).toBeDisabled();

  // Filter by child: only Maya's chores, then everyone again.
  const filterGroup = page.getByRole('group', { name: 'Show history for' });
  await filterGroup.getByRole('button', { name: /Maya/ }).click();
  await expect(page.getByRole('region', { name: /chores on/ })).toHaveCount(1);
  await expect(maya).toBeVisible();
  await filterGroup.getByRole('button', { name: 'Everyone' }).click();
  await expect(page.getByRole('region', { name: /chores on/ })).toHaveCount(3);

  await page.getByRole('button', { name: 'Back to today' }).click();
  await expect(date).toHaveText('Today');
  // Browsing changed nothing: every completion, including the one outside the window, is kept.
  const countAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('smart-family-chore-chart:data')!).completions.length);
  expect(countAfter).toBe(countBefore);
});

test('the history date selector is rounded like the meal selectors and fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await openParentArea(page);
  await page.getByRole('tab', { name: /Chore history/ }).click();
  const radius = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).borderRadius);
  const dayChip = await radius('.history-day');
  const stepper = await radius('.history-step');
  await page.getByRole('tab', { name: /School meals/ }).click();
  const weekChip = await radius('.week-chip');
  expect(dayChip).toBe(weekChip);
  expect(stepper).toBe(weekChip);
  await page.getByRole('tab', { name: /Chore history/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test.describe('server build (development mode)', () => {
  test.use({ baseURL: 'http://localhost:4176' });

  test('the Family Calendar returns home; a save still on its way holds the screen', async ({ page }) => {
    await start(page);
    await page.getByRole('button', { name: /Family Calendar/ }).click();
    await expect(page.getByRole('heading', { name: 'Family Calendar' })).toBeVisible();
    await expectHomeAfterTwoMinutes(page);

    await page.getByRole('button', { name: /Parent area/ }).first().click();
    await page.getByRole('button', { name: 'Continue to parent area' }).click();
    await page.getByRole('tab', { name: /Settings/ }).click();
    // The server never answers this save (it is aborted at the end, so nothing changes).
    let held: Route | null = null;
    await page.route('**/api/commands', (route) => {
      held = route;
    });
    await page.getByLabel('Shown on the home screen').fill('Idle Test Family');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect.poll(() => held !== null).toBe(true);
    await page.clock.runFor(5 * MINUTE);
    await expect(page.getByRole('heading', { name: /Parent area/ })).toBeVisible();
    // Even a save that never ends doesn't keep the screen for good.
    await page.clock.runFor(5 * MINUTE);
    await expect(home(page)).toBeVisible();
    await (held as Route | null)?.abort();
  });
});
