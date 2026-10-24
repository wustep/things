/**
 * Every thing has its own address, and the address and the view stay in step: a shared link opens
 * its thing on first load (its own page, with its own title and preview tags), opening a thing
 * from the shelf moves to its address, and Back and Forward close and reopen it, gliding.
 * Runs against the built site, served as the host serves it: `npm run test:e2e` builds first.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { preview, type PreviewServer } from 'vite';
import { slugsFor } from '../../shared/slug.ts';
import { titleWithoutBrand } from '../../shared/text.ts';
import type { Item } from '../../shared/types.ts';

const items = JSON.parse(readFileSync('data/items.json', 'utf8')) as Item[];
const slugs = slugsFor(items);
let server: PreviewServer, browser: Browser, ctx: BrowserContext, base: string;

interface Flight { dir: string; glide: boolean }

before(async () => {
  server = await preview({ logLevel: 'silent', preview: { port: 0, open: false } });
  base = server.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    type Doc = Document & { startViewTransition(cb: () => Promise<void>): { ready: Promise<void> } };
    const doc = document as Doc;
    if (!doc.startViewTransition) return;
    const start = doc.startViewTransition.bind(doc);
    const log: Flight[] = ((window as unknown as { flights: Flight[] }).flights = []);
    doc.startViewTransition = (cb) => {
      const rec: Flight = { dir: '', glide: false };
      log.push(rec);
      const t = start(cb);
      t.ready.then(() => {
        const cls = document.documentElement.classList;
        rec.dir = cls.contains('is-closing') ? 'close' : cls.contains('is-opening') ? 'open' : 'other';
        rec.glide = document.getAnimations().some((a) => (a.effect as KeyframeEffect | null)?.pseudoElement === '::view-transition-group(thing-hero)');
      }, () => {});
      return t;
    };
  });
});

after(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.httpServer.close(() => done()));
});

const titleOf = (item: Item) => `${titleWithoutBrand(item.title, item.brand)} · Things`;

/** The thing open in the detail view (by its stage picture), or null when the shelf shows. */
async function openThing(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const d = document.querySelector('.detail') as HTMLElement;
    if (d.hidden) return null;
    return document.querySelector('.stage-pic img')?.getAttribute('src')?.match(/\/items\/([^/]+)\//)?.[1] ?? 'unknown';
  });
}

const flights = (page: Page) => page.evaluate(() => (window as unknown as { flights: Flight[] }).flights.splice(0));
const settled = (page: Page) => page.waitForTimeout(900); // a glide lands

// A tall one, a wide one, an app and a renamed thing's old slug.
const picks = ['dwr-c60bfcc5', 'revivalrugs-86802fd7', 'raycast-3be38941'].map((id) => items.find((i) => i.id === id)!);
const renamed = items.find((i) => i.aliases?.length)!;

