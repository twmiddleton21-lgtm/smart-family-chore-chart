import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { AUTH_WEB_PORT, E2E_SETUP_CODE } from '../playwright.config';

// Parent-area idle lock. The page's clock is faked (page.clock), so half an
// hour passes in milliseconds and nothing depends on real-time waits. The
// server keeps real time, so its own 30-minute idle timeout never runs out
// during these tests: only the app's idle lock can close the parent area.
test.use({ baseURL: `http://localhost:${AUTH_WEB_PORT}` });

const base = `http://localhost:${AUTH_WEB_PORT}`;
const MINUTE = 60_000;
// Same test-only account as auth.spec.ts / signout.spec.ts.
const USERNAME = 'sam';
const PASSWORD = 'e2e correct horse battery';
const IDLE_MESSAGE = 'Parent area locked and signed out after 30 minutes without activity.';

async function ensureParent(browser: Browser) {
  const ctx = await browser.newContext({ baseURL: base });
  const status = await (await ctx.request.get('/api/auth/status')).json();
  if (status.setupRequired) {
    const r = await ctx.request.post('/api/auth/setup', { data: { setupCode: E2E_SETUP_CODE, username: USERNAME, displayName: 'Sam', password: PASSWORD } });
    expect(r.ok()).toBe(true);
  }
  await ctx.close();
}

async function signedInContext(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: base });
  const r = await ctx.request.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  expect(r.status(), await r.text()).toBe(200);
  return { ctx, page: await ctx.newPage() };
}

async function signedInKiosk(browser: Browser) {
  const admin = await signedInContext(browser);
  const { code } = await (await admin.ctx.request.post('/api/devices/pairing-codes', { data: { name: `Kiosk ${Date.now()}` } })).json();
  await admin.ctx.close();
  const kiosk = await browser.newContext({ baseURL: base });
  expect((await kiosk.request.post('/api/devices/pair', { data: { code } })).ok()).toBe(true);
  expect((await kiosk.request.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } })).ok()).toBe(true);
  return { ctx: kiosk, page: await kiosk.newPage() };
}

const serverStatus = async (ctx: BrowserContext) => (await ctx.request.get('/api/auth/status')).json();
const parentCookie = async (ctx: BrowserContext) => (await ctx.cookies()).find((c) => c.name === 'sfcc_parent')?.value;

async function dismissMealReminder(page: Page) {
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible({ timeout: 1500 }).catch(() => false)) await later.click();
}

const parentHeading = (page: Page) => page.getByRole('heading', { name: /Parent area/ });

async function openParentArea(page: Page) {
  await page.clock.install();
  await page.goto('/');
  await dismissMealReminder(page);
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(parentHeading(page)).toBeVisible();
}

/**
 * Let fake time pass in 15-second steps until the parent area closes (so
 * little time passes after it, and the confirmation stays on screen).
 * Returns how long that took.
 */
async function idleUntilLocked(page: Page, limitMs: number): Promise<number> {
  for (let t = 15_000; t <= limitMs; t += 15_000) {
    await page.clock.runFor(15_000);
    if ((await parentHeading(page).count()) === 0) return t;
  }
  throw new Error(`The parent area was still open after ${limitMs / MINUTE} more minutes.`);
}

/** Count the app's requests to an API path from now on. */
function countRequests(page: Page, path: string) {
  const counter = { calls: 0 };
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === path) counter.calls++;
  });
  return counter;
}

test.beforeAll(async ({ browser }) => {
  await ensureParent(browser);
});

test('kiosk: 30 minutes without input locks the parent area and ends the session, with no status polling', async ({ browser }) => {
  const { ctx, page } = await signedInKiosk(browser);
  const oldToken = await parentCookie(ctx);
  await openParentArea(page);
  const status = countRequests(page, '/api/auth/status');
  const logout = countRequests(page, '/api/auth/logout');

  // 29 idle minutes: still open, and the app asked the server nothing (the
  // old idle check polled /api/auth/status, which kept the session alive).
  await page.clock.runFor(29 * MINUTE);
  await expect(parentHeading(page)).toBeVisible();
  expect(status.calls).toBe(0);

  // Events dispatched by scripts are not genuine input.
  await page.evaluate(() => {
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.dispatchEvent(new Event(type));
  });
  await idleUntilLocked(page, 2 * MINUTE);

  await expect(page.getByText(IDLE_MESSAGE)).toBeVisible();
  expect(logout.calls).toBe(1);
  // The server confirmed it: the session is gone, the pairing is kept.
  const after = await serverStatus(ctx);
  expect(after.parent).toBeNull();
  expect(after.device).not.toBeNull();
  const replay = await browser.newContext({ baseURL: base });
  await replay.addCookies([{ name: 'sfcc_parent', value: oldToken!, url: base }]);
  expect((await serverStatus(replay)).parent).toBeNull();
  await replay.close();

  // Getting back in needs the password.
  await dismissMealReminder(page);
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Parent sign in' })).toBeVisible();
  // No polling afterwards either.
  const settled = status.calls;
  await page.clock.runFor(60 * MINUTE);
  expect(status.calls).toBe(settled);
  await ctx.close();
});

test('own device: regular input keeps the parent area open; going idle locks the app', async ({ browser }) => {
  const { ctx, page } = await signedInContext(browser);
  await openParentArea(page);

  // A parent working normally: some input every 20 minutes for an hour.
  for (let i = 0; i < 3; i++) {
    await page.clock.runFor(20 * MINUTE);
    await parentHeading(page).click(); // real (trusted) input
  }
  await expect(parentHeading(page)).toBeVisible();
  expect((await serverStatus(ctx)).parent).not.toBeNull();

  // Window focus without input doesn't count.
  await page.clock.runFor(15 * MINUTE);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(14 * MINUTE);
  await expect(parentHeading(page)).toBeVisible();
  await idleUntilLocked(page, 2 * MINUTE);

  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  await expect(page.getByText(IDLE_MESSAGE)).toBeVisible();
  expect((await serverStatus(ctx)).parent).toBeNull();
  await ctx.close();
});

test('idle lock when the server can’t confirm the sign-out: stays locked and says the session may still be active', async ({ browser }) => {
  const { ctx, page } = await signedInKiosk(browser);
  await openParentArea(page);
  await page.route('**/api/auth/logout', (route) => route.abort('failed'));

  await page.clock.runFor(29 * MINUTE);
  await expect(parentHeading(page)).toBeVisible();
  await idleUntilLocked(page, 2 * MINUTE);

  const banner = page.getByRole('alert').filter({ hasText: /Couldn’t confirm sign-out with the family server/ });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('may still be active on the server');
  await expect(page.getByText(IDLE_MESSAGE)).toHaveCount(0);
  // Honest: the server session really is still active, but the parent area needs a password.
  expect((await serverStatus(ctx)).parent).not.toBeNull();
  await dismissMealReminder(page);
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Parent sign in' })).toBeVisible();
  await ctx.close();
});
