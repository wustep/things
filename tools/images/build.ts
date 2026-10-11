#!/usr/bin/env tsx
/**
 * The 2D image set: one cohesive cut-out per thing plus a gallery, built from the untouched shop
 * photos in media/originals/<id>/ (see `npm run ingest`). No network except the first run's model
 * download, and no paid APIs.
 *
 *   npm run images                 # every item whose inputs changed since the last run
 *   npm run images -- <id> ...     # just these (always rebuilt)
 *   npm run images -- --force      # everything
 *
 * For each item, the hero photo picked in data/photos.json goes through:
 *   1. Background removal: the photo's own alpha when it has one, otherwise BiRefNet-lite (MIT,
 *      run locally with ONNX), then stray specks dropped and edge colour freed of the old
 *      background so white-studio fringes don't glow on the dark page.
 *   2. Colour: a gentle white balance on neutral pixels, highlights eased to one common white
 *      point and the deepest blacks lifted a touch, so black and white things both read on dark.
 *   3. Framing: trimmed to the object, then the same padding ratio around every one.
 *   4. Shadow: one contact shadow under the footprint and a soft occlusion, the same recipe for
 *      every object.
 *   5. AVIF + WebP at 480/960/1600 px wide (never upscaled).
 * Gallery photos are kept as photographs, resized to 640/1280. Outputs go to
 * public/items/<id>/2d/ and their sizes to data/media.json, which the viewer imports.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINALS = path.join(ROOT, 'media', 'originals');
const PUBLIC_ITEMS = path.join(ROOT, 'public', 'items');
const PICKS_FILE = path.join(ROOT, 'data', 'photos.json');
const MANIFEST_FILE = path.join(ROOT, 'data', 'media.json');
const ITEMS_FILE = path.join(ROOT, 'data', 'items.json');

/** Bump when the processing below changes, so every item is rebuilt once. */
const PIPELINE = 4;
const MODEL = { id: 'onnx-community/BiRefNet_lite-ONNX', revision: 'de15b22ba131738a16dff04aab8bdf8dc32e3ac1' };
/** Work at most this big; the largest output is 1600 px. */
const WORK_SIDE = 2400;
const HERO_WIDTHS = [480, 960, 1600];
const GALLERY_WIDTHS = [640, 1280];
/** Padding around the trimmed object, as a share of its larger side; the bottom leaves room for the shadow. */
const PAD = { side: 0.05, top: 0.05, bottom: 0.09 };

type HeroPick =
  | string
  | {
      file: string;
      mode?: 'cutout' | 'photo';
      crop?: [number, number, number, number];
      /** Also key out backdrop-coloured pixels inside the object (an open frame). Off by default: it would eat white objects. */
      holes?: boolean;
    };
interface Pick {
  hero?: HeroPick;
  gallery?: string[];
}

export interface MediaImage {
  /** Public path without the "-<width>.<ext>" suffix. */
  base: string;
  /** Widths available, ascending. */
  widths: number[];
  width: number;
  height: number;
}
export interface MediaEntry {
  hero: MediaImage & {
    mode: 'cutout' | 'photo';
    /** The object's box inside the hero image, as fractions (left, top, width, height). */
    subject: [number, number, number, number];
    /** Average colour of the object, for placeholders. */
    tone: string;
  };
  gallery: MediaImage[];
  /** Hash of the inputs and pipeline version; unchanged means nothing to do. */
  key: string;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = args.filter((a) => !a.startsWith('-'));

  const items = JSON.parse(await readFile(ITEMS_FILE, 'utf8')) as { id: string }[];
  const picks = JSON.parse(await readFile(PICKS_FILE, 'utf8')) as Record<string, Pick>;
  const manifest: Record<string, MediaEntry> = existsSync(MANIFEST_FILE) ? JSON.parse(await readFile(MANIFEST_FILE, 'utf8')) : {};

  const unknown = only.filter((id) => !items.some((it) => it.id === id));
  if (unknown.length) throw new Error(`not in data/items.json: ${unknown.join(', ')}`);

