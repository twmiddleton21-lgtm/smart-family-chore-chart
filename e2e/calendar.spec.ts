import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { E2E_CALENDAR_FIXTURE } from '../playwright.config';

// Family calendar page in the server build (development server). Events come
// from a local fixture file in Google's events.list shape: no Google account,
// credentials or network access are involved.
test.use({ viewport: { width: 1080, height: 1920 } });

const londonDay = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};

const LONG = 'Grandma and Grandad’s anniversary lunch at the riverside garden centre café';

const openCalendar = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible().catch(() => false)) await later.click();
  await page.getByRole('button', { name: 'Family Calendar' }).click();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
};

test('the Family Calendar button opens a month view with events in their days, which moves between months and goes back', async ({ page }) => {
  const today = londonDay(0);
  const tomorrow = londonDay(1);
  writeFileSync(
    E2E_CALENDAR_FIXTURE!,
    JSON.stringify({
      summary: 'E2E Test Family',
      items: [
        { id: 'a', summary: 'Football training', location: 'Park pitches', start: { dateTime: `${today}T12:00:00Z` }, end: { dateTime: `${today}T13:00:00Z` } },
        { id: 'b', summary: LONG, start: { date: tomorrow }, end: { date: londonDay(2) } },
        { id: 'c', summary: 'Cancelled thing', status: 'cancelled', start: { date: tomorrow } },
      ],
    }),
  );
  await openCalendar(page);

  await expect(page.getByRole('heading', { name: 'Family Calendar' })).toBeVisible();
  await expect(page.getByText('E2E Test Family')).toBeVisible();
  await expect(page.getByText('read-only from Google Calendar')).toBeVisible();
  const monthTitle = page.locator('.calendar-month-title');
  const thisMonth = await monthTitle.textContent();
  // A Sunday-to-Saturday grid of whole weeks, today marked.
  const grid = page.getByRole('table');
  await expect(grid.getByRole('columnheader')).toHaveCount(7);
  const cells = await grid.getByRole('cell').count();
  expect(cells % 7).toBe(0);
  expect(cells).toBeGreaterThanOrEqual(28);
  const todayCell = grid.getByRole('cell').filter({ has: page.locator('[aria-current="date"]') });
  await expect(todayCell).toHaveCount(1);
  // Today's event sits in today's cell, with its start time.
  await expect(todayCell.locator('.month-event')).toContainText('Football training');
  await expect(todayCell.locator('.month-event-time')).toBeVisible();
  await expect(page.getByText('Cancelled thing')).toHaveCount(0);

  // The long all-day title is shortened in its cell; the day opens it in full.
  // (Tomorrow may be in next month's grid when today is the last day.)
  let long = grid.locator('.month-event', { hasText: LONG });
  if ((await long.count()) === 0) {
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
    long = grid.locator('.month-event', { hasText: LONG });
  }
  await expect(long.first()).toHaveClass(/month-event-block/);
  await expect(long.first()).toHaveAttribute('title', `All day: ${LONG}`);
  await long.first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(LONG)).toBeVisible();
  expect(await dialog.getByText(LONG).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true); // wraps in full
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Month navigation and back to today's month.
  await page.goto('/');
  await openCalendar(page);
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(monthTitle).not.toHaveText(thisMonth!);
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(monthTitle).toHaveText(thisMonth!);
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeDisabled();

  // Nothing secret reaches the browser: the answer holds only display fields.
  const body = await page.evaluate(async () => (await fetch('/api/calendar')).text());
  expect(body).not.toMatch(/token|secret|client_id|refresh/i);

  await page.getByRole('button', { name: 'Back to chore chart' }).click();
  await expect(page.getByRole('heading', { name: 'Who’s doing chores?' })).toBeVisible();
});

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1080, height: 1920 },
  { width: 390, height: 844 },
]) {
  test(`header at ${viewport.width}×${viewport.height}: month centred with an arrow either side; Today beside Refresh`, async ({ page }) => {
    await page.setViewportSize(viewport);
    writeFileSync(E2E_CALENDAR_FIXTURE!, JSON.stringify({ summary: 'E2E Test Family', items: [] }));
    await openCalendar(page);
    const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
    const header = await box('.calendar-toolbar');
    const title = await box('.calendar-month-title');
    const prev = await box('button[aria-label="Previous month"]');
    const next = await box('button[aria-label="Next month"]');
    const today = await box('.calendar-today-button');
    const refresh = await box('button[aria-label="Refresh"]');
    const mid = (b: { x: number; width: number }) => b.x + b.width / 2;
    const midY = (b: { y: number; height: number }) => b.y + b.height / 2;
    // The month is centred on the header line (within 2 px).
    expect(Math.abs(mid(title) - mid(header))).toBeLessThanOrEqual(2);
    // ‹ right before the month, › right after it, on the same line.
    expect(prev.x + prev.width).toBeLessThanOrEqual(title.x + 1);
    expect(title.x - (prev.x + prev.width)).toBeLessThan(24);
    expect(next.x).toBeGreaterThanOrEqual(title.x + title.width - 1);
    expect(next.x - (title.x + title.width)).toBeLessThan(24);
    expect(Math.abs(midY(prev) - midY(title))).toBeLessThan(8);
    expect(Math.abs(midY(next) - midY(title))).toBeLessThan(8);
    // Today immediately left of Refresh, on one line, at the right-hand end.
    expect(today.x + today.width).toBeLessThanOrEqual(refresh.x + 1);
    expect(refresh.x - (today.x + today.width)).toBeLessThan(24);
    expect(Math.abs(midY(today) - midY(refresh))).toBeLessThan(8);
    expect(header.x + header.width - (refresh.x + refresh.width)).toBeLessThan(4);
    // On wide screens it's all one line.
    if (viewport.width > 1100) expect(Math.abs(midY(title) - midY(refresh))).toBeLessThan(8);
    // Touch-friendly targets.
    for (const b of [prev, next, today, refresh]) expect(b.height).toBeGreaterThanOrEqual(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });
}

for (const viewport of [
  { width: 1366, height: 768 }, // a laptop at 100% zoom
  { width: 1080, height: 1920 }, // the portrait kiosk
]) {
  test(`the whole month fits on screen at ${viewport.width}×${viewport.height}, filling the page`, async ({ page }) => {
    await page.setViewportSize(viewport);
    writeFileSync(E2E_CALENDAR_FIXTURE!, JSON.stringify({ summary: 'E2E Test Family', items: [] }));
    await openCalendar(page);
    const m = await page.evaluate(() => {
      const g = document.querySelector('.month-grid')!.getBoundingClientRect();
      const root = document.documentElement;
      return { gridBottom: g.bottom, gridHeight: g.height, gridWidth: g.width, scrollsDown: root.scrollHeight > innerHeight + 1, scrollsSideways: root.scrollWidth > root.clientWidth };
    });
    expect(m.scrollsDown).toBe(false);
    expect(m.scrollsSideways).toBe(false);
    expect(m.gridBottom).toBeLessThanOrEqual(viewport.height);
    expect(m.gridWidth).toBeGreaterThan(viewport.width * 0.9);
    expect(m.gridHeight).toBeGreaterThan(viewport.height * 0.6);
  });
}

test('the browser-only build has no calendar button', async ({ page }) => {
  await page.goto('http://localhost:4177/');
  await expect(page.getByRole('button', { name: /Open Maya's chore chart/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Family Calendar' })).toHaveCount(0);
});

test('Settings → Integrations: without Google settings, a calendar address (iCal) is offered and checked safely', async ({ page }) => {
  await page.goto('/');
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible().catch(() => false)) await later.click();
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await page.getByRole('button', { name: 'Continue to parent area' }).click();
  await page.getByRole('tab', { name: /Settings/ }).click();
  const card = page.getByRole('region', { name: 'Family calendar' });
  await expect(card).toContainText('Integrations');
  // This test server has a secret key but no Google OAuth client.
  await expect(card).toContainText('1. Google Calendar sign-in (recommended)');
  await expect(card.getByText('SFCC_GOOGLE_CLIENT_ID')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Connect Google Calendar' })).toHaveCount(0);
  await expect(card).toContainText('works like a password');

  // Addresses the server refuses before fetching anything (no network involved).
  const address = card.getByLabel('Calendar address');
  for (const url of ['https://example.com/calendar.ics', 'https://127.0.0.1/calendar/ical/x/private-ab/basic.ics']) {
    await address.fill(url);
    await card.getByRole('button', { name: 'Check address' }).click();
    await expect(card.getByRole('alert')).toContainText('isn’t from a supported calendar provider');
    await expect(address).toHaveAttribute('aria-invalid', 'true');
  }
  // Nothing was connected.
  const status = await page.evaluate(async () => (await fetch('/api/calendar/connection')).json());
  expect(status.connection).toBeNull();
  expect(status.ical.available).toBe(true);
});

test('coming back from Google shows the result, tidies the address and returns to Settings', async ({ page }) => {
  await page.goto('/#google-calendar=denied');
  await expect(page.getByText('access was cancelled on Google’s page')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  // Development mode counts as a signed-in parent: back to Settings.
  await expect(page.getByRole('tab', { name: /Settings/ })).toHaveAttribute('aria-selected', 'true');
});
