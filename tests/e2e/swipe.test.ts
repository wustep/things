/**
 * Swipes in the detail view through Chromium's real touch-gesture path
 * (Input.synthesizeScrollGesture), so the browser's touch-action arbitration decides who gets the
 * gesture, as on a phone. Raw touch events skip that step and miss bugs like a pan the browser
 * takes for itself (pointercancel). Runs against the built site: `npm run test:e2e` builds first.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, devices, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { preview, type PreviewServer } from 'vite';

const PHONE = devices['Pixel 7'];
let server: PreviewServer, browser: Browser, ctx: BrowserContext, base: string, order: string[];

before(async () => {
  server = await preview({ logLevel: 'silent', preview: { port: 0, open: false } });
  base = server.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch();
  ctx = await browser.newContext({ ...PHONE, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  order = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('a.thing-link')).map((a) => new URL(a.href).pathname));
  await page.close();
});

after(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.httpServer.close(() => done()));
});

async function open(path: string): Promise<{ page: Page; cdp: CDPSession }> {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('.detail:not([hidden]) .stage img'));
  await page.waitForTimeout(400); // the strip's overflow is measured after layout
  return { page, cdp };
}

/** The middle of an element in the detail view. */
async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const r = await page.locator(`.detail ${selector}`).first().boundingBox();
  assert.ok(r, `${selector} is on the page`);
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}

async function gesture(page: Page, cdp: CDPSession, at: { x: number; y: number }, dx: number, dy = 0) {
  await cdp.send('Input.synthesizeScrollGesture', {
    x: at.x, y: at.y, xDistance: dx, yDistance: dy, speed: 800, gestureSourceType: 'touch', preventFling: true,
  });
  await page.waitForTimeout(700);
}

const at = (page: Page) => page.evaluate(() => location.pathname);
const neighbour = (path: string, delta: number) => order[(order.indexOf(path) + delta + order.length) % order.length];

/** A thing whose detail view has the given strip state on this phone. */
async function findThing(scrollable: boolean): Promise<string> {
  for (const path of order) {
    const { page } = await open(path);
    const state = await page.evaluate(() => document.querySelector('.thumbs')?.classList.contains('is-scrollable'));
    await page.close();
    if (state === scrollable) return path;
  }
  throw new Error(`no thing with a ${scrollable ? 'scrolling' : 'still'} photo strip`);
}

for (const [dx, delta, way] of [[-240, 1, 'left'], [240, -1, 'right']] as const) {
  for (const [where, selector] of [['the photo', '.stage img'], ['the title', 'h1']] as const) {
    test(`a swipe ${way} that starts on ${where} steps to the ${delta > 0 ? 'next' : 'previous'} thing`, async () => {
      const path = '/t/apple-magic-keyboard-with-touch-id';
      const { page, cdp } = await open(path);
      await gesture(page, cdp, await centre(page, selector), dx);
      assert.equal(await at(page), neighbour(path, delta));
      await page.close();
    });
  }

  test(`a swipe ${way} that starts on a photo strip that fits steps too`, async () => {
    const path = await findThing(false);
    const { page, cdp } = await open(path);
    await gesture(page, cdp, await centre(page, '.thumbs'), dx);
    assert.equal(await at(page), neighbour(path, delta));
    await page.close();
  });
}

test('a photo strip with more to show scrolls itself, and steps once it is at its end', async () => {
  const path = await findThing(true);
  const { page, cdp } = await open(path);
  const strip = await centre(page, '.thumbs');
  // At its start, a swipe right has nothing to scroll: it steps back.
  await gesture(page, cdp, strip, 240);
  assert.equal(await at(page), neighbour(path, -1));
  await page.close();

  const again = await open(path);
  await gesture(again.page, again.cdp, strip, -200);
  assert.equal(await at(again.page), path, 'swiping left scrolls the strip instead');
  assert.ok((await again.page.evaluate(() => document.querySelector('.thumbs')!.scrollLeft)) > 0);
  await again.page.close();
});

test('a vertical drag that starts on the photo scrolls the page and never steps', async () => {
  // A thing whose page is long enough to scroll on this phone.
  for (const path of order) {
    const { page, cdp } = await open(path);
    const range = await page.evaluate(() => { const d = document.querySelector('.detail')!; return d.scrollHeight - d.clientHeight; });
    if (range < 120) {
      await page.close();
      continue;
    }
    await gesture(page, cdp, await centre(page, '.stage img'), 25, -300);
    assert.equal(await at(page), path);
    assert.ok((await page.evaluate(() => document.querySelector('.detail')!.scrollTop)) > 50, 'the page scrolled');
    await page.close();
    return;
  }
  assert.fail('no detail page long enough to scroll');
});