  let built = 0, kept = 0, failed = 0;
  for (const { id } of items) {
    if (only.length && !only.includes(id)) continue;
    const pick = picks[id] ?? {};
    try {
      const key = await inputKey(id, pick);
      if (!force && !only.length && manifest[id]?.key === key && existsSync(path.join(PUBLIC_ITEMS, id, '2d'))) {
        kept++;
        continue;
      }
      const t0 = Date.now();
      manifest[id] = await buildItem(id, pick, key);
      await saveManifest(manifest, items);
      built++;
      const h = manifest[id].hero;
      console.log(`done  ${id}  ${h.mode} ${h.width}x${h.height}  gallery=${manifest[id].gallery.length}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
      failed++;
      console.error(`fail  ${id}  ${(err as Error).message}`);
    }
  }
  await saveManifest(manifest, items);
  console.log(`\n${built} built, ${kept} unchanged, ${failed} failed → ${path.relative(ROOT, MANIFEST_FILE)}`);
  if (failed) process.exitCode = 1;
}

/** Entries in items.json order, none for items that are gone. */
async function saveManifest(manifest: Record<string, MediaEntry>, items: { id: string }[]) {
  const out: Record<string, MediaEntry> = {};
  for (const { id } of items) if (manifest[id]) out[id] = manifest[id];
  const tmp = `${MANIFEST_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(out, null, 2) + '\n');
  await rename(tmp, MANIFEST_FILE);
}

function heroOf(pick: Pick): { file: string; mode: 'cutout' | 'photo'; crop?: [number, number, number, number]; holes: boolean } {
  const h = pick.hero ?? 'ref-0.jpg';
  return typeof h === 'string'
    ? { file: h, mode: 'cutout', holes: false }
    : { file: h.file, mode: h.mode ?? 'cutout', crop: h.crop, holes: !!h.holes };
}

async function inputKey(id: string, pick: Pick): Promise<string> {
  const hash = createHash('sha1').update(JSON.stringify({ PIPELINE, MODEL, pick }));
  for (const file of [heroOf(pick).file, ...(pick.gallery ?? [])]) hash.update(await readFile(originalPath(id, file)));
  return hash.digest('hex').slice(0, 12);
}

function originalPath(id: string, file: string): string {
  const p = path.join(ORIGINALS, id, file);
  if (!existsSync(p)) throw new Error(`missing original ${path.relative(ROOT, p)} (see data/photos.json)`);
  return p;
}

async function buildItem(id: string, pick: Pick, key: string): Promise<MediaEntry> {
  const hero = heroOf(pick);
  const outDir = path.join(PUBLIC_ITEMS, id, '2d');
  const staging = `${outDir}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const publicBase = `/items/${id}/2d`;
  const v = key.slice(0, 8); // in the file names, so a rebuilt image is never served from a stale cache

  // ---------- hero ----------
  let img = sharp(await readFile(originalPath(id, hero.file))).rotate();
  if (hero.crop) {
    const m = await img.metadata();
    const [l, t, w, h] = hero.crop;
    const W = m.autoOrient?.width ?? m.width!, H = m.autoOrient?.height ?? m.height!;
    img = sharp(await img.extract({ left: Math.round(l * W), top: Math.round(t * H), width: Math.round(w * W), height: Math.round(h * H) }).toBuffer());
  }
  const base = await img
    .resize(WORK_SIDE, WORK_SIDE, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = base.info;
  const rgba = base.data;

  let heroOut: { data: Buffer; width: number; height: number; subject: [number, number, number, number]; tone: string };
  if (hero.mode === 'photo') {
    heroOut = await framePhoto(rgba, W, H);
  } else {
    const alpha = (await existingAlpha(rgba, W, H)) ?? (await segment(rgba, W, H));
    heroOut = await cutout(rgba, alpha, W, H, hero.holes);
  }
  const heroWidths = await encodeSet(
    sharp(heroOut.data, { raw: { width: heroOut.width, height: heroOut.height, channels: 4 } }),
    heroOut.width,
    HERO_WIDTHS,
    path.join(staging, `hero.${v}`),
  );

  // ---------- gallery ----------
  const gallery: MediaImage[] = [];
  for (const [i, file] of (pick.gallery ?? []).entries()) {
    const g = sharp(await readFile(originalPath(id, file))).rotate().flatten({ background: '#ffffff' });
    const { width = 0, height = 0 } = await g.clone().resize(WORK_SIDE, WORK_SIDE, { fit: 'inside', withoutEnlargement: true }).toBuffer({ resolveWithObject: true }).then((r) => r.info);
    const name = `photo-${i + 1}.${v}`;
    const widths = await encodeSet(g, width, GALLERY_WIDTHS, path.join(staging, name));
    const top = widths[widths.length - 1];
    gallery.push({ base: `${publicBase}/${name}`, widths, width: top, height: Math.round((height * top) / width) });
  }

  // Swap the folder in whole; the old one (other hashes) goes away with it.
  await rm(outDir, { recursive: true, force: true });
  await rename(staging, outDir);

  const top = heroWidths[heroWidths.length - 1];
  return {
    hero: {
      base: `${publicBase}/hero.${v}`,
      widths: heroWidths,
      width: top,
      height: Math.round((heroOut.height * top) / heroOut.width),
      mode: hero.mode,
      subject: heroOut.subject.map((n) => +n.toFixed(4)) as [number, number, number, number],
      tone: heroOut.tone,
    },
    gallery,
    key,
  };
}

/** AVIF and WebP at each width up to the source's own; returns the widths written. */
async function encodeSet(img: sharp.Sharp, sourceWidth: number, widths: number[], prefix: string): Promise<number[]> {
  const list = widths.filter((w) => w <= sourceWidth);
  if (list.length === 0 || (sourceWidth < widths[widths.length - 1] && list[list.length - 1] < sourceWidth * 0.9)) list.push(sourceWidth);
  for (const w of list) {
    const sized = img.clone().resize({ width: w, withoutEnlargement: true });
    await sized.clone().avif({ quality: 56, effort: 5 }).toFile(`${prefix}-${w}.avif`);
    await sized.clone().webp({ quality: 82, alphaQuality: 90, effort: 5 }).toFile(`${prefix}-${w}.webp`);
  }
  return list;
}

// ---------- background removal ----------

/** The photo's own transparency, when it really has some (a transparent PNG from the shop). */
async function existingAlpha(rgba: Buffer, W: number, H: number): Promise<Float32Array | undefined> {
  let clear = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) clear++;
  if (clear < W * H * 0.01) return undefined;
  const a = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) a[i] = rgba[i * 4 + 3] / 255;
  return a;
}

type Segmenter = (rgb: Buffer, w: number, h: number) => Promise<Float32Array>;
let segmenter: Promise<Segmenter> | undefined;

/** BiRefNet-lite at its native 1024², mask scaled back to the photo. Loaded once, on first use. */
async function segment(rgba: Buffer, W: number, H: number): Promise<Float32Array> {
  const run = await (segmenter ??= loadSegmenter());
  const { data: rgb } = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .flatten({ background: '#ffffff' })
    .resize(1024, 1024, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask1024 = await run(rgb, 1024, 1024);
  const bytes = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(mask1024[i] * 255);
  const scaled = await sharp(bytes, { raw: { width: 1024, height: 1024, channels: 1 } })
    .resize(W, H, { fit: 'fill', kernel: 'cubic' })
    .extractChannel(0) // sharp hands single-channel raw input back as RGB otherwise
    .raw()
    .toBuffer();
  const a = new Float32Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = scaled[i] / 255;
  return a;
}

async function loadSegmenter(): Promise<Segmenter> {
  const { AutoModel, Tensor, env } = await import('@huggingface/transformers');
  env.cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache');
  console.log(`model ${MODEL.id}@${MODEL.revision.slice(0, 7)} (downloaded once into tools/images/.cache)`);
  const model = await AutoModel.from_pretrained(MODEL.id, { revision: MODEL.revision, dtype: 'fp32' });
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  return async (rgb, w, h) => {
    const n = w * h;
    const input = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) input[c * n + i] = (rgb[i * 3 + c] / 255 - mean[c]) / std[c];
    const out = await model({ input_image: new Tensor('float32', input, [1, 3, h, w]) });
    const logits = (Object.values(out)[0] as { data: Float32Array }).data;
    const mask = new Float32Array(n);
    for (let i = 0; i < n; i++) mask[i] = 1 / (1 + Math.exp(-logits[i]));
    return mask;
  };
}

// ---------- cut-out ----------

async function cutout(rgba: Buffer, alphaIn: Float32Array, W: number, H: number, holes = false) {
  const n = W * H;
  const alpha = new Float32Array(n);
  // Firm up the matte: the model's faint haze goes, edges keep a little softness.
  for (let i = 0; i < n; i++) alpha[i] = smoothstep(0.08, 0.92, alphaIn[i]);
  await debugMask('1-model', alphaIn, W, H);
  const bg = backgroundColour(rgba, alpha, W, H);
  if (holes) {
    // Saliency models fill an open frame's middle in; anything within a few levels of the
    // backdrop goes, with a soft ramp so anti-aliased inner edges stay clean.
    for (let i = 0; i < n; i++) {
      const d = Math.max(Math.abs(rgba[i * 4] - bg[0]), Math.abs(rgba[i * 4 + 1] - bg[1]), Math.abs(rgba[i * 4 + 2] - bg[2]));
      alpha[i] *= smoothstep(6, 22, d);
    }
  }
  dropSpecks(alpha, W, H);
  await debugMask('2-cleaned', alpha, W, H);

  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    for (let c = 0; c < 3; c++) {
      const v = rgba[i * 4 + c];
      // Un-mix the old background out of soft edge pixels (C = aF + (1-a)B).
      rgb[i * 3 + c] = a > 0.02 && a < 0.98 ? clamp((v - (1 - a) * bg[c]) / a, 0, 255) : v;
    }
  }

  normalizeColour(rgb, alpha, n);

  // Trim to the object.
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (alpha[y * W + x] > 0.04) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('nothing left after background removal');
  const sw = x1 - x0 + 1, sh = y1 - y0 + 1;
  const side = Math.max(sw, sh);
  const padX = Math.round(side * PAD.side), padT = Math.round(side * PAD.top), padB = Math.round(side * PAD.bottom);
  const CW = sw + padX * 2, CH = sh + padT + padB;

  // The object, premultiplied-free RGBA on a transparent canvas.
  const object = Buffer.alloc(CW * CH * 4);
  const objAlpha = Buffer.alloc(CW * CH);
  let tr = 0, tg = 0, tb = 0, tw = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const si = (y0 + y) * W + (x0 + x);
    const di = (padT + y) * CW + (padX + x);
    const a = alpha[si];
    object[di * 4] = rgb[si * 3];
    object[di * 4 + 1] = rgb[si * 3 + 1];
    object[di * 4 + 2] = rgb[si * 3 + 2];
    object[di * 4 + 3] = Math.round(a * 255);
    objAlpha[di] = Math.round(a * 255);
    if (a > 0.5) {
      tr += rgb[si * 3]; tg += rgb[si * 3 + 1]; tb += rgb[si * 3 + 2]; tw++;
    }
  }

  // Footprint: where the bottom few percent of the object actually touches down.
  const band = Math.max(2, Math.round(sh * 0.04));
  let fx0 = sw, fx1 = -1;
  for (let y = sh - band; y < sh; y++) for (let x = 0; x < sw; x++) {
    if (alpha[(y0 + y) * W + x0 + x] > 0.5) {
      if (x < fx0) fx0 = x;
      if (x > fx1) fx1 = x;
    }
  }
  if (fx1 < 0) [fx0, fx1] = [0, sw - 1];
  const footW = Math.max(fx1 - fx0 + 1, sw * 0.25);
  const cx = padX + (fx0 + fx1) / 2;
  const groundY = padT + sh;
  const blur = Math.max(1, side * 0.012);
  const contact = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">
      <defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${blur.toFixed(1)}"/></filter></defs>
      <ellipse cx="${cx.toFixed(1)}" cy="${(groundY - side * 0.004).toFixed(1)}" rx="${(footW * 0.56).toFixed(1)}" ry="${Math.max(2, side * 0.018).toFixed(1)}" fill="#000" fill-opacity="0.62" filter="url(#b)"/>
    </svg>`,
  );
  // Soft occlusion: the silhouette itself, blurred and nudged down.
  const occlusion = await sharp(objAlpha, { raw: { width: CW, height: CH, channels: 1 } })
    .blur(Math.max(0.5, side * 0.02))
    .linear(0.32, 0)
    .extractChannel(0)
    .raw()
    .toBuffer();
  const occRgba = Buffer.alloc(CW * CH * 4);
  const shift = Math.round(side * 0.012);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const sy = y - shift;
    occRgba[(y * CW + x) * 4 + 3] = sy >= 0 ? occlusion[sy * CW + x] : 0;
  }

  const data = await sharp({ create: { width: CW, height: CH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: occRgba, raw: { width: CW, height: CH, channels: 4 } },
      { input: contact },
      { input: object, raw: { width: CW, height: CH, channels: 4 } },
    ])
    .raw()
    .toBuffer();

  return {
    data,
    width: CW,
    height: CH,
    subject: [padX / CW, padT / CH, sw / CW, sh / CH] as [number, number, number, number],
    tone: hex(tw ? [tr / tw, tg / tw, tb / tw] : [128, 128, 128]),
  };
}

/** Rectangle treatment for flat art and room shots: the same colour pass, no cut-out, no shadow. */
async function framePhoto(rgba: Buffer, W: number, H: number) {
  const n = W * H;
  const rgb = new Float32Array(n * 3);
  const alpha = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgba[i * 4 + c];
  normalizeColour(rgb, alpha, n);
  const data = Buffer.alloc(n * 4);
  let tr = 0, tg = 0, tb = 0;
  for (let i = 0; i < n; i++) {
    data[i * 4] = rgb[i * 3]; data[i * 4 + 1] = rgb[i * 3 + 1]; data[i * 4 + 2] = rgb[i * 3 + 2]; data[i * 4 + 3] = 255;
    tr += rgb[i * 3]; tg += rgb[i * 3 + 1]; tb += rgb[i * 3 + 2];
  }
  return { data, width: W, height: H, subject: [0, 0, 1, 1] as [number, number, number, number], tone: hex([tr / n, tg / n, tb / n]) };
}

/** Median colour just outside the object: the studio backdrop the edges were mixed with. */
function backgroundColour(rgba: Buffer, alpha: Float32Array, W: number, H: number): [number, number, number] {
  const samples: number[][] = [[], [], []];
  const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 40000)));
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
    const i = y * W + x;
    if (alpha[i] < 0.02) for (let c = 0; c < 3; c++) samples[c].push(rgba[i * 4 + c]);
  }
  if (samples[0].length < 50) return [255, 255, 255];
  return samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1]) as [number, number, number];
}

