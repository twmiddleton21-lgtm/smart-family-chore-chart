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

/**
 * A paired kiosk. The parent signs in on its screen (openParentArea): a
 * parent session found when a kiosk page loads is signed out at once.
 */
async function signedInKiosk(browser: Browser) {
  const admin = await signedInContext(browser);
  const { code } = await (await admin.ctx.request.post('/api/devices/pairing-codes', { data: { name: `Kiosk ${Date.now()}` } })).json();
  await admin.ctx.close();
  const kiosk = await browser.newContext({ baseURL: base });
  expect((await kiosk.request.post('/api/devices/pair', { data: { code } })).ok()).toBe(true);
  return { ctx: kiosk, page: await kiosk.newPage() };
}

const serverStatus = async (ctx: BrowserContext) => (await ctx.request.get('/api/auth/status')).json();
const parentCookie = async (ctx: BrowserContext) => (await ctx.cookies()).find((c) => c.name === 'sfcc_parent')?.value;

async function dismissMealReminder(page: Page) {
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible({ timeout: 1500 }).catch(() => false)) await later.click();
}

/** Open the parent area, signing in on the screen if asked (always on a kiosk). */
async function openParentArea(page: Page) {
  await page.goto('/');
  await dismissMealReminder(page);
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  const heading = page.getByRole('heading', { name: /Parent area/ });
  const dialog = page.getByRole('dialog', { name: 'Parent sign in' });
  await expect(heading.or(dialog)).toBeVisible();
  if (await dialog.isVisible()) {
    await dialog.getByLabel('Username').fill(USERNAME);
    await dialog.getByLabel('Password').fill(PASSWORD);
    await dialog.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(heading).toBeVisible();
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
  await openParentArea(page);
  const oldToken = await parentCookie(ctx);
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

// ---------- Finding 2: a retry only ends the session it was for ----------

test('an old sign-out retry leaves alone a newer sign-in from another tab (also after a reload)', async ({ browser }) => {
  const { ctx, page } = await signedInContext(browser);
  await page.clock.install();
  await openParentArea(page);
  const oldToken = await parentCookie(ctx);
  await failLogout(page, 'network');
  await page.getByRole('tab', { name: /Family access/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  const problem = page.getByRole('alert').filter({ hasText: UNCONFIRMED });
  await expect(problem).toBeVisible();

  // The parent signs in again in another tab of the same browser (shared cookie).
  const other = await ctx.newPage();
  expect((await other.request.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } })).ok()).toBe(true);
  const newToken = await parentCookie(ctx);
  expect(newToken).not.toBe(oldToken);

  // The first tab is reloaded (its retry still names the OLD session) and the server is reachable again.
  const sentAfter: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/auth/logout') sentAfter.push(r.postData() ?? '');
  });
  await page.unroute('**/api/auth/logout');
  await page.reload();
  await page.clock.runFor(31_000); // give the background retry a chance

  await expect(problem).toHaveCount(0); // the sign-out settled
  // The newer session is untouched: same cookie, still signed in.
  expect((await serverStatus(ctx)).parent).not.toBeNull();
  expect(await parentCookie(ctx)).toBe(newToken);
  // Any retry that was sent named the old session, never "whatever this browser holds now".
  for (const body of sentAfter) expect(JSON.parse(body)).toEqual({ sessionId: expect.stringMatching(/^[0-9a-f]{64}$/) });
  await expect(page.getByText('The parent session this screen was signing out has ended.')).toBeVisible();
  // The first tab stays locked and stops retrying.
  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  const settled = sentAfter.length;
  await page.clock.runFor(5 * 60_000);
  expect(sentAfter.length).toBe(settled);
  expect((await serverStatus(ctx)).parent).not.toBeNull();
  await other.close();
  await ctx.close();
});

test('signing in while an old sign-out retry is still on its way keeps the new session', async ({ browser }) => {
  const { ctx, page } = await signedInKiosk(browser);
  await openParentArea(page);
  await failLogout(page, 'http500');
  await page.getByRole('button', { name: 'Done – lock & exit' }).click();
  await expect(page.getByRole('alert').filter({ hasText: UNCONFIRMED })).toBeVisible();

  // Next attempt: held on the network until released.
  await page.unroute('**/api/auth/logout');
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let sent = 0;
  await page.route('**/api/auth/logout', async (route) => {
    sent++;
    await held;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Try signing out again' }).click();
  await expect.poll(() => sent).toBe(1);

  const order: string[] = [];
  page.on('request', (r) => new URL(r.url()).pathname === '/api/auth/login' && order.push('login sent'));
  page.on('requestfinished', (r) => new URL(r.url()).pathname === '/api/auth/logout' && order.push('logout answered'));

  // Sign in meanwhile.
  await dismissMealReminder(page);
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Parent sign in' });
  await dialog.getByLabel('Username').fill(USERNAME);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  // Give a sign-in that doesn't wait every chance to finish first, then let the old attempt arrive.
  await page.getByRole('heading', { name: /Parent area/ }).waitFor({ timeout: 2000 }).catch(() => undefined);
  release();

  await expect(page.getByRole('heading', { name: /Parent area/ })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: UNCONFIRMED })).toHaveCount(0);
  const status = await serverStatus(ctx);
  expect(status.parent).not.toBeNull(); // the new session survived the old attempt
  expect(status.device).not.toBeNull();
  expect(sent).toBe(1);
  expect(order).toEqual(['logout answered', 'login sent']); // the sign-in waited for the attempt on its way
  await ctx.close();
});

