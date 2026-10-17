import { expect, test, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { AUTH_WEB_PORT, E2E_SETUP_CODE } from '../playwright.config';

// Sign-out when the server can't confirm it. Failures are injected
// deterministically by intercepting POST /api/auth/logout in the browser
// (network failure, HTTP error, no answer), so nothing depends on timing.
// The server's own view is checked through the same browser context's
// cookies, to make sure the UI never claims more than the server confirmed.
test.use({ baseURL: `http://localhost:${AUTH_WEB_PORT}` });

const base = `http://localhost:${AUTH_WEB_PORT}`;
// Same test-only account as auth.spec.ts (created here if this spec runs alone).
const USERNAME = 'sam';
const PASSWORD = 'e2e correct horse battery';
const UNCONFIRMED = /Couldn’t confirm sign-out with the family server/;

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

/** A paired kiosk with a parent signed in on it. */
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

async function openParentArea(page: Page) {
  await page.goto('/');
  await dismissMealReminder(page);
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(page.getByRole('heading', { name: /Parent area/ })).toBeVisible();
}

/** Intercept logout; `mode` decides the injected outcome. Returns a call counter. */
async function failLogout(page: Page, mode: 'network' | 'http500' | 'hang') {
  const counter = { calls: 0 };
  await page.route('**/api/auth/logout', async (route: Route) => {
    counter.calls++;
    if (mode === 'network') return route.abort('failed');
    if (mode === 'http500') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error' }) });
    // 'hang': never answer (the app's own timeout must handle it).
  });
  return counter;
}

test.beforeAll(async ({ browser }) => {
  await ensureParent(browser);
});

test('successful sign-out on a parent’s own device ends the server session and locks the app', async ({ browser }) => {
  const { ctx, page } = await signedInContext(browser);
  const oldToken = await parentCookie(ctx);
  await openParentArea(page);
  await page.getByRole('tab', { name: /Family access/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  await expect(page.getByText('Signed out.', { exact: true })).toBeVisible();
  await expect(page.getByText(UNCONFIRMED)).toHaveCount(0);
  expect((await serverStatus(ctx)).parent).toBeNull();
  // The old token no longer works anywhere.
  const replay = await browser.newContext({ baseURL: base });
  await replay.addCookies([{ name: 'sfcc_parent', value: oldToken!, url: base }]);
  expect((await serverStatus(replay)).parent).toBeNull();
  await replay.close();
  await ctx.close();
});

test('successful "Done – lock & exit" on a kiosk ends the server session but keeps the pairing', async ({ browser }) => {
  const { ctx, page } = await signedInKiosk(browser);
  await openParentArea(page);
  await page.getByRole('button', { name: 'Done – lock & exit' }).click();
  await expect(page.getByText('Parent area locked and signed out.')).toBeVisible();
  await dismissMealReminder(page);
  const status = await serverStatus(ctx);
  expect(status.parent).toBeNull();
  expect(status.device).not.toBeNull();
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Parent sign in' })).toBeVisible();
  await ctx.close();
});

test('failed sign-out (network error) keeps the app locked, says so, survives a reload, and can be retried', async ({ browser }) => {
  const { ctx, page } = await signedInContext(browser);
  await openParentArea(page);
  const logout = await failLogout(page, 'network');
  await page.getByRole('tab', { name: /Family access/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();

  // Locked on this screen: no family data, no way back in without signing in.
  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  const banner = page.getByRole('alert').filter({ hasText: UNCONFIRMED });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('may still be active on the server');
  await expect(page.getByText('Signed out.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Maya')).toHaveCount(0);
  // Honest: the server session really is still active.
  expect((await serverStatus(ctx)).parent).not.toBeNull();

  // A reload doesn't unlock it; the sign-out is retried straight away.
  const before = logout.calls;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  await expect(banner).toBeVisible();
  await expect.poll(() => logout.calls).toBeGreaterThan(before);

  // Once the server is reachable again, "Try again" confirms it.
  await page.unroute('**/api/auth/logout');
  await page.getByRole('button', { name: 'Try signing out again' }).click();
  await expect(banner).toHaveCount(0);
  expect((await serverStatus(ctx)).parent).toBeNull();
  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  await ctx.close();
});

test('failed "Done – lock & exit" (HTTP 500) on a kiosk keeps the parent area locked; signing in again replaces the old session', async ({ browser }) => {
  const { ctx, page } = await signedInKiosk(browser);
  const oldToken = await parentCookie(ctx);
  await openParentArea(page);
  await failLogout(page, 'http500');
  await page.getByRole('button', { name: 'Done – lock & exit' }).click();

  const banner = page.getByRole('alert').filter({ hasText: UNCONFIRMED });
  await expect(banner).toBeVisible();
  await expect(page.getByText('Parent area locked and signed out.')).toHaveCount(0);
  await dismissMealReminder(page);
  expect((await serverStatus(ctx)).parent).not.toBeNull(); // not claimed as signed out
  // The parent area does NOT reopen: a password is needed again.
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Parent sign in' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('heading', { name: /Parent area/ })).toHaveCount(0);

  // Signing in again works even while logout is failing, and ends the old session on the server.
  await dialog.getByLabel('Username').fill(USERNAME);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Parent area/ })).toBeVisible();
  await expect(banner).toHaveCount(0);
  const replay = await browser.newContext({ baseURL: base });
  await replay.addCookies([{ name: 'sfcc_parent', value: oldToken!, url: base }]);
  expect((await serverStatus(replay)).parent).toBeNull();
  await replay.close();

  // With the server answering again, lock & exit is confirmed.
  await page.unroute('**/api/auth/logout');
  await page.getByRole('button', { name: 'Done – lock & exit' }).click();
  await expect(page.getByText('Parent area locked and signed out.')).toBeVisible();
  expect((await serverStatus(ctx)).parent).toBeNull();
  await ctx.close();
});

test('a sign-out the server never answers locks at once and times out with a clear error', async ({ browser }) => {
  test.setTimeout(45_000);
  const { ctx, page } = await signedInKiosk(browser);
  await openParentArea(page);
  await failLogout(page, 'hang');
  await page.getByRole('tab', { name: /Family access/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  // Locked immediately, before any answer: the parent area can't be reopened.
  await dismissMealReminder(page);
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Parent sign in' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  // After the app's timeout, the problem is reported (not success).
  const banner = page.getByRole('alert').filter({ hasText: UNCONFIRMED });
  await expect(banner).toContainText('didn’t answer in time', { timeout: 15_000 });
  await expect(page.getByText('Signed out.', { exact: true })).toHaveCount(0);
  expect((await serverStatus(ctx)).parent).not.toBeNull();
  await ctx.close();
});