/**
 * Keep the main object and anything substantial attached to the scene; specks the model picked up
 * in the backdrop (a crumb of shadow, a reflection) go. Pieces under 0.4% of the biggest one are
 * dropped, so the second chair of a pair or a cable stays.
 */
function dropSpecks(alpha: Float32Array, W: number, H: number) {
  const label = new Int32Array(W * H).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (alpha[start] < 0.5 || label[start] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % W, y = (p - x) / W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && label[q] < 0 && alpha[q] >= 0.5) {
          label[q] = id;
          stack.push(q);
        }
      }
    }
    sizes.push(size);
  }
  const biggest = Math.max(0, ...sizes);
  const keep = sizes.map((s) => s >= biggest * 0.004);
  // Soft pixels belong to whichever solid piece is nearby; without one within reach they go too.
  const solidNear = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (label[i] >= 0 && keep[label[i]]) solidNear[i] = 1;
  const reach = Math.max(2, Math.round(Math.max(W, H) * 0.004));
  dilate(solidNear, W, H, reach);
  for (let i = 0; i < W * H; i++) if (!solidNear[i]) alpha[i] = 0;
}

function dilate(m: Uint8Array, W: number, H: number, r: number) {
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let run = -1e9;
    for (let x = 0; x < W; x++) { if (m[y * W + x]) run = x; if (x - run <= r) tmp[y * W + x] = 1; }
    run = 1e9;
    for (let x = W - 1; x >= 0; x--) { if (m[y * W + x]) run = x; if (run - x <= r) tmp[y * W + x] = 1; }
  }
  m.fill(0);
  for (let x = 0; x < W; x++) {
    let run = -1e9;
    for (let y = 0; y < H; y++) { if (tmp[y * W + x]) run = y; if (y - run <= r) m[y * W + x] = 1; }
    run = 1e9;
    for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) run = y; if (run - y <= r) m[y * W + x] = 1; }
  }
}