for (const item of picks) {
  test(`a shared link opens its thing on first load: /t/${slugs.get(item.id)}`, async () => {
    const page = await ctx.newPage();
    const res = await page.goto(`${base}/t/${slugs.get(item.id)}`, { waitUntil: 'networkidle' });
    assert.equal(res?.status(), 200);
    assert.match(res!.headers()['content-type'] ?? '', /^text\/html/);
    // The page itself, before any script: its own title and preview tags, absolute URLs.
    const html = await res!.text();
    assert.ok(html.includes(`<title>${titleOf(item).replace(/&/g, '&amp;')}</title>`), 'own <title>');
    assert.match(html, new RegExp(`<link rel="canonical" href="https://things\\.wustep\\.me/t/${slugs.get(item.id)}" />`));
    assert.match(html, new RegExp(`<meta property="og:image" content="https://things\\.wustep\\.me/og/${item.id}\\.[0-9a-f]{8}\\.jpg" />`));
    assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
    const card = html.match(/og:image" content="https:\/\/things\.wustep\.me(\/og\/[^"]+)"/)![1];
    const img = await page.request.get(base + card);
    assert.equal(img.status(), 200);
    assert.equal(img.headers()['content-type'], 'image/jpeg');
    // And the app opens the thing.
    await page.waitForFunction(() => !(document.querySelector('.detail') as HTMLElement).hidden);
    assert.equal(await openThing(page), item.id);
    assert.equal(await page.title(), titleOf(item));
    // Closing goes to the shelf's own address.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (document.querySelector('.detail') as HTMLElement).hidden);
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(await page.title(), 'Things');
    await page.close();
  });
}

test('the item id and an old slug open the same thing, and an old slug moves on to the new one', async () => {
  const page = await ctx.newPage();
  await page.goto(`${base}/t/${renamed.id}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !(document.querySelector('.detail') as HTMLElement).hidden);
  assert.equal(await openThing(page), renamed.id);
  await page.goto(`${base}/t/${renamed.aliases![0]}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !(document.querySelector('.detail') as HTMLElement).hidden);
  assert.equal(await openThing(page), renamed.id);
  assert.equal(new URL(page.url()).pathname, `/t/${slugs.get(renamed.id)}`);
  await page.close();
});

test('a link to a thing that is gone falls back to the shelf', async () => {
  const page = await ctx.newPage();
  const res = await page.goto(`${base}/t/no-such-thing`, { waitUntil: 'networkidle' });
  assert.equal(res?.status(), 200);
  await page.waitForTimeout(300);
  assert.equal(await openThing(page), null);
  assert.equal(new URL(page.url()).pathname, '/');
  await page.close();
});

test('opening from the shelf moves to its address; Back closes it, Forward reopens it, both gliding', async () => {
  const page = await ctx.newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  const link = page.locator('a.thing-link').nth(3);
  const id = (await link.getAttribute('data-id'))!;
  const item = items.find((i) => i.id === id)!;
  const path = `/t/${slugs.get(id)}`;
  assert.equal(new URL((await link.getAttribute('href'))!, base).pathname, path, 'the shelf links to the address');
  await link.click();
  await page.waitForURL((u) => u.pathname === path);
  await settled(page);
  assert.equal(await openThing(page), id);
  assert.equal(await page.title(), titleOf(item));
  assert.deepEqual((await flights(page)).map((f) => [f.dir, f.glide]), [['open', true]]);
  const depth = await page.evaluate(() => history.length);

  for (let round = 0; round < 2; round++) {
    await page.goBack();
    await page.waitForFunction(() => (document.querySelector('.detail') as HTMLElement).hidden);
    await settled(page);
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(await page.title(), 'Things');
    assert.deepEqual((await flights(page)).map((f) => [f.dir, f.glide]), [['close', true]], `Back glides home (round ${round})`);

    await page.goForward();
    await page.waitForFunction(() => !(document.querySelector('.detail') as HTMLElement).hidden);
    await settled(page);
    assert.equal(new URL(page.url()).pathname, path);
    assert.equal(await openThing(page), id);
    assert.deepEqual((await flights(page)).map((f) => [f.dir, f.glide]), [['open', true]], `Forward glides out (round ${round})`);
  }

  // Closing after Forward goes Back too: no extra shelf entries pile up.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (document.querySelector('.detail') as HTMLElement).hidden);
  await settled(page);
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(await page.evaluate(() => history.length), depth);
  assert.deepEqual((await flights(page)).map((f) => [f.dir, f.glide]), [['close', true]]);
  await page.close();
});

test('stepping to the next thing swaps the address in place, so Back still goes to the shelf', async () => {
  const page = await ctx.newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.locator('a.thing-link').nth(0).click();
  await settled(page);
  const first = await openThing(page);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((f) => !document.querySelector(`.stage-pic img[src*="/items/${f}/"]`), first);
  await settled(page);
  const second = (await openThing(page))!;
  assert.notEqual(second, first);
  assert.equal(new URL(page.url()).pathname, `/t/${slugs.get(second)}`);
  await page.goBack();
  await page.waitForFunction(() => (document.querySelector('.detail') as HTMLElement).hidden);
  assert.equal(new URL(page.url()).pathname, '/');
  await page.close();
});
