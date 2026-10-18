/**
 * The Software case: apps Stephen uses every day, each shown by its official icon (standing on the
 * shelf like a small desk object) with the maker's own screenshots in the gallery.
 *
 *   npm run software -- samples/2026-10-software.json
 *   npm run images                                   # then their 2D set (heroes as icons)
 *
 * An app page isn't a product page, so this doesn't go through the shop ingest. Each entry of the
 * batch file says everything instead:
 *
 *   {
 *     "url": "https://www.raycast.com", "title": "Raycast", "brand": "Raycast",
 *     "price": "Free", "platforms": ["macOS"], "description": "…",
 *     "icon": { "app": "/Applications/Raycast.app" },      // or { "url": "…png", "mask": true }
 *     "shots": ["https://…/screenshot-1.png", { "video": "https://…/tour.mp4", "at": 13.5 }]
 *   }
 *
 * `icon.app` takes the icon macOS shows for the installed app (scripts/lib/app-icon.swift), in the
 * default light style whatever the Mac's own icon style is. `icon.url` downloads one; `mask` is
 * for an App Store icon, which comes as a full square, and gives it the rounded-square outline it
 * has on the phone. A shot is an image URL, or a frame of the maker's own video (ffmpeg) where
 * the site only shows the app in motion. Writes media/originals/<id>/ (icon.png, shot-N.<ext>, sources.json),
 * public/items/<id>/primary.png, and the item's entries in items.json, photos.json and sizes.json.
 * A thing's note and when it was added are kept on a re-run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanLink } from '../shared/links.ts';
import { wholeDollars } from '../shared/text.ts';
import type { Item, Platform } from '../shared/types.ts';
import { buildProceduralAsset } from './lib/asset.ts';
import { fetchBinary } from './lib/fetch.ts';
import { idFor } from './lib/ids.ts';
import { decode, processPrimary } from './lib/images.ts';
import { stageAssets, writeFileAtomic } from './lib/store.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.THINGS_ROOT ? path.resolve(process.env.THINGS_ROOT) : path.resolve(HERE, '..');
const ITEMS_FILE = path.join(ROOT, 'data', 'items.json');
const PICKS_FILE = path.join(ROOT, 'data', 'photos.json');
const SIZES_FILE = path.join(ROOT, 'data', 'sizes.json');
const ORIGINALS = path.join(ROOT, 'media', 'originals');
const PUBLIC_ITEMS = path.join(ROOT, 'public', 'items');

export const SECTION = 'Software';
/** An app icon stands about as big as a small desk object (a card stand, a pen cup): an 8 cm tile. */
export const ICON_CM = 8;

export interface SoftwareEntry {
  url: string;
  title: string;
  brand?: string;
  price?: string;
  platforms: Platform[];
  description?: string;
  icon: { app: string } | { url: string; mask?: boolean };
  shots: (string | { video: string; at: number })[];
}

interface Source {
  file: string;
  url: string;
  width: number;
  height: number;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: npm run software -- <batch.json>');
  const entries = JSON.parse(await readFile(path.resolve(file), 'utf8')) as SoftwareEntry[];
  const items = JSON.parse(await readFile(ITEMS_FILE, 'utf8')) as Item[];
  const picks = JSON.parse(await readFile(PICKS_FILE, 'utf8')) as Record<string, unknown>;
  const sizes = JSON.parse(await readFile(SIZES_FILE, 'utf8')) as Record<string, unknown>;

