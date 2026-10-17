import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// End-to-end checks of the shared-backend development build in a real
// browser. Tests run in order against one throwaway server.
test.describe.configure({ mode: 'serial' });

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, 'fixtures', name);

async function dismissMealReminder(page: Page) {
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible().catch(() => false)) await later.click();
}

async function openParentArea(page: Page) {
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Parent area (development build)' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to parent area' }).click();
  await expect(page.getByRole('heading', { name: /Parent area/ })).toBeVisible();
}

test('a new server starts empty, with a clear development notice instead of a PIN', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/Development build: shared family server with/)).toBeVisible();
  await expect(page.getByText('No profiles yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  const notice = page.getByRole('dialog', { name: 'Parent area (development build)' });
  await expect(notice).toContainText('no parent sign-in yet');
  await expect(page.getByLabel('Enter the parent PIN')).toHaveCount(0);
});

test('a parent can load the demo family into the empty household', async ({ page }) => {
  await page.goto('/');
  await openParentArea(page);
  await page.getByRole('tab', { name: /Settings/ }).click();
  await expect(page.getByText('Parent sign-in')).toBeVisible();
  await page.getByRole('button', { name: 'Load demo family' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Load demo family' }).click();
  await expect(page.getByText('Demo family loaded.')).toBeVisible();
  await page.getByRole('button', { name: /lock & exit/ }).click();
  await dismissMealReminder(page);
  for (const name of ['Maya', 'Leo', 'Ivy']) {
    await expect(page.getByRole('button', { name: new RegExp(`Open ${name}'s chore chart`) })).toBeVisible();
  }
});

test('a chore ticked on one device shows on another device', async ({ browser }) => {
  const deviceA = await (await browser.newContext()).newPage();
  const deviceB = await (await browser.newContext()).newPage();
  await deviceA.goto('/');
  await deviceB.goto('/');
  await dismissMealReminder(deviceA);
  await dismissMealReminder(deviceB);

  await deviceA.getByRole('button', { name: /Open Maya's chore chart/ }).click();
  const bed = deviceA.getByRole('button', { name: /^Make your bed, 5 points/ });
  await expect(bed).toHaveAttribute('aria-pressed', 'false');
  await bed.click();
  await expect(bed).toHaveAttribute('aria-pressed', 'true');
  await expect(deviceA.getByText(/\+5 points for “Make your bed”/)).toBeVisible();

  // Device B has its own browser storage; it only sees this via the server.
  await deviceB.reload();
  await dismissMealReminder(deviceB);
  await expect(deviceB.getByRole('button', { name: /Open Maya's chore chart\. 1 of \d+ chores done today/ })).toBeVisible();
  await deviceB.getByRole('button', { name: /Open Maya's chore chart/ }).click();
  await expect(deviceB.getByRole('button', { name: /^Make your bed, 5 points/ })).toHaveAttribute('aria-pressed', 'true');

  await deviceA.context().close();
  await deviceB.context().close();
});

test('a stale edit is refused with a clear message instead of overwriting', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  for (const page of [a, b]) {
    await page.goto('/');
    await dismissMealReminder(page);
    await openParentArea(page);
    await page.getByRole('tab', { name: /Children/ }).click();
    await page.getByRole('button', { name: 'Edit Leo' }).click();
  }
  await a.getByLabel('Name or nickname').fill('Leo A');
  await a.getByRole('button', { name: 'Save changes' }).click();
  await expect(a.getByText('Saved Leo A’s profile.')).toBeVisible();

  await b.getByLabel('Name or nickname').fill('Leo B');
  await b.getByRole('button', { name: 'Save changes' }).click();
  await expect(b.getByText(/changed on another device, so your change was not saved/)).toBeVisible();

  await b.reload();
  await dismissMealReminder(b);
  await expect(b.getByRole('button', { name: /Open Leo A's chore chart/ })).toBeVisible();
  await expect(b.getByRole('button', { name: /Open Leo B's chore chart/ })).toHaveCount(0);
  await a.context().close();
  await b.context().close();
});

test('an unreachable server shows a clear screen with "Try again"', async ({ page }) => {
  await page.route('**/api/state', (route) => route.abort('connectionrefused'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Can’t reach the family server' })).toBeVisible();
  await expect(page.getByText('Nothing has been changed.')).toBeVisible();
  await page.unroute('**/api/state');
  await page.getByRole('button', { name: 'Try again' }).click();
  await dismissMealReminder(page);
  await expect(page.getByRole('heading', { name: 'Who’s doing chores?' })).toBeVisible();
});

test('a failed save shows feedback and keeps the last data visible', async ({ page }) => {
  await page.goto('/');
  await dismissMealReminder(page);
  await page.getByRole('button', { name: /Open Ivy's chore chart/ }).click();
  await page.route('**/api/commands', (route) => route.abort('connectionrefused'));
  const chore = page.getByRole('button', { name: /points, not done yet/ }).first();
  await chore.click();
  await expect(page.getByText('Can’t reach the family server. Check that it is running, then try again.').first()).toBeVisible();
  await expect(page.getByText(/You’re seeing the last loaded data/)).toBeVisible();
  await expect(chore).toHaveAttribute('aria-pressed', 'false');
  await page.unroute('**/api/commands');
});

test('export downloads the server data without any PIN', async ({ page }) => {
  await page.goto('/');
  await dismissMealReminder(page);
  await openParentArea(page);
  await page.getByRole('tab', { name: /Settings/ }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export family data/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^chore-chart-export-\d{4}-\d{2}-\d{2}\.json$/);
  const text = readFileSync(await download.path(), 'utf8');
  expect(text).not.toContain('parentPin');
  const file = JSON.parse(text);
  expect(file.app).toBe('smart-family-chore-chart');
  expect(file.data.children.map((c: { name: string }) => c.name)).toEqual(['Maya', 'Leo A', 'Ivy']);
});

test('an invalid file is rejected and nothing changes', async ({ page }) => {
  await page.goto('/');
  await dismissMealReminder(page);
  await openParentArea(page);
  await page.getByRole('tab', { name: /Settings/ }).click();
  await page.getByTestId('import-file').setInputFiles(fixture('not-family-data.json'));
  const dialog = page.getByRole('dialog', { name: 'Import family data' });
  await expect(dialog.getByText('Nothing was imported.')).toBeVisible();
  await expect(dialog).toContainText('not a family data file');
  await dialog.locator('.button-row').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: /lock & exit/ }).click();
  await dismissMealReminder(page);
  await expect(page.getByRole('button', { name: /Open Maya's chore chart/ })).toBeVisible();
});

test('importing v0.3.0 data over a populated server needs explicit confirmation', async ({ page }) => {
  await page.goto('/');
  await dismissMealReminder(page);
  await openParentArea(page);
  await page.getByRole('tab', { name: /Settings/ }).click();
  await page.getByTestId('import-file').setInputFiles(fixture('v030-browser-data.json'));
  const dialog = page.getByRole('dialog', { name: 'Import family data' });
  await expect(dialog).toContainText('Nothing has been changed yet.');
  await expect(dialog).toContainText('Alex (⭐ 5), Bea (⭐ 0)');
  await expect(dialog).toContainText('The old parent PIN in this data is ignored');
  await expect(dialog).toContainText('This server already has family data.');
  const replaceButton = dialog.getByRole('button', { name: 'Replace server data' });
  await expect(replaceButton).toBeDisabled();
  await dialog.getByLabel('Yes, replace all family data on this server').check();
  await expect(replaceButton).toBeEnabled();
  await replaceButton.click();
  await expect(page.getByText(/Family data imported\. The server saved a backup/)).toBeVisible();
  await page.getByRole('button', { name: /lock & exit/ }).click();
  await dismissMealReminder(page);
  await expect(page.getByRole('button', { name: /Open Alex's chore chart/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open Maya's chore chart/ })).toHaveCount(0);
});

test('"Import from this browser" previews this browser’s old data and can be cancelled safely', async ({ page }) => {
  await page.goto('/');
  // Simulate v0.3.0 data saved in this browser at this address.
  const raw = readFileSync(fixture('v030-browser-data.json'), 'utf8').replace('"Test Family"', '"Browser Family"');
  await page.evaluate((value) => localStorage.setItem('smart-family-chore-chart:data', value), raw);
  await page.reload();
  await dismissMealReminder(page);
  await openParentArea(page);
  await page.getByRole('tab', { name: /Settings/ }).click();
  await page.getByRole('button', { name: /Import from this browser/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Import family data' });
  await expect(dialog).toContainText('this browser’s saved data contains');
  await expect(dialog).toContainText('Browser Family');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // Nothing imported; the browser's own data is untouched.
  await page.getByRole('button', { name: /lock & exit/ }).click();
  await dismissMealReminder(page);
  await expect(page.getByText(/Good (morning|afternoon|evening), Test Family!/)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('smart-family-chore-chart:data'))).toBe(raw);
});