// ---------- colour ----------

/**
 * Shop photography ranges from blown-out white studios to warm, dim lifestyle sets. Measured on
 * the object only:
 * - white balance: neutral-ish pixels pulled 60% of the way to grey, gains capped at ±6%, so a
 *   warm cast goes but a walnut desk stays walnut;
 * - white point: the brightest 0.5% lands at 238, so white things are bright but don't glare on
 *   the dark page, and dim photos come up (gain capped at 1.18);
 * - black point: true black lifts to 12 with a soft toe, so a black mouse keeps its shape.
 */
function normalizeColour(rgb: Float32Array, alpha: Float32Array, n: number) {
  let sr = 0, sg = 0, sb = 0, sn = 0;
  const lums: number[] = [];
  const step = Math.max(1, Math.floor(n / 250000));
  for (let i = 0; i < n; i += step) {
    if (alpha[i] < 0.6) continue;
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lums.push(l);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (l > 40 && l < 235 && max - min < 0.12 * max) {
      sr += r; sg += g; sb += b; sn++;
    }
  }
  if (lums.length < 100) return;
  lums.sort((a, b) => a - b);
  const p995 = lums[Math.floor(lums.length * 0.995)];

  const gains = [1, 1, 1];
  if (sn > 200) {
    const m = (sr + sg + sb) / 3;
    [sr, sg, sb].forEach((s, c) => (gains[c] = 1 + (m / Math.max(1, s) - 1) * 0.6));
    for (let c = 0; c < 3; c++) gains[c] = clamp(gains[c], 0.94, 1.06);
  }
  const exposure = clamp(238 / Math.max(1, p995), 0.86, 1.18);
  const lift = 12;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      let v = rgb[i * 3 + c] * gains[c] * exposure;
      // Soft shoulder above 225 so highlights roll off instead of clipping.
      if (v > 225) v = 225 + 30 * (1 - Math.exp(-(v - 225) / 30));
      // Toe: lift the deepest shadows, leave midtones alone.
      v = v + lift * Math.pow(1 - Math.min(1, v / 96), 2);
      rgb[i * 3 + c] = clamp(v, 0, 255);
    }
  }
}

