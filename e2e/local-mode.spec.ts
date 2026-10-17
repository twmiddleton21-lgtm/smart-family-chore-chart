import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The default build keeps the released v0.3.0 behaviour: browser-local data
// and the client-side PIN gate. This guards against regressions.
test.use({ baseURL: 'http://localhost:4177' });

test('local mode: sample family, PIN gate, chore toggle and export without PIN', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/Development (build|mode)|Pre-release build/)).toHaveCount(0);
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible().catch(() => false)) await later.click();
  await expect(page.getByRole('button', { name: /Open Maya's chore chart/ })).toBeVisible();

  await page.getByRole('button', { name: /Open Maya's chore chart/ }).click();
  const bed = page.getByRole('button', { name: /^Make your bed, 5 points/ });
  const before = await bed.getAttribute('aria-pressed');
  await bed.click();
  await expect(bed).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
  // Saved in this browser: survives a reload (the app reopens on the dashboard).
  await page.reload();
  if (await later.isVisible().catch(() => false)) await later.click();
  await page.getByRole('button', { name: /Open Maya's chore chart/ }).click();
  await expect(page.getByRole('button', { name: /^Make your bed, 5 points/ })).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');

  await page.getByRole('button', { name: /All profiles/ }).click();
  await page.getByRole('button', { name: /Parent area/ }).first().click();
  await expect(page.getByLabel('Enter the parent PIN')).toBeVisible();
  await page.getByLabel('Enter the parent PIN').fill('1234');
  await page.getByLabel('Enter the parent PIN').press('Enter');
  await page.getByRole('tab', { name: /Settings/ }).click();
  await expect(page.getByRole('heading', { name: 'Parent PIN' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Import from a file/ })).toHaveCount(0);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export family data/ }).click();
  const text = readFileSync(await (await downloadPromise).path(), 'utf8');
  expect(text).not.toContain('parentPin');
  expect(JSON.parse(text)).toMatchObject({ app: 'smart-family-chore-chart', source: 'browser' });
});
