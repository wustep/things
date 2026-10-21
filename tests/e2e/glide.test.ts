/**
 * Closing a thing with Esc flies its picture back into its place on the shelf, every time: right
 * after the click, while it's still flying in, after a shop photo was picked from the strip.
 * Watches the browser's own view transitions: a glide is a `thing-hero` group with something to
 * fly from and somewhere to land (the browser animates that group only when it has both ends).
 * Runs against the built site: `npm run test:e2e` builds first.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { preview, type PreviewServer } from 'vite';

let server: PreviewServer, browser: Browser, ctx: BrowserContext, base: string;

interface Flight { dir: string; glide: boolean; skipped: boolean; stage: string }

before(async () => {
  server = await preview({ logLevel: 'silent', preview: { port: 0, open: false } });
  base = server.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    type Doc = Document & { startViewTransition(cb: () => Promise<void>): { ready: Promise<void> } };
    const doc = document as Doc;
    const start = doc.startViewTransition.bind(doc);
    const log: Flight[] = ((window as unknown as { flights: Flight[] }).flights = []);
    doc.startViewTransition = (cb) => {
      const rec: Flight = { dir: '', glide: false, skipped: false, stage: document.querySelector('.stage-pic')?.className ?? '' };
      log.push(rec);
      const t = start(cb);
      t.ready.then(
        () => {
          const cls = document.documentElement.classList;
          rec.dir = cls.contains('is-closing') ? 'close' : cls.contains('is-opening') ? 'open' : 'other';
          rec.glide = document.getAnimations().some((a) => (a.effect as KeyframeEffect | null)?.pseudoElement === '::view-transition-group(thing-hero)');
        },
        () => (rec.skipped = true),
      );
      return t;
    };
  });
});

after(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.httpServer.close(() => done()));
});

async function shelf(): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  return page;
}

async function closed(page: Page): Promise<Flight[]> {
  await page.waitForFunction(() => (document.querySelector('.detail') as HTMLElement).hidden);
  await page.waitForTimeout(800); // the glide back lands
  return page.evaluate(() => (window as unknown as { flights: Flight[] }).flights);
}

for (const wait of [0, 40, 150, 350, 900]) {
  test(`Esc ${wait}ms after opening a thing flies it back to the shelf`, async () => {
    const page = await shelf();
    await page.locator('a.thing-link').nth(2).click();
    if (wait) await page.waitForTimeout(wait);
    await page.keyboard.press('Escape');
    const flights = await closed(page);
    const close = flights.filter((f) => f.dir === 'close');
    assert.equal(close.length, 1, `one close: ${JSON.stringify(flights)}`);
    assert.ok(close[0].glide, `the picture glides back: ${JSON.stringify(flights)}`);
    assert.ok(!flights.some((f) => f.skipped), `no glide cut short: ${JSON.stringify(flights)}`);
    await page.close();
  });
}

test('Esc on a shop photo flies the thing itself back, not the photo', async () => {
  const page = await shelf();
  const links = page.locator('a.thing-link');
  for (let i = 0; i < 12; i++) {
    await links.nth(i).click();
    await page.waitForTimeout(800);
    if ((await page.locator('.detail .thumb').count()) > 1) break;
    await page.keyboard.press('Escape');
    await closed(page);
  }
  await page.evaluate(() => ((window as unknown as { flights: Flight[] }).flights.length = 0));
  await page.locator('.detail .thumb').nth(1).click();
  await page.waitForTimeout(300);
  assert.match((await page.locator('.detail .stage-pic').getAttribute('class'))!, /is-photo/);
  await page.keyboard.press('Escape');
  const [close] = (await closed(page)).filter((f) => f.dir === 'close');
  assert.ok(close?.glide, 'the picture glides back');
  assert.doesNotMatch(close.stage, /is-photo/, 'the thing’s own picture is the one that flies');
  await page.close();
});

test('Esc while zoomed in flies the picture back at rest', async () => {
  const page = await shelf();
  await page.locator('a.thing-link').nth(2).click();
  await page.waitForTimeout(800);
  await page.keyboard.press('z');
  await page.waitForTimeout(450);
  await page.keyboard.press('Escape');
  const [close] = (await closed(page)).filter((f) => f.dir === 'close');
  assert.ok(close?.glide, 'the picture glides back');
  await page.close();
});
