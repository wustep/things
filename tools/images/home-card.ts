/**
 * The shelf's own link-preview card (what https://things.wustep.me unfurls with): a few real
 * cut-outs standing side by side on one shelf lip in the share cards' dark room (scripts/lib/og-card.ts), at the same
 * believable relative sizes as on the site (largest real dimension, square-root scaled), with the
 * word "Things" in Spectral on the shelf's face below them. No chrome, nothing else.
 *
 *   npm run og
 *
 * Written to public/og/home.<hash>.jpg (1200×630; the hash is of the image, so a changed card is a
 * new URL and previews don't keep a stale copy); older cards are removed. The build's share-pages
 * plugin points the home page's og:image at whichever card is there.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { H, LIP, room, W, type Hero } from '../../scripts/lib/og-card.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT_DIR = path.join(PUBLIC, 'og');

/** Left to right: a mix of sections, tall and small, so it reads as a shelf of things at a glance. */
const LINEUP = [
  'peakdesign-8f476d14', // Roller Pro Carry-On
  'dwr-c60bfcc5', // Nelson Cigar Lotus Floor Lamp
  'boss-1b124b07', // RC-505mkII
  'us-nothing-db5358fa', // Headphone (1)
  'amazon-3f443256', // Owala FreeSip
  'steelcase-41758f2b', // Series 1 chair
];
const SIDE = 80; // margin left and right
const GAP = 44; // between things
const TALLEST = 360; // px above the lip, at most
const SCALE_EXPONENT = 0.5; // as src/media.ts

async function cutout(hero: Hero): Promise<{ data: Buffer; width: number; height: number }> {
  const top = Math.max(...hero.widths);
  const src = sharp(await readFile(path.join(PUBLIC, `${hero.base}-${top}.webp`)));
  const { width = 0, height = 0 } = await src.metadata();
  const [l, t, w, h] = hero.subject;
  const left = Math.max(0, Math.floor(l * width)), topPx = Math.max(0, Math.floor(t * height));
  const box = { left, top: topPx, width: Math.min(width - left, Math.ceil(w * width)), height: Math.min(height - topPx, Math.ceil(h * height)) };
  const data = await src.extract(box).png().toBuffer();
  return { data, width: box.width, height: box.height };
}

/** "Things" in the site's Spectral, set by the browser (sharp's text can't load a web font). */
async function wordmark(): Promise<Buffer> {
  const font = await readFile(path.join(ROOT, 'node_modules/@fontsource/spectral/files/spectral-latin-300-normal.woff2'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 200 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>
      @font-face { font-family: Spectral; font-weight: 300; src: url(data:font/woff2;base64,${font.toString('base64')}) format('woff2'); }
      html, body { margin: 0; background: transparent; }
      span { display: inline-block; padding: 4px 8px; font: 300 40px/1 Spectral; letter-spacing: 0.01em; color: #e9e1d3; }
    </style><span>Things</span>`);
    await page.evaluate(() => document.fonts.ready);
    return await page.locator('span').screenshot({ omitBackground: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'data', 'media.json'), 'utf8')) as Record<string, { hero: Hero }>;
  const sizes = JSON.parse(await readFile(path.join(ROOT, 'data', 'sizes.json'), 'utf8')) as Record<string, number>;
  const things = await Promise.all(
    LINEUP.map(async (id) => {
      const hero = manifest[id]?.hero;
      const cm = sizes[id];
      if (!hero || !cm) throw new Error(`no hero or size for ${id}`);
      const c = await cutout(hero);
      const rel = Math.pow(cm, SCALE_EXPONENT) / Math.max(c.width, c.height); // px per source px, before the common factor
      return { id, ...c, rel };
    }),
  );
  // One factor for all, the largest that fits the row's width and the tallest height.
  const widthAt1 = things.reduce((s, t) => s + t.width * t.rel, 0);
  const tallestAt1 = Math.max(...things.map((t) => t.height * t.rel));
  const k = Math.min((W - 2 * SIDE - GAP * (things.length - 1)) / widthAt1, TALLEST / tallestAt1);
  const placed = await Promise.all(
    things.map(async (t) => {
      const w = Math.round(t.width * t.rel * k), h = Math.round(t.height * t.rel * k);
      return { input: await sharp(t.data).resize(w, h, { kernel: 'lanczos3' }).png().toBuffer(), w, h };
    }),
  );
  const rowWidth = placed.reduce((s, p) => s + p.w, 0) + GAP * (placed.length - 1);
  let x = Math.round((W - rowWidth) / 2);
  const layers: sharp.OverlayOptions[] = [];
  for (const p of placed) {
    layers.push({ input: p.input, left: x, top: LIP - p.h + 2 });
    x += p.w + GAP;
  }
  const mark = await wordmark();
  const m = await sharp(mark).metadata();
  layers.push({ input: mark, left: Math.round((W - (m.width ?? 0)) / 2), top: Math.round(LIP + (H - LIP) / 2 - (m.height ?? 0) / 2 + 4) });
  const jpg = await sharp(await room.toBuffer())
    .composite(layers)
    .flatten({ background: '#13110e' })
    .jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const name = `home.${createHash('sha1').update(jpg).digest('hex').slice(0, 8)}.jpg`;
  await mkdir(OUT_DIR, { recursive: true });
  for (const f of await readdir(OUT_DIR)) if (/^home\.[0-9a-f]+\.jpg$/.test(f) && f !== name) await rm(path.join(OUT_DIR, f));
  await writeFile(path.join(OUT_DIR, name), jpg);
  console.log(`og  /og/${name}  ${W}×${H}  ${LINEUP.length} things`);
}

await main();
