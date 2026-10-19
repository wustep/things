/**
 * Share cards: one 1200×630 JPEG per thing, for link previews (Open Graph). The thing's cut-out
 * stands on a shelf lip in the same dark room as the site, in a pool of lamplight, and nothing
 * else: the preview's own title line carries the name.
 *
 *   npm run images           (runs this after the 2D set is built)
 *   tsx tools/images/share.ts [--force] [id...]
 *
 * Written to public/items/<id>/share.<v>.jpg, where <v> is the hero's version (from
 * data/media.json), so a rebuilt hero gets a new card and the old one is removed. It sits beside
 * the 2d/ folder rather than in it, because rebuilding an item replaces that folder whole.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const MANIFEST_FILE = path.join(ROOT, 'data', 'media.json');

export const W = 1200, H = 630;
/** The shelf line, and the box the thing must fit in above it. */
export const LIP = 520;
const FIT = { w: 900, h: 400 };

export interface Hero {
  base: string;
  widths: number[];
  subject: [number, number, number, number];
}

/** The room, as on the site (style.css: --night, --lamp, the shelf lip), drawn once. */
export const room = sharp(
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="pool">
      <stop offset="0" stop-color="#ffd59e" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#ffd59e" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="wall"><rect width="${W}" height="${LIP}"/></clipPath>
    <radialGradient id="corners" cx="50%" cy="45%" r="75%">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.4"/>
    </radialGradient>
    <linearGradient id="lip" x1="0" x2="1">
      <stop offset="0" stop-color="#3d362d" stop-opacity="0"/>
      <stop offset="0.08" stop-color="#3d362d"/>
      <stop offset="0.92" stop-color="#3d362d"/>
      <stop offset="1" stop-color="#3d362d" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="face" x1="0" x2="1">
      <stop offset="0" stop-color="#221e19" stop-opacity="0"/>
      <stop offset="0.08" stop-color="#221e19"/>
      <stop offset="0.92" stop-color="#221e19"/>
      <stop offset="1" stop-color="#221e19" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#13110e"/>
  <ellipse cx="${W / 2}" cy="${LIP}" rx="560" ry="360" fill="url(#pool)" clip-path="url(#wall)"/>
  <rect y="${LIP}" width="${W}" height="14" fill="url(#face)"/>
  <rect y="${LIP}" width="${W}" height="1.5" fill="url(#lip)"/>
  <rect width="${W}" height="${H}" fill="url(#corners)"/>
</svg>`),
).png();

export function shareFile(hero: Pick<Hero, 'base'>): string {
  const m = hero.base.match(/^\/items\/([^/]+)\/2d\/hero\.([0-9a-f]+)$/);
  if (!m) throw new Error(`unexpected hero base ${hero.base}`);
  return `/items/${m[1]}/share.${m[2]}.jpg`;
}

async function card(hero: Hero): Promise<Buffer> {
  const top = Math.max(...hero.widths);
  const src = sharp(await readFile(path.join(PUBLIC, `${hero.base}-${top}.webp`)));
  const { width = 0, height = 0 } = await src.metadata();
  // Just the object (the hero's padding trimmed), scaled to stand on the lip.
  const [l, t, w, h] = hero.subject;
  const box = {
    left: Math.max(0, Math.floor(l * width)),
    top: Math.max(0, Math.floor(t * height)),
    width: Math.min(width, Math.ceil(w * width)),
    height: Math.min(height, Math.ceil(h * height)),
  };
  box.width = Math.min(box.width, width - box.left);
  box.height = Math.min(box.height, height - box.top);
  const scale = Math.min(FIT.w / box.width, FIT.h / box.height);
  const thing = await src
    .extract(box)
    .resize(Math.round(box.width * scale), Math.round(box.height * scale), { kernel: 'lanczos3' })
    .png()
    .toBuffer({ resolveWithObject: true });
  return sharp(await room.toBuffer())
    .composite([{ input: thing.data, left: Math.round((W - thing.info.width) / 2), top: LIP - thing.info.height + 2 }])
    .flatten({ background: '#13110e' })
    .jpeg({ quality: 84, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = args.filter((a) => !a.startsWith('-'));
  const manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8')) as Record<string, { hero: Hero }>;
  let made = 0, kept = 0;
  for (const [id, { hero }] of Object.entries(manifest)) {
    if (only.length && !only.includes(id)) continue;
    const rel = shareFile(hero);
    const out = path.join(PUBLIC, rel);
    // Cards for an older hero go.
    const dir = path.dirname(out);
    for (const f of await readdir(dir)) if (/^share\.[0-9a-f]+\.jpg$/.test(f) && f !== path.basename(out)) await rm(path.join(dir, f));
    if (!force && existsSync(out)) {
      kept++;
      continue;
    }
    await sharp(await card(hero)).toFile(out);
    made++;
    console.log(`share ${id}`);
  }
  console.log(`\n${made} share cards made, ${kept} unchanged`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
