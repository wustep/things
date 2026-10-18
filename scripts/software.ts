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
 * default light style whatever the Mac's own icon style is; `own` takes the app's own artwork
 * from its bundle where macOS 26 would set it on a grey plate (with `inset`, below, where that
 * artwork is drawn a little off the grid). `icon.url` downloads one; `mask` is
 * for an App Store icon, which comes as a full square, and gives it the rounded-square outline it
 * has on the phone, and `inset` sets it into the macOS icon grid as well, so it stands as big as
 * the icons macOS draws. `icon.mark` is for a tool with no app icon of its own (a CLI): the
 * maker's vector mark on a plate of its colour, as its site's icon shows it, in that same grid.
 * A shot is an image URL, or a frame of the maker's own video (ffmpeg) where
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
import { decode, encodePng, processPrimary } from './lib/images.ts';
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
  icon: { app: string; own?: boolean; inset?: boolean } | { url: string; mask?: boolean; inset?: boolean } | { mark: string; plate: string; scale: number };
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
    const { app, own, inset } = entry.icon;
    if (!existsSync(path.join(app, 'Contents', 'Info.plist'))) throw new Error(`${app} is not installed`);
    const how = own ? 'its own icon artwork from the bundle' : 'the icon macOS shows for it (default style)';
    const png = drawnByMacOS(app, own);
    return { png: inset ? await inMacGrid(png) : png, source: `${path.basename(app)}: ${how}, 1024 px${inset ? ', in the macOS icon grid' : ''}` };
  }
  if ('mark' in entry.icon) {
    const { mark, plate, scale } = entry.icon;
    const svg = path.join(os.tmpdir(), `things-mark-${process.pid}.svg`);
    try {
      await writeFile(svg, (await fetchBinary(mark)).buffer);
      return { png: await inMacGrid(await onPlate(drawnByMacOS(svg), plate, scale)), source: `${mark} (on a ${plate} plate at ${scale}, in the macOS icon grid)` };
    } finally {
      rmSync(svg, { force: true });
    }
  }
  const { url, mask, inset } = entry.icon;
  const { buffer } = await fetchBinary(url);
  if (inset) return { png: await inMacGrid(buffer), source: `${url} (in the macOS icon grid)` };
  return { png: mask ? await roundedSquare(buffer) : buffer, source: url + (mask ? ' (rounded-square outline applied)' : '') };
}

/** The installed app's icon as macOS draws it (or its own artwork, or an SVG), at 1024 px. */
function drawnByMacOS(app: string, own = false): Buffer {
  const out = path.join(os.tmpdir(), `things-icon-${process.pid}.png`);
  try {
    execFileSync('swift', [path.join(HERE, 'lib', 'app-icon.swift'), app, out, ...(own ? ['--own'] : []), '-AppleIconAppearanceTheme', 'RegularLight', '-AppleInterfaceStyle', 'Light']);
    return readFileSync(out);
  } finally {
    rmSync(out, { force: true });
  }
}

/** A mark (transparent, 1024 px) centred on a square plate of one colour, at `scale` of its side. */
async function onPlate(markPng: Buffer, plate: string, scale: number): Promise<Buffer> {
  const mark = await decode(markPng);
  const side = Math.round(1024 * scale);
  mark.resize({ w: side, h: side });
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(plate.slice(i, i + 2), 16));
  const out = Buffer.alloc(1024 * 1024 * 4);
  for (let i = 0; i < out.length; i += 4) out.set([r, g, b, 255], i);
  over(out, 1024, mark.bitmap.data, side, (1024 - side) >> 1, (1024 - side) >> 1);
  return encodePng(out, 1024, 1024);
}

/**
 * A full-square icon set into the macOS icon grid, so it stands next to the ones macOS draws: an
 * 824 px rounded square centred on a 1024 px canvas, with the soft shadow below it (black at 25%,
 * blurred by σ 14, 8 px down: what macOS's own icons measure).
 */
async function inMacGrid(buffer: Buffer): Promise<Buffer> {
  const BODY = 824, AT = (1024 - BODY) / 2;
  const img = await decode(await roundedSquare(await opaquePart(buffer)));
  img.resize({ w: BODY, h: BODY });
  const body = img.bitmap.data;
  const shadow = new Float32Array(1024 * 1024);
  for (let y = 0; y < BODY; y++) for (let x = 0; x < BODY; x++) shadow[(y + AT + 8) * 1024 + x + AT] = body[(y * BODY + x) * 4 + 3] / 255;
  // Three box blurs of radius 14 come within a hair of a gaussian of σ 14.
  for (let pass = 0; pass < 3; pass++) boxBlur(shadow, 1024, 14);
  const out = Buffer.alloc(1024 * 1024 * 4);
  for (let i = 0; i < shadow.length; i++) out[i * 4 + 3] = Math.round(shadow[i] * 0.25 * 255);
  over(out, 1024, body, BODY, AT, AT);
  return encodePng(out, 1024, 1024);
}

/** An icon cropped to its body (alpha over half), so artwork drawn with its own margin and shadow fills the grid like a full square. */
async function opaquePart(buffer: Buffer): Promise<Buffer> {
  const img = await decode(buffer);
  const { width: w, height: h, data } = img.bitmap;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] <= 128) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (x1 < 0 || (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1)) return buffer;
  return img.crop({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }).getBuffer('image/png');
}

/** Paints a square RGBA image over another at (x0, y0), source-over. */
function over(dst: Buffer, dstSide: number, src: Buffer, srcSide: number, x0: number, y0: number) {
  for (let y = 0; y < srcSide; y++) for (let x = 0; x < srcSide; x++) {
    const s = (y * srcSide + x) * 4, d = ((y + y0) * dstSide + x + x0) * 4;
    const sa = src[s + 3] / 255, da = dst[d + 3] / 255, a = sa + da * (1 - sa);
    if (!a) continue;
    for (let c = 0; c < 3; c++) dst[d + c] = Math.round((src[s + c] * sa + dst[d + c] * da * (1 - sa)) / a);
    dst[d + 3] = Math.round(a * 255);
  }
}

/** A box blur of radius r over a square field, horizontally then vertically. */
function boxBlur(field: Float32Array, side: number, r: number) {
  const line = new Float32Array(side);
  for (const [step, stride] of [[1, side], [side, 1]]) {
    for (let k = 0; k < side; k++) {
      const start = k * stride;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += field[start + Math.min(side - 1, Math.max(0, i)) * step];
      for (let i = 0; i < side; i++) {
        line[i] = sum / (2 * r + 1);
        sum += field[start + Math.min(side - 1, i + r + 1) * step] - field[start + Math.max(0, i - r) * step];
      }
      for (let i = 0; i < side; i++) field[start + i * step] = line[i];
    }
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
