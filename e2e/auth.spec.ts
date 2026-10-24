import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { AUTH_WEB_PORT, E2E_SETUP_CODE } from '../playwright.config';

// Normal mode (sign-in on) in a real browser: first-run setup, parent
// sign-in, device pairing, what a paired device may do, sign-out and
// unpairing. Runs in order against one throwaway server whose setup code is
// preset for the test. No real family data is involved.
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: `http://localhost:${AUTH_WEB_PORT}` });

const PASSWORD = 'e2e correct horse battery';

let parentCtx: BrowserContext;
let parent: Page;
let kioskCtx: BrowserContext;
let kiosk: Page;

const base = `http://localhost:${AUTH_WEB_PORT}`;
const newPage = async (browser: Browser) => {
  const ctx = await browser.newContext({ baseURL: base });
  return { ctx, page: await ctx.newPage() };
};

async function dismissMealReminder(page: Page) {
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible({ timeout: 1500 }).catch(() => false)) await later.click();
}

test.beforeAll(async ({ browser }) => {
  ({ ctx: parentCtx, page: parent } = await newPage(browser));
  ({ ctx: kioskCtx, page: kiosk } = await newPage(browser));
});
test.afterAll(async () => {
  await parentCtx?.close();
  await kioskCtx?.close();
});

/** No pre-release strip (removed), and no development-mode strip in this normal, sign-in build. */
const expectNoBuildBanner = async (page: Page) => {
  await expect(page.getByText(/Pre-release build/)).toHaveCount(0);
  await expect(page.locator('.banner-dev')).toHaveCount(0);
};

test('a fresh server asks for first-run setup and shows no family data', async () => {
  await parent.goto('/');
  await expect(parent.getByRole('heading', { name: 'Set up your family server' })).toBeVisible();
  await expectNoBuildBanner(parent);
  // Nothing of the household is reachable without signing in.
  const status = await parent.evaluate(async () => (await fetch('/api/state')).status);
  expect(status).toBe(401);
});

test('setup needs the right code, then signs the first parent in', async () => {
  await parent.getByLabel('Setup code').fill('WRONG-CODE-0000');
  await parent.getByLabel('Your name').fill('Sam');
  await parent.getByLabel('Username').fill('sam');
  await parent.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await parent.getByLabel('Type the password again').fill(PASSWORD);
  await parent.getByRole('button', { name: 'Create parent account' }).click();
  await expect(parent.getByRole('alert').filter({ hasText: 'setup code isn’t right' })).toBeVisible();

  await parent.getByLabel('Setup code').fill(E2E_SETUP_CODE.toLowerCase());
  await parent.getByRole('button', { name: 'Create parent account' }).click();
  await expect(parent.getByText('No profiles yet.', { exact: false })).toBeVisible();
  await expectNoBuildBanner(parent);
  // The session cookie is HttpOnly: page scripts can't read it.
  expect(await parent.evaluate(() => document.cookie)).not.toContain('sfcc_parent');
  const cookie = (await parentCtx.cookies()).find((c) => c.name === 'sfcc_parent');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
});

