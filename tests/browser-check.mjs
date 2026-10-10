import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const dir = process.env.SCREENSHOT_DIR || '/private/tmp/things-review';
const prefix = process.env.SCREENSHOT_PREFIX || '';
const url = process.env.SITE_URL || 'http://127.0.0.1:5174/';
const source = JSON.parse(await readFile(new URL('../data/items.json', import.meta.url), 'utf8'));
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CI ? {} : { channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' }),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  window.__thingsDraws = 0;
  for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean)) {
    for (const name of ['drawArrays', 'drawElements']) {
      const original = type.prototype[name];
      type.prototype[name] = function (...args) {
        window.__thingsDraws++;
        return original.apply(this, args);
      };
    }
  }
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [],
  audits = [],
  performanceReport = {};
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => {
  await page.screenshot({ path: `${dir}/${prefix}${name}.png` });
};
const ready = async () => {
  await page.locator('#scene-loading').waitFor({ state: 'hidden' });
  await page.waitForTimeout(1800);
};
const audit = async (name) => {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  audits.push({
    name,
    violations: result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })),
  });
};
try {
  await page.goto(url);
  await ready();
  await shot('desktop');
  await audit('desktop');
  await page.waitForTimeout(1300);
  const draws = await page.evaluate(() => window.__thingsDraws);
  await page.waitForTimeout(700);
  performanceReport.idleDraws = (await page.evaluate(() => window.__thingsDraws)) - draws;
  performanceReport.initialModels = await page.evaluate(
    () => performance.getEntriesByType('resource').filter((r) => r.name.includes('.glb')).length,
  );
  expect(performanceReport.idleDraws).toBe(0);
  expect(performanceReport.initialModels).toBeLessThanOrEqual(8);
  // Hover and click an actual raycast target, not just its accessible label.
  const firstLabel = page.locator('#object-labels button').first();
  const label = await firstLabel.boundingBox();
  let hit;
  for (let y = label.y - 80; y < label.y - 10 && !hit; y += 14)
    for (let x = label.x + 25; x < label.x + label.width - 20; x += 18) {
      await page.mouse.move(x, y);
      await page.waitForTimeout(15);
      if (await page.locator('#stage').evaluate((e) => e.classList.contains('is-pointing'))) {
        hit = { x, y };
        break;
      }
    }
  expect(hit).toBeTruthy();
  await shot('hover');
  await page.mouse.click(hit.x, hit.y);
  await expect(page.locator('#detail')).toBeVisible();
  await page.locator('#detail-image').evaluate((img) => img.decode());
  await shot('detail');
  await audit('detail');
  const popupPromise = context.waitForEvent('page');
  await page.locator('#detail-link').click();
  const popup = await popupPromise;
  await popup.waitForURL(/ugmonk/);
  await popup.close();
  await page.keyboard.press('Escape');
  await expect(page.locator('#detail')).not.toBeVisible();
  const canvas = await page.locator('#stage').boundingBox();
  await page.mouse.move(canvas.x + canvas.width * 0.72, canvas.y + canvas.height * 0.58);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * 0.85, canvas.y + canvas.height * 0.68, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('#detail')).not.toBeVisible();
  await page.waitForTimeout(600);
  await shot('orbit');
  await page.getByRole('button', { name: 'Reset view', exact: false }).click();
  await page.waitForTimeout(1700);
  await page.locator('#sections button').filter({ hasText: 'Office' }).click();
  await ready();
  await shot('section');
  await page.locator('#sections button').filter({ hasText: 'All things' }).click();
  await ready();
  // Keyboard inspection and native dialog focus containment.
  await page.locator('#stage').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('#detail')).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('dialog'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('#stage')).toBeFocused();
  await page.getByRole('button', { name: 'Catalog view', exact: true }).click();
  await page
    .locator('#catalog-grid img')
    .evaluateAll((imgs) => Promise.all(imgs.map((i) => i.decode().catch(() => {}))));
  await shot('catalog');
  await audit('catalog');
  await page.getByRole('searchbox').fill('Analog Complete');
  await expect(page.locator('.product-tile')).toHaveCount(1);
  await page.getByRole('searchbox').fill('zzzz-no-product');
  await expect(page.locator('#search-empty')).toBeVisible();
  await page.getByRole('searchbox').fill('');
  // Production edits are exercised only in this isolated browser storage.
  if (
    !(await page.request.get(new URL('__things/ping', url).href)).headers()['content-type']?.startsWith('text/plain')
  ) {
    await page.locator('.product-tile').first().click();
    await page.getByLabel('Section name', { exact: true }).fill('Studio');
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(page.locator('#status')).toContainText('Moved to Studio');
    await page.keyboard.press('Escape');
    await page.reload();
    await ready();
    await page.locator('#sections button').filter({ hasText: 'Studio' }).click();
    await ready();
    await page.locator('#object-labels button').first().click();
    await expect(page.getByLabel('Section name', { exact: true })).toHaveValue('Studio');
    await page.getByRole('button', { name: 'Remove from collection' }).click();
    await expect(page.locator('#status')).toContainText('Removed');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('#status')).toContainText('Back on your shelf');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await ready();
    await page.locator('#object-labels button').first().click();
    await page.getByRole('button', { name: 'Move later', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.reload();
    await ready();
    await expect(page.locator('#object-labels button').nth(1)).toContainText('Analog Complete');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await ready();
  }
  await page.getByRole('button', { name: 'Add a thing', exact: false }).click();
  await page.locator('#product-url').fill('not a URL');
  await page.locator('#ingest-submit').click();
  await expect(page.locator('#ingest-feedback')).toContainText('https://');
  await shot('error');
  await page.locator('#product-url').fill('https://shop.example/product?x=$HOME&y=test');
  await page.locator('#ingest-submit').click();
  if (await page.locator('#static-command').isVisible())
    await expect(page.locator('#ingest-command')).toContainText(
      "--no-mesh 'https://shop.example/product?x=$HOME&y=test'",
    );
  await shot('add');
  await audit('add');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement.blur());
  await page.setViewportSize({ width: 390, height: 844 });
  await ready();
  await shot('phone');
  await audit('phone');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.locator('#object-labels button').first().click();
  await page.locator('#detail-image').evaluate((img) => img.decode());
  await shot('phone-detail');
  await audit('phone-detail');
  await page.keyboard.press('Escape');
  await page.locator('#sections button').filter({ hasText: 'Home' }).click();
  await ready();
  await expect(page.locator('#scene-label')).toHaveText('Home');
  await page.getByRole('button', { name: 'Next shelf', exact: true }).click();
  await ready();
  await expect(page.locator('#page-number')).toHaveText('2 / 3');
  await page.getByRole('button', { name: 'Catalog view', exact: true }).click();
  await expect(page.locator('.product-tile')).toHaveCount(11);
  // Empty collection without changing repository data.
  if (!url.includes(':5173')) {
    await page.evaluate(
      (ids) =>
        localStorage.setItem('things:arrangement:v1:/', JSON.stringify({ hidden: ids, order: [], sections: {} })),
      source.map((i) => i.id),
    );
    await page.reload();
    await expect(page.locator('#empty')).toBeVisible();
    await shot('empty');
    await audit('empty');
    await page.evaluate(() => localStorage.clear());
  }
  const touch = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  const phone = await touch.newPage();
  await phone.goto(url);
  await phone.locator('#scene-loading').waitFor({ state: 'hidden' });
  await phone.waitForTimeout(300);
  await phone.locator('#object-labels button').first().tap();
  await expect(phone.locator('#detail')).toBeVisible();
  await phone.getByRole('button', { name: 'Close details' }).tap();
  await touch.close();
  // Loading and failed assets are visible without blocking navigation or losing items.
  const slowContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await slowContext.route('**/*.glb', async (route) => {
    await gate;
    await route.continue();
  });
  const slow = await slowContext.newPage();
  await slow.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(slow.locator('#scene-loading')).toBeVisible();
  await slow.screenshot({ path: `${dir}/${prefix}loading.png` });
  release();
  await slowContext.close();
  const failedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await failedContext.route(`**/items/${source[0].id}/**`, (route) => route.abort());
  const failedPage = await failedContext.newPage();
  await failedPage.goto(url);
  await expect(failedPage.locator('#status')).toContainText('could not load');
  await failedPage.locator('#object-labels button').first().click();
  await expect(failedPage.locator('#detail-image-fallback')).toBeVisible();
  await failedPage.screenshot({ path: `${dir}/${prefix}asset-error.png` });
  await failedContext.close();
  // WebGL unavailable must leave a useful, working product.
  const fallback = await browser.newContext();
  const fallbackPage = await fallback.newPage();
  await fallbackPage.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type.startsWith('webgl')) return null;
      return get.call(this, type, ...args);
    };
  });
  await fallbackPage.goto(url);
  await expect(fallbackPage.locator('#catalog')).toBeVisible();
  await expect(fallbackPage.locator('.product-tile')).toHaveCount(source.length);
  await fallback.close();
  expect(errors).toEqual([]);
  await writeFile(`${dir}/report.json`, JSON.stringify({ errors, audits, performanceReport }, null, 2));
  const violations = audits.flatMap((a) => a.violations.map((v) => ({ view: a.name, ...v })));
  console.log(JSON.stringify({ errors, violations, performanceReport }, null, 2));
  expect(violations).toEqual([]);
} finally {
  await browser.close();
}