test('a sign-out answer that arrives after another tab’s sign-in doesn’t clear the new cookie', async ({ browser }) => {
  const { ctx, page } = await signedInContext(browser);
  await openParentArea(page);
  const tokenA = await parentCookie(ctx);

  // The server handles tab A's sign-out at once; its answer reaches the browser only when released.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let handled!: () => void;
  const serverDone = new Promise<void>((r) => (handled = r));
  await page.route('**/api/auth/logout', async (route) => {
    const response = await route.fetch();
    handled();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole('tab', { name: /Family access/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await serverDone;

  // Tab B (same browser) signs in before tab A's answer arrives.
  const other = await ctx.newPage();
  expect((await other.request.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } })).ok()).toBe(true);
  const tokenB = await parentCookie(ctx);
  expect(tokenB).toBeTruthy();
  expect(tokenB).not.toBe(tokenA);

  release(); // tab A's old answer arrives last
  // Tab A ended its session; it sees tab B's newer sign-in, leaves it alone and stays locked.
  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  await expect(page.getByText('The parent session this screen was signing out has ended.')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: UNCONFIRMED })).toHaveCount(0);

  const replay = async (token: string) => {
    const c = await browser.newContext({ baseURL: base });
    await c.addCookies([{ name: 'sfcc_parent', value: token, url: base }]);
    const parent = (await serverStatus(c)).parent;
    await c.close();
    return parent;
  };
  expect(await replay(tokenA!)).toBeNull(); // session A ended
  expect(await replay(tokenB!)).not.toBeNull(); // session B valid on the server
  expect(await parentCookie(ctx)).toBe(tokenB); // and the browser still holds it
  expect((await serverStatus(ctx)).parent).not.toBeNull();
  await other.close();
  await ctx.close();
});

// ---------- a sign-out that doesn't know which session to end ----------

const UNKNOWN_SESSION = /doesn’t know which parent session to end/;

function countLogouts(page: Page) {
  const counter = { calls: 0 };
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/auth/logout') counter.calls++;
  });
  return counter;
}

test('a sign-out saved by an older build (session unknown) sends nothing, claims nothing and stays locked', async ({ browser }) => {
  const { ctx, page } = await signedInContext(browser);
  // An unconfirmed sign-out as the previous build stored it (no session id).
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('sfcc:seeded')) {
      sessionStorage.setItem('sfcc:seeded', '1');
      sessionStorage.setItem('sfcc:sign-out-unconfirmed', '1');
    }
  });
  await page.clock.install();
  const logout = countLogouts(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  const warning = page.getByRole('alert').filter({ hasText: UNKNOWN_SESSION });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('may still be active on the server');
  await expect(page.getByRole('button', { name: 'Try signing out again' })).toHaveCount(0);
  await expect(page.getByText(/has ended/)).toHaveCount(0);

  await page.clock.runFor(5 * 60_000); // no automatic retries
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(60_000);
  expect(logout.calls).toBe(0);
  await expect(warning).toBeVisible();
  await expect(page.getByText(/has ended/)).toHaveCount(0);
  expect((await serverStatus(ctx)).parent).not.toBeNull(); // honest: it really is still active

  // Signing in again replaces the session and settles it.
  await page.getByRole('button', { name: 'Parent sign in' }).click();
  const dialog = page.getByRole('dialog', { name: 'Parent sign in' });
  await dialog.getByLabel('Username').fill(USERNAME);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Connect this device' })).toHaveCount(0);
  await ctx.close();
});

test('with a server that doesn’t report session ids, sign-out sends nothing, claims nothing and stays locked', async ({ browser }) => {
  const { ctx, page } = await signedInContext(browser);
  await page.route('**/api/auth/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.sessionId;
    await route.fulfill({ response, json: body });
  });
  const logout = countLogouts(page);
  await openParentArea(page);
  await page.getByRole('tab', { name: /Family access/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  const warning = page.getByRole('alert').filter({ hasText: UNKNOWN_SESSION });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('may still be active on the server');
  await expect(page.getByText('Signed out.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/has ended/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try signing out again' })).toHaveCount(0);
  expect(logout.calls).toBe(0);
  expect((await serverStatus(ctx)).parent).not.toBeNull();
  // A reload keeps it locked and still sends nothing.
  await page.reload();
  await expect(warning).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  expect(logout.calls).toBe(0);
  await ctx.close();
});

// ---------- kiosk reload ----------

test('reloading a kiosk signs out the parent session it finds: the parent area needs the password again', async ({ browser }) => {
  const { ctx, page } = await signedInKiosk(browser);
  await openParentArea(page); // signed in on the kiosk's screen
  const token = await parentCookie(ctx);
  expect((await serverStatus(ctx)).parent).not.toBeNull();

  await page.reload(); // e.g. F5, or the kiosk browser restarting
  await dismissMealReminder(page);
  await expect(page.getByRole('heading', { name: /Parent area/ })).toHaveCount(0);
  // The session was ended on the server, not just hidden; the pairing is kept.
  await expect.poll(async () => (await serverStatus(ctx)).parent).toBeNull();
  expect((await serverStatus(ctx)).device).not.toBeNull();
  const replay = await browser.newContext({ baseURL: base });
  await replay.addCookies([{ name: 'sfcc_parent', value: token!, url: base }]);
  expect((await serverStatus(replay)).parent).toBeNull();
  await replay.close();
  await expect(page.getByRole('alert').filter({ hasText: UNCONFIRMED })).toHaveCount(0);

  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Parent sign in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Parent area/ })).toHaveCount(0);
  await ctx.close();
});

test('reloading on a parent’s own (unpaired) device keeps them signed in, as before', async ({ browser }) => {
  const { ctx, page } = await signedInContext(browser);
  await openParentArea(page);
  await page.reload();
  await dismissMealReminder(page);
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(page.getByRole('heading', { name: /Parent area/ })).toBeVisible(); // no password asked
  expect((await serverStatus(ctx)).parent).not.toBeNull();
  await ctx.close();
});