test('a signed-in parent goes straight to the parent area and can load the demo family', async () => {
  await parent.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(parent.getByRole('heading', { name: /Parent area/ })).toBeVisible();
  await expect(parent.getByLabel('Enter the parent PIN')).toHaveCount(0);
  await expectNoBuildBanner(parent);
  await parent.getByRole('tab', { name: /Settings/ }).click();
  await parent.getByRole('button', { name: 'Load demo family' }).click();
  await parent.getByRole('dialog').getByRole('button', { name: 'Load demo family' }).click();
  await expect(parent.getByText('Demo family loaded.')).toBeVisible();
  // On the parent's own (unpaired) device, leaving keeps them signed in.
  await parent.getByRole('button', { name: 'Done', exact: true }).click();
  await dismissMealReminder(parent);
  await expect(parent.getByRole('button', { name: /Open Maya's chore chart/ })).toBeVisible();
});

test('an unpaired browser sees only the locked screen', async () => {
  await kiosk.goto('/');
  await expect(kiosk.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  await expectNoBuildBanner(kiosk);
  await expect(kiosk.getByText('Maya')).toHaveCount(0);
  expect(await kiosk.evaluate(async () => (await fetch('/api/state')).status)).toBe(401);
  // A wrong pairing code is refused.
  await kiosk.getByLabel('Pairing code').fill('AAAA-BBBB');
  await kiosk.getByRole('button', { name: 'Pair this device' }).click();
  await expect(kiosk.getByText('That pairing code isn’t valid.', { exact: false })).toBeVisible();
});

test('a parent pairs the kitchen tablet with a one-time code', async () => {
  await parent.getByRole('button', { name: /Parent area/ }).first().click();
  await parent.getByRole('tab', { name: /Family access/ }).click();
  await parent.getByLabel('Device name').fill('Kitchen tablet');
  await parent.getByRole('button', { name: 'Create pairing code' }).click();
  const code = (await parent.getByTestId('pairing-code').textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  await kiosk.getByLabel('Pairing code').fill(code);
  await kiosk.getByRole('button', { name: 'Pair this device' }).click();
  await dismissMealReminder(kiosk);
  await expect(kiosk.getByRole('button', { name: /Open Maya's chore chart/ })).toBeVisible();
  await expectNoBuildBanner(kiosk);

  // The device now appears in the parent's list.
  await parent.getByRole('tab', { name: /Settings/ }).click();
  await parent.getByRole('tab', { name: /Family access/ }).click();
  await expect(parent.getByText('Kitchen tablet', { exact: true })).toBeVisible();
});

test('the paired tablet can tick chores, but the parent area needs a parent to sign in', async () => {
  await kiosk.getByRole('button', { name: /Open Maya's chore chart/ }).click();
  const bed = kiosk.getByRole('button', { name: /^Make your bed, 5 points/ });
  await bed.click();
  await expect(bed).toHaveAttribute('aria-pressed', 'true');
  await kiosk.getByRole('button', { name: /All profiles/ }).click();

  await kiosk.getByRole('button', { name: /Parent area/ }).first().click();
  const dialog = kiosk.getByRole('dialog', { name: 'Parent sign in' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Username').fill('sam');
  await dialog.getByLabel('Password').fill('not the password');
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog.getByText('That username and password don’t match.')).toBeVisible();

  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(kiosk.getByRole('heading', { name: /Parent area/ })).toBeVisible();

  // On a shared device, leaving signs the parent out again.
  await kiosk.getByRole('button', { name: 'Done – lock & exit' }).click();
  await dismissMealReminder(kiosk);
  await kiosk.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(kiosk.getByRole('dialog', { name: 'Parent sign in' })).toBeVisible();
  await kiosk.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  expect(await kiosk.evaluate(async () => (await fetch('/api/export')).status)).toBe(403);
});

test('a cross-site request is refused even with valid cookies', async () => {
  // Simulate a forged form post: same cookies, foreign Origin.
  const r = await parentCtx.request.post('/api/commands', {
    data: { type: 'resetFamily', payload: {} },
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  expect(r.status()).toBe(403);
  await parent.reload();
  await dismissMealReminder(parent);
  await expect(parent.getByRole('button', { name: /Open Maya's chore chart/ })).toBeVisible();
});

test('unpairing the tablet locks it straight away', async () => {
  await parent.getByRole('button', { name: /Parent area/ }).first().click();
  await parent.getByRole('tab', { name: /Family access/ }).click();
  await parent.getByRole('listitem').filter({ hasText: 'Kitchen tablet' }).getByRole('button', { name: 'Unpair' }).click();
  await parent.getByRole('dialog').getByRole('button', { name: 'Unpair device' }).click();
  await expect(parent.getByText('No devices are paired yet.')).toBeVisible();

  await kiosk.reload();
  await expect(kiosk.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
});

test('signing out ends the parent session', async () => {
  await parent.getByRole('button', { name: 'Sign out' }).click();
  await expect(parent.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
  expect(await parent.evaluate(async () => (await fetch('/api/state')).status)).toBe(401);
});
