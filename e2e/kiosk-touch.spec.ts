import { expect, test, type Page } from '@playwright/test';

// Touchscreen kiosk behaviour in a real Chrome at the portrait kiosk size
// (browser-only build, sample family). Touch input is synthesised with the
// DevTools protocol: this checks the browser's own touch scrolling, not a
// physical touchscreen, which still needs testing on the device itself.
test.use({ baseURL: 'http://localhost:4177', viewport: { width: 1080, height: 1920 }, hasTouch: true });

const LONG = 'Unload and reorganise the dishwasher now';

async function openMayaChart(page: Page, query = '') {
  await page.goto(`/${query}`);
  // Long chore names, so the chart is taller than the screen.
  await page.evaluate((long) => {
    const key = 'smart-family-chore-chart:data';
    const data = JSON.parse(localStorage.getItem(key)!);
    const maya = data.children[0].id;
    data.chores.filter((c: { childId: string }) => c.childId === maya)[0].title = long;
    localStorage.setItem(key, JSON.stringify(data));
  }, LONG);
  await page.reload();
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible().catch(() => false)) await later.click();
  await page.getByRole('button', { name: /Open Maya's chore chart/ }).click();
  await expect(page.getByRole('heading', { name: 'Maya’s chores' })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
}

const choreStates = (page: Page) => page.$$eval('button.chore', (bs) => bs.map((b) => b.getAttribute('aria-pressed')).join(','));
const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

async function touchDrag(page: Page, x: number, fromY: number, toY: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: fromY + ((toY - fromY) * i) / 10 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
}

test('the chore chart scrolls when a finger drags, starting on a chore or on the background, and ticks nothing', async ({ page }) => {
  await openMayaChart(page);
  expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
  const before = await choreStates(page);

  const chore = await page.locator('button.chore').nth(3).boundingBox();
  await touchDrag(page, chore!.x + 40, chore!.y + chore!.height / 2, chore!.y + chore!.height / 2 - 500);
  expect(await scrollY(page)).toBeGreaterThan(100);
  expect(await choreStates(page)).toBe(before);

  await page.evaluate(() => window.scrollTo(0, 0));
  await touchDrag(page, 540, 700, 200); // starts on a period heading
  expect(await scrollY(page)).toBeGreaterThan(100);
  expect(await choreStates(page)).toBe(before);
});

test('a tap still ticks a chore, and a second tap unticks it', async ({ page }) => {
  await openMayaChart(page);
  const bed = page.getByRole('button', { name: new RegExp(`^${LONG}, 5 points`) });
  const before = await bed.getAttribute('aria-pressed');
  await bed.tap();
  await expect(bed).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
  await bed.tap();
  await expect(bed).toHaveAttribute('aria-pressed', before ?? 'false');
});

test('scrollbars are hidden but the page still scrolls (nothing is clipped)', async ({ page }) => {
  await openMayaChart(page);
  const styles = await page.evaluate(() => ({
    scrollbarWidth: getComputedStyle(document.documentElement).scrollbarWidth,
    overflowY: getComputedStyle(document.documentElement).overflowY,
    bodyOverflowY: getComputedStyle(document.body).overflowY,
    gutter: window.innerWidth - document.documentElement.clientWidth,
  }));
  expect(styles).toEqual({ scrollbarWidth: 'none', overflowY: 'visible', bodyOverflowY: 'visible', gutter: 0 });
  await page.mouse.wheel(0, 600); // mouse wheel
  await expect.poll(() => scrollY(page)).toBeGreaterThan(100);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.keyboard.press('End'); // keyboard
  await expect.poll(() => scrollY(page)).toBeGreaterThan(100);
});

test('long chore names wrap inside their column and never sit under the points', async ({ page }) => {
  await openMayaChart(page);
  const chores = page.locator('button.chore');
  for (let i = 0; i < (await chores.count()); i++) {
    const title = await chores.nth(i).locator('.chore-title').boundingBox();
    const points = await chores.nth(i).locator('.chore-points').boundingBox();
    const box = await chores.nth(i).boundingBox();
    // Points are below the title, and the title stays inside the chore.
    expect(points!.y).toBeGreaterThanOrEqual(title!.y + title!.height - 1);
    expect(title!.x + title!.width).toBeLessThanOrEqual(box!.x + box!.width);
    // Real text overflow (scrollWidth) would mean clipping.
    expect(await chores.nth(i).locator('.chore-title').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
});

test('home page profile cards and names are compact at the kiosk size', async ({ page }) => {
  await page.goto('/');
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible().catch(() => false)) await later.click();
  const card = page.getByRole('button', { name: /Open Maya's chore chart/ });
  const name = card.locator('.profile-name');
  const fontPx = await name.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const rootPx = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect(fontPx / rootPx).toBeCloseTo(2.75, 2); // was 3.5rem
  const height = (await card.boundingBox())!.height;
  expect(height).toBeGreaterThanOrEqual(48); // still a big touch target
  expect(height).toBeLessThan(290); // was about 300px
});

test.describe('opt-in drag-to-scroll for touchscreens reported as a mouse (?dragscroll=1)', () => {
  async function mouseDrag(page: Page, x: number, fromY: number, toY: number) {
    await page.mouse.move(x, fromY);
    await page.mouse.down();
    await page.mouse.move(x, toY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(100);
  }

  test('off by default: a mouse drag does not scroll', async ({ page }) => {
    await openMayaChart(page);
    const box = (await page.locator('button.chore').nth(3).boundingBox())!;
    await mouseDrag(page, box.x + 40, box.y + 40, box.y - 460);
    expect(await scrollY(page)).toBe(0);
  });

  test('on: a mouse drag scrolls and ticks nothing; a plain click still ticks', async ({ page }) => {
    await openMayaChart(page, '?dragscroll=1');
    const before = await choreStates(page);
    const box = (await page.locator('button.chore').nth(3).boundingBox())!;
    await mouseDrag(page, box.x + 40, box.y + 40, box.y - 460);
    expect(await scrollY(page)).toBeGreaterThan(300);
    expect(await choreStates(page)).toBe(before);
    expect(await page.evaluate(() => String(window.getSelection()))).toBe('');

    const bed = page.getByRole('button', { name: new RegExp(`^${LONG}, 5 points`) });
    const was = await bed.getAttribute('aria-pressed');
    await bed.click();
    await expect(bed).toHaveAttribute('aria-pressed', was === 'true' ? 'false' : 'true');
  });
});