// ---------- helpers ----------

/** THINGS_IMAGES_DEBUG=<dir> writes each mask stage as a PNG there. */
async function debugMask(stage: string, a: Float32Array, W: number, H: number) {
  const dir = process.env.THINGS_IMAGES_DEBUG;
  if (!dir) return;
  const bytes = Buffer.alloc(W * H);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(a[i] * 255);
  await mkdir(dir, { recursive: true });
  await sharp(bytes, { raw: { width: W, height: H, channels: 1 } }).png().toFile(path.join(dir, `${stage}-${W}x${H}.png`));
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function hex(c: number[]): string {
  return '#' + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}

// Unused files from older runs (other hashes) disappear with the folder swap; this catches
// folders of items that were removed from the shelf.
async function pruneOrphans(items: { id: string }[]) {
  if (!existsSync(PUBLIC_ITEMS)) return;
  for (const dir of await readdir(PUBLIC_ITEMS)) {
    if (!items.some((it) => it.id === dir) && existsSync(path.join(PUBLIC_ITEMS, dir, '2d'))) {
      await rm(path.join(PUBLIC_ITEMS, dir, '2d'), { recursive: true, force: true });
    }
  }
}

main()
  .then(async () => pruneOrphans(JSON.parse(await readFile(ITEMS_FILE, 'utf8'))))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