  let failed = 0;
  for (const entry of entries) {
    const url = cleanLink(entry.url);
    const id = idFor(url);
    console.log(`app   ${id}  ${entry.title}`);
    try {
      const { item, gallery } = await buildApp(id, url, entry, items.find((it) => it.id === id));
      const at = items.findIndex((it) => it.id === id);
      if (at >= 0) items[at] = item;
      else items.push(item);
      picks[id] = {
        hero: { file: 'icon.png', icon: true },
        gallery,
      };
      if (typeof sizes[id] !== 'number') sizes[id] = ICON_CM;
      // Written after each app, so a failure later in the batch keeps the ones before it.
      await writeFileAtomic(ITEMS_FILE, JSON.stringify(items, null, 2) + '\n');
      await writeFileAtomic(PICKS_FILE, picksJson(picks));
      await writeFileAtomic(SIZES_FILE, JSON.stringify(sizes, null, 2) + '\n');
      console.log(`done  ${id}  icon + ${entry.shots.length} shots`);
    } catch (err) {
      failed++;
      console.error(`fail  ${id}  ${(err as Error).message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

async function buildApp(id: string, url: string, entry: SoftwareEntry, existing?: Item): Promise<{ item: Item; gallery: string[] }> {
  if (!entry.shots.length) throw new Error('no screenshots');
  const sources: Source[] = [];

  // Originals: the icon and the screenshots, exactly as they came.
  const icon = await iconFor(entry);
  await stageAssets(path.join(ORIGINALS, id), async (dir) => {
    const img = await decode(icon.png);
    await writeFile(path.join(dir, 'icon.png'), icon.png);
    sources.push({ file: 'icon.png', url: icon.source, width: img.bitmap.width, height: img.bitmap.height });
    for (const [i, shot] of entry.shots.entries()) {
      const buffer = typeof shot === 'string' ? (await fetchBinary(shot, url)).buffer : videoFrame(shot.video, shot.at);
      const name = `shot-${i + 1}.${formatOf(buffer)}`;
      const s = await decode(buffer);
      await writeFile(path.join(dir, name), buffer);
      const source = typeof shot === 'string' ? shot : `${shot.video} (frame at ${shot.at}s)`;
      sources.push({ file: name, url: source, width: s.bitmap.width, height: s.bitmap.height });
    }
    await writeFile(path.join(dir, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
  });

  // The quick cut-out the viewer falls back to before `npm run images` (and the /3d archive's card).
  const primary = await processPrimary(icon.png);
  const publicDir = `/items/${id}`;
  await stageAssets(path.join(PUBLIC_ITEMS, id), async (dir) => {
    await writeFile(path.join(dir, 'primary.png'), primary.png);
  });
  // A flat tile: always a card, never printed on a carton.
  const asset = { ...buildProceduralAsset({ title: entry.title, texture: `${publicDir}/primary.png`, aspect: primary.aspect, palette: primary.palette, removedFraction: primary.removedFraction }), shape: 'card' as const };

  const item: Item = {
    id,
    url,
    domain: new URL(url).hostname.replace(/^www\./, ''),
    title: entry.title,
    ...(entry.brand ? { brand: entry.brand } : {}),
    ...(entry.price ? { price: wholeDollars(entry.price) } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    section: SECTION,
    platforms: entry.platforms,
    ...(existing?.aliases ? { aliases: existing.aliases } : {}),
    images: [`${publicDir}/primary.png`],
    asset,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    ...(existing?.commentary ? { commentary: existing.commentary } : {}),
  };
  return { item, gallery: sources.filter((src) => src.file.startsWith('shot-')).map((src) => src.file) };
}

/** The app's icon as a transparent PNG, and where it came from. */
async function iconFor(entry: SoftwareEntry): Promise<{ png: Buffer; source: string }> {
  if ('app' in entry.icon) {
    const app = entry.icon.app;
    if (!existsSync(path.join(app, 'Contents', 'Info.plist'))) throw new Error(`${app} is not installed`);
    return { png: drawnByMacOS(app), source: `${path.basename(app)}: the icon macOS shows for it (default style), 1024 px` };
  }
  const { buffer } = await fetchBinary(entry.icon.url);
  return { png: entry.icon.mask ? await roundedSquare(buffer) : buffer, source: entry.icon.url + (entry.icon.mask ? ' (rounded-square outline applied)' : '') };
}

/** The installed app's icon as macOS draws it, at 1024 px. */
function drawnByMacOS(app: string): Buffer {
  const out = path.join(os.tmpdir(), `things-icon-${process.pid}.png`);
  try {
    execFileSync('swift', [path.join(HERE, 'lib', 'app-icon.swift'), app, out, '-AppleIconAppearanceTheme', 'RegularLight', '-AppleInterfaceStyle', 'Light']);
    return readFileSync(out);
  } finally {
    rmSync(out, { force: true });
  }
}

/** One frame of a video, as PNG. */
function videoFrame(video: string, at: number): Buffer {
  return execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 64 * 1024 * 1024 });
}

/**
 * An App Store icon is a full square; on the phone it is a rounded square with continuous corners.
 * A superellipse (|x|^5 + |y|^5 = 1) is that outline to within a pixel at this size; the edge is
 * anti-aliased by 4×4 supersampling.
 */
async function roundedSquare(buffer: Buffer): Promise<Buffer> {
  const img = await decode(buffer);
  const { width: w, height: h, data } = img.bitmap;
  const n = 5, ss = 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let inside = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const u = Math.abs(((x + (sx + 0.5) / ss) / w) * 2 - 1);
      const v = Math.abs(((y + (sy + 0.5) / ss) / h) * 2 - 1);
      if (u ** n + v ** n <= 1) inside++;
    }
    const i = (y * w + x) * 4 + 3;
    data[i] = Math.round((data[i] * inside) / (ss * ss));
  }
  return img.getBuffer('image/png');
}

/** photos.json as it is kept by hand: one line per thing. */
function picksJson(picks: Record<string, unknown>): string {
  const inline = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(inline).join(', ')}]`
      : v && typeof v === 'object'
        ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`
        : JSON.stringify(v);
  return `{\n${Object.entries(picks).map(([k, v]) => `  ${JSON.stringify(k)}: ${inline(v)}`).join(',\n')}\n}\n`;
}

/** The file's real format from its first bytes (a CDN may serve WebP at a .png address). */
function formatOf(buffer: Buffer): string {
  if (buffer.subarray(0, 4).toString('hex') === '89504e47') return 'png';
  if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff') return 'jpg';
  if (buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.subarray(4, 12).toString('ascii').startsWith('ftypavi')) return 'avif';
  throw new Error('not a PNG, JPEG, WebP or AVIF image');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
