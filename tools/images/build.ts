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
 *   1. Background removal: the photo's own alpha when it has one, otherwise BiRefNet_HR (MIT,
 *      run locally with ONNX at 2048², see matte.ts) with its edge refined by a guided filter at
 *      the working size, then per-item backdrop keying (holes), stray specks dropped, and the
 *      object's own colour estimated in the edge band (and sharpening halos removed) so
 *      white-studio fringes don't glow on the dark page.
 *   2. Colour: a gentle white balance on neutral pixels, highlights eased to one common white
 *      point and the deepest blacks lifted a touch, so black and white things both read on dark.
 *   3. Framing: trimmed to the object, then the same padding ratio around every one. No shadow
 *      is baked in: things sit straight on the shelf.
 *   4. AVIF + WebP at 480/960/1600 px wide (never upscaled).
 * Gallery photos are kept as photographs, resized to 640/1280. Outputs go to
 * public/items/<id>/2d/ and their sizes to data/media.json, which the viewer imports.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { dilate, foreground, MODELS, refine, segment, type MatteModel } from './matte.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINALS = path.join(ROOT, 'media', 'originals');
const PUBLIC_ITEMS = path.join(ROOT, 'public', 'items');
const PICKS_FILE = path.join(ROOT, 'data', 'photos.json');
const MANIFEST_FILE = path.join(ROOT, 'data', 'media.json');
const ITEMS_FILE = path.join(ROOT, 'data', 'items.json');

/** Bump when the processing below changes, so every item is rebuilt once. */
const PIPELINE = 7;
/** Work at most this big (the matte is refined here), then scale down; the largest output is 1600 px. */
const WORK_SIDE = 3072;
const HERO_WIDTHS = [480, 960, 1600];
const GALLERY_WIDTHS = [640, 1280];
/** Padding around the trimmed object, as a share of its larger side. No shadow: things sit straight on the shelf. */
const PAD = { side: 0.05, top: 0.05, bottom: 0.05 };

type HeroPick =
  | string
  | {
      file: string;
      mode?: 'cutout' | 'photo';
      crop?: [number, number, number, number];
      /**
       * Also key out backdrop-coloured pixels inside the object (an open frame). true: anything
       * within a few levels of the backdrop, soft ramp (it would eat a white object). 'exact': only
       * sizeable patches that are the backdrop colour itself, so a white object on a white
       * backdrop keeps its body and loses the backdrop seen through it. 'through': like 'exact', but
       * only patches thick enough to be an opening you see through (a ring's middle); thinner ones
       * are glare on chrome or gloss, the backdrop reflected, and stay (the Loop earplugs). 'clear': for clear acrylic
       * or glass on a white backdrop, how far each pixel is from the backdrop becomes the matte
       * (together with the model's), so the backdrop seen through it goes and thin clear edges the
       * model missed come back. 'grow': for a shaded backdrop the model kept in a gap (between two
       * cards), the cleared backdrop spreads into neighbours that keep its hue and change only
       * gradually, so it stops at the object's edges. 'fill': the other way round, for a model that
       * keyed out light parts enclosed by the object (chrome tines on a kalimba's wood): anything
       * the backdrop can't reach from the photo's edge becomes solid again. 'glass': clear
       * acrylic or glass holding solid things, on a white backdrop, shown on the dark shelf (the
       * record stand): the solid things stay as the model drew them; everything else is the clear
       * material, as opaque as it darkened the backdrop (its edges and bends) and drawn in a light
       * neutral, the way clear edges catch the light in a dim room. Flat panels that only show the
       * backdrop go, so there is no milky fill and no glare slabs. Off by default.
       */
      holes?: boolean | 'exact' | 'through' | 'clear' | 'grow' | 'fill' | 'glass';
      /** Which model draws the matte: 'general' (default, solid and crisp) or 'matting' (keeps partial alpha: clear acrylic, glass). */
      matte?: MatteModel;
      /**
       * A rug: the photo is the rug from straight above, and it is laid down on the shelf in
       * perspective (seen from the same low three-quarter angle as the furniture), with a sliver of
       * pile along its front edge.
       */
      lay?: boolean;
      /** Flat art to show framed: the picture (after crop) goes into a thin black frame and stands like an object. */
      frame?: boolean;
      /**
       * An app's official icon (a transparent PNG): its own alpha and its own colours, exactly as
       * drawn (no white balance or defringe, which would shift a brand colour), minus the soft drop
       * shadow macOS icons carry, so the tile sits on the shelf line instead of floating above it.
       */
      icon?: boolean;
      /**
       * The object's bottom edge as [x, y] points (fractions of the photo after crop, left to
       * right); everything below the line through them is cleared. For a floor reflection under a
       * base seen at an angle, which a rectangular crop can't take off without clipping the base.
       */
      floor?: [number, number][];
    };
/** A gallery photo; crop is [left, top, width, height] in fractions, as for the hero (trim a frame's backdrop edge). */
type GalleryPick = string | { file: string; crop?: [number, number, number, number] };
interface Pick {
  hero?: HeroPick;
  gallery?: GalleryPick[];
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

type Holes = boolean | 'exact' | 'through' | 'clear' | 'grow' | 'fill' | 'glass';

function heroOf(pick: Pick): { file: string; mode: 'cutout' | 'photo'; crop?: [number, number, number, number]; holes: Holes; matte: MatteModel; lay: boolean; frame: boolean; icon: boolean; floor?: [number, number][] } {
  const h = pick.hero ?? 'ref-0.jpg';
  return typeof h === 'string'
    ? { file: h, mode: 'cutout', holes: false, matte: 'general', lay: false, frame: false, icon: false }
    : {
        file: h.file,
        mode: h.mode ?? 'cutout',
        crop: h.crop,
        holes: h.holes === 'exact' || h.holes === 'through' || h.holes === 'clear' || h.holes === 'grow' || h.holes === 'fill' || h.holes === 'glass' ? h.holes : !!h.holes,
        matte: h.matte === 'matting' ? 'matting' : 'general',
        lay: !!h.lay,
        frame: !!h.frame,
        icon: !!h.icon,
        floor: h.floor,
      };
}

async function inputKey(id: string, pick: Pick): Promise<string> {
  const hash = createHash('sha1').update(JSON.stringify({ PIPELINE, model: MODELS[heroOf(pick).matte].sha256, pick }));
  for (const file of [heroOf(pick).file, ...(pick.gallery ?? []).map((g) => galleryOf(g).file)]) hash.update(await readFile(originalPath(id, file)));
  return hash.digest('hex').slice(0, 12);
}

function galleryOf(g: GalleryPick): { file: string; crop?: [number, number, number, number] } {
  return typeof g === 'string' ? { file: g } : g;
}

/** crop: [left, top, width, height] in fractions of the (auto-oriented) photo. */
async function cropTo(img: sharp.Sharp, crop: [number, number, number, number]): Promise<sharp.Sharp> {
  const m = await img.metadata();
  const [l, t, w, h] = crop;
  const W = m.autoOrient?.width ?? m.width!, H = m.autoOrient?.height ?? m.height!;
  const left = Math.round(l * W), top = Math.round(t * H);
  return sharp(await img.extract({ left, top, width: Math.min(W - left, Math.round(w * W)), height: Math.min(H - top, Math.round(h * H)) }).toBuffer());
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
  if (hero.crop) img = await cropTo(img, hero.crop);
  const base = await img
    .resize(WORK_SIDE, WORK_SIDE, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = base.info;
  const rgba = base.data;

  let heroOut: { data: Buffer; width: number; height: number; subject: [number, number, number, number]; tone: string };
  if (hero.frame) {
    const framed = withFrame(rgba, W, H);
    heroOut = await cutout(framed.rgba, framed.alpha, framed.W, framed.H, false, true);
  } else if (hero.mode === 'photo') {
    heroOut = await framePhoto(rgba, W, H);
  } else if (hero.icon) {
    const own = await existingAlpha(rgba, W, H);
    if (!own) throw new Error(`icon ${hero.file} has no transparency`);
    heroOut = await cutout(rgba, own, W, H, false, true, false, undefined, true);
  } else {
    const own = await existingAlpha(rgba, W, H);
    heroOut = await cutout(rgba, own ?? (await segment(rgba, W, H, hero.matte)), W, H, hero.holes, !!own, hero.lay, hero.floor);
  }
  const heroWidths = await encodeSet(
    sharp(heroOut.data, { raw: { width: heroOut.width, height: heroOut.height, channels: 4 } }),
    heroOut.width,
    HERO_WIDTHS,
    path.join(staging, `hero.${v}`),
  );

  // ---------- gallery ----------
  const gallery: MediaImage[] = [];
  for (const [i, entry] of (pick.gallery ?? []).entries()) {
    const { file, crop } = galleryOf(entry);
    let photo = sharp(await readFile(originalPath(id, file))).rotate();
    if (crop) photo = await cropTo(photo, crop);
    const g = photo.flatten({ background: '#ffffff' });
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

/**
 * holes: 'glass'. Splits the photo into solid things and clear material. Solid is where the model is
 * sure (alpha >= 0.97) in blobs too thick to be a clear edge line: an opening (erode, then dilate)
 * drops the thin lines, and the blobs grow back over their own soft edges. Everything else is clear
 * material, as opaque as it darkened the white backdrop, with a soft floor so flat panels that only
 * show the backdrop vanish. Rewrites alpha in place; returns the clear-material mask.
 */
function glassMatte(rgba: Buffer, alpha: Float32Array, bg: number[], W: number, H: number): Uint8Array {
  const n = W * H;
  const r = Math.max(2, Math.round(Math.max(W, H) / 400));
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = alpha[i] >= 0.97 ? 1 : 0;
  // Opening: erode (dilate the complement), then dilate back.
  const holes = new Uint8Array(n);
  for (let i = 0; i < n; i++) holes[i] = solid[i] ? 0 : 1;
  dilate(holes, W, H, r);
  for (let i = 0; i < n; i++) solid[i] = holes[i] ? 0 : 1;
  dilate(solid, W, H, r + 1);
  const glass = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (solid[i] && alpha[i] >= 0.5) continue;
    const d = Math.max(Math.abs(rgba[i * 4] - bg[0]), Math.abs(rgba[i * 4 + 1] - bg[1]), Math.abs(rgba[i * 4 + 2] - bg[2]));
    alpha[i] = 0.92 * smoothstep(6, 70, d);
    glass[i] = 1;
  }
  return glass;
}

// ---------- cut-out ----------

async function cutout(rgba: Buffer, alphaIn: Float32Array, W0: number, H0: number, holes: Holes = false, own = false, lay = false, floor?: [number, number][], icon = false) {
  let W = W0, H = H0;
  const n = W * H;
  await debugMask('1-model', alphaIn, W, H);
  // The model's edge follows the photo's own (a shop's own alpha is left as drawn), then its faint
  // haze over the backdrop goes and near-solid reads solid; partial cover (mesh, acrylic) stays.
  const refined = own ? alphaIn : refine(rgba, alphaIn, W, H);
  let alpha: Float32Array = new Float32Array(n);
  let glass: Uint8Array | null = null;
  for (let i = 0; i < n; i++) alpha[i] = own ? alphaIn[i] : clamp((refined[i] - 0.04) / 0.92, 0, 1);
  await debugMask('1b-refined', alpha, W, H);
  const bg = backgroundColour(rgba, alpha, W, H);
  if (holes === 'exact') keyBackdropPatches(rgba, alpha, bg, W, H);
  else if (holes === 'through') keyBackdropPatches(rgba, alpha, bg, W, H, 3, Math.round(Math.max(W, H) * 0.02));
  else if (holes === 'grow') growBackdrop(rgba, alpha, bg, W, H);
  else if (holes === 'fill') fillEnclosed(alpha, W, H);
  else if (holes === 'clear') {
    // Clear material only shows as how much it bends or dims the backdrop: that difference is its
    // opacity. Solid things the model found stay solid, less the backdrop patches seen through them.
    // Partial cover the model saw (best with matte: 'matting') is capped the same way, so clear
    // panels that show the backdrop unchanged show the shelf instead of a milky haze.
    keyBackdropPatches(rgba, alpha, bg, W, H, 6);
    for (let i = 0; i < n; i++) {
      const d = Math.max(Math.abs(rgba[i * 4] - bg[0]), Math.abs(rgba[i * 4 + 1] - bg[1]), Math.abs(rgba[i * 4 + 2] - bg[2]));
      const seen = alpha[i] >= 0.995 ? alpha[i] : Math.min(alpha[i], smoothstep(2, 30, d));
      alpha[i] = Math.max(seen, smoothstep(3, 40, d));
    }
  }
  else if (holes === 'glass') glass = glassMatte(rgba, alpha, bg, W, H);
  else if (holes) {
    // Saliency models fill an open frame's middle in; anything within a few levels of the
    // backdrop goes, with a soft ramp so anti-aliased inner edges stay clean.
    for (let i = 0; i < n; i++) {
      const d = Math.max(Math.abs(rgba[i * 4] - bg[0]), Math.abs(rgba[i * 4 + 1] - bg[1]), Math.abs(rgba[i * 4 + 2] - bg[2]));
      alpha[i] *= smoothstep(6, 22, d);
    }
  }
  dropSpecks(alpha, W, H);
  await debugMask('2-cleaned', alpha, W, H);

  // The object's own colour in the edge band, with the backdrop it was mixed with taken out. A
  // shop's transparent PNG already stores it that way.
  let rgb: Float32Array = own ? Float32Array.from({ length: n * 3 }, (_, k) => rgba[(k / 3 | 0) * 4 + (k % 3)]) : foreground(rgba, alpha, W, H);
  if (glass) {
    // The clear material in a light neutral with the faintest cool cast, as acrylic edges read in a dim room.
    for (let i = 0; i < n; i++) if (glass[i]) { rgb[i * 3] = 222; rgb[i * 3 + 1] = 229; rgb[i * 3 + 2] = 233; }
  }
  if (!own && holes !== 'clear' && holes !== 'glass') {
    // An edge pixel is a mix of the object and the backdrop (I = aF + (1-a)B), so it can't be more
    // opaque than its colour allows: one that is the backdrop's own colour beside a dark object is
    // backdrop (a sliver of studio white the model kept above a strap loop, a smear at the photo's
    // edge). Only lowers alpha, and only where the object differs clearly from the backdrop, so a
    // white thing on white keeps its edge.
    for (let i = 0; i < n; i++) {
      const a = alpha[i];
      if (a <= 0 || a >= 0.98) continue;
      let den = 0, dot = 0;
      for (let c = 0; c < 3; c++) {
        const fb = rgb[i * 3 + c] - bg[c];
        den += fb * fb;
        dot += (rgba[i * 4 + c] - bg[c]) * fb;
      }
      if (den < 48 * 48) continue;
      alpha[i] = Math.min(a, clamp((dot / den) * 1.1 + 0.04, 0, 1));
    }
    await debugMask('3-consistent', alpha, W, H);
  }

  if (floor) clearBelow(alpha, W, H, floor);
  if (icon) {
    // The tile is opaque; the drop shadow under it is the only faint alpha, so a ramp just above
    // its strength takes it off and keeps the tile's anti-aliased edge.
    for (let i = 0; i < n; i++) alpha[i] = clamp((alpha[i] - 0.4) / 0.35, 0, 1);
  } else {
    defringe(rgb, alpha, W, H);
    normalizeColour(rgb, alpha, n);
  }
  if (lay) ({ rgb, alpha, W, H } = layFlat(rgb, alpha, W, H));

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

  // The object, premultiplied-free RGBA on a transparent canvas, and nothing else: no baked shadow.
  const data = Buffer.alloc(CW * CH * 4);
  let tr = 0, tg = 0, tb = 0, tw = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const si = (y0 + y) * W + (x0 + x);
    const di = (padT + y) * CW + (padX + x);
    const a = alpha[si];
    data[di * 4] = rgb[si * 3];
    data[di * 4 + 1] = rgb[si * 3 + 1];
    data[di * 4 + 2] = rgb[si * 3 + 2];
    data[di * 4 + 3] = Math.round(a * 255);
    if (a > 0.5) {
      tr += rgb[si * 3]; tg += rgb[si * 3 + 1]; tb += rgb[si * 3 + 2]; tw++;
    }
  }

  return {
    data,
    width: CW,
    height: CH,
    subject: [padX / CW, padT / CH, sw / CW, sh / CH] as [number, number, number, number],
    tone: hex(tw ? [tr / tw, tg / tw, tb / tw] : [128, 128, 128]),
  };
}

/**
 * lay: a rug photographed from straight above, laid down on the shelf: the far edge narrower than
 * the near one (taper) and the depth foreshortened (tilt), by a true perspective mapping so the
 * pattern recedes evenly, plus a sliver of pile in the near edge's average colour, darkened, below it.
 */
function layFlat(rgb: Float32Array, alpha: Float32Array, W: number, H: number) {
  const TILT = 0.3, TAPER = 0.8;
  // The rug's own box first, so the backdrop around it doesn't take part.
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (alpha[y * W + x] > 0.5) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return { rgb, alpha, W, H };
  const sw = x1 - x0 + 1, sh = y1 - y0 + 1;
  const depth = Math.max(2, Math.round(sh * TILT));
  const pile = Math.max(2, Math.round(sw * 0.012));
  const OW = sw, OH = depth + pile;
  const outRgb = new Float32Array(OW * OH * 3);
  const outA = new Float32Array(OW * OH);
  const sample = (fx: number, fy: number, c: number) => {
    const xa = Math.max(0, Math.min(sw - 1, fx)), ya = Math.max(0, Math.min(sh - 1, fy));
    const xi = Math.min(sw - 2, Math.floor(xa)), yi = Math.min(sh - 2, Math.floor(ya));
    const tx = xa - xi, ty = ya - yi;
    const at = (x: number, y: number) => {
      const i = (y0 + y) * W + x0 + x;
      return c < 3 ? rgb[i * 3 + c] * alpha[i] : alpha[i];
    };
    return (at(xi, yi) * (1 - tx) + at(xi + 1, yi) * tx) * (1 - ty) + (at(xi, yi + 1) * (1 - tx) + at(xi + 1, yi + 1) * tx) * ty;
  };
  // Two samples per pixel across, so the far edge, squeezed, doesn't alias.
  for (let y = 0; y < depth; y++) {
    const t = (y + 0.5) / depth; // 0 far, 1 near, on screen
    const s = t / (t + TAPER * (1 - t)); // where that is on the rug
    const w = TAPER + (1 - TAPER) * t; // row width on screen, as a share of the near edge
    const sy = s * sh - 0.5;
    for (let x = 0; x < OW; x++) {
      let a = 0;
      const col = [0, 0, 0];
      for (const off of [0.25, 0.75]) {
        const u = (x + off - OW / 2) / (OW * w) + 0.5;
        if (u < 0 || u > 1) continue;
        const sx = u * sw - 0.5;
        a += sample(sx, sy, 3) / 2;
        for (let c = 0; c < 3; c++) col[c] += sample(sx, sy, c) / 2;
      }
      const o = y * OW + x;
      outA[o] = a;
      for (let c = 0; c < 3; c++) outRgb[o * 3 + c] = a > 1e-4 ? col[c] / a : 0;
    }
  }
  // The pile: one colour, the near edge's average over a band of rows (a speckled edge copied
  // down column by column runs into streaks), darker toward the floor.
  const band = Math.max(2, Math.round(depth * 0.04));
  const edge = [0, 0, 0];
  let wsum = 0;
  for (let y = depth - band; y < depth; y++) for (let x = 0; x < OW; x++) {
    const o = y * OW + x, a = outA[o];
    for (let c = 0; c < 3; c++) edge[c] += outRgb[o * 3 + c] * a;
    wsum += a;
  }
  for (let c = 0; c < 3; c++) edge[c] = wsum > 1e-4 ? edge[c] / wsum : 0;
  // Its coverage comes from the solid band above, not the soft last row, which would leave it
  // see-through in uneven stripes.
  const cover = new Float32Array(OW);
  for (let x = 0; x < OW; x++) for (let y = depth - band; y < depth; y++) cover[x] = Math.max(cover[x], outA[y * OW + x]);
  for (let y = depth; y < OH; y++) for (let x = 0; x < OW; x++) {
    const o = y * OW + x;
    const shade = 0.6 - 0.15 * ((y - depth + 0.5) / pile);
    outA[o] = cover[x];
    for (let c = 0; c < 3; c++) outRgb[o * 3 + c] = edge[c] * shade;
  }
  return { rgb: outRgb, alpha: outA, W: OW, H: OH };
}

/**
 * frame: a print in a thin black gallery frame (the Americanflat Streamline kind): a satin black
 * moulding about 2.5% of the long side, a hairline highlight on its outer and inner edges so it
 * reads as a frame and not a border, and nothing behind it.
 */
function withFrame(rgba: Buffer, W: number, H: number) {
  const b = Math.max(6, Math.round(Math.max(W, H) * 0.025));
  const FW = W + 2 * b, FH = H + 2 * b;
  const out = Buffer.alloc(FW * FH * 4);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const o = (y * FW + x) * 4;
    const ix = x - b, iy = y - b;
    if (ix >= 0 && iy >= 0 && ix < W && iy < H) {
      const i = (iy * W + ix) * 4;
      out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2];
    } else {
      // Distance to the nearer edge of the moulding, for the two highlights; lit a touch from above.
      const edge = Math.min(x, y, FW - 1 - x, FH - 1 - y, Math.abs(ix < 0 ? ix + 1 : ix >= W ? ix - W : 99), Math.abs(iy < 0 ? iy + 1 : iy >= H ? iy - H : 99));
      const top = y < FH / 2 ? 4 : 0;
      const v = (edge < 1 ? 58 : edge < 2 ? 40 : 26) + top;
      out[o] = v; out[o + 1] = v; out[o + 2] = v + 1;
    }
    out[o + 3] = 255;
  }
  return { rgba: out, alpha: new Float32Array(FW * FH).fill(1), W: FW, H: FH };
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

/**
 * Shop photos are often sharpened, so an object's outline carries a ring brighter than the backdrop
 * itself, and the model's matte reaches a pixel or so into it. Un-mixing can't remove light that
 * was never the backdrop's, and on the dark page it reads as a white hairline. Within a couple of
 * pixels of the silhouette, an edge pixel lighter than the object just inside it takes the inside
 * colour instead (darker edges, such as a real shadow line, are left alone). Thin parts with no
 * solid inside (a lamp's stem) keep their own colour.
 */
function defringe(rgb: Float32Array, alpha: Float32Array, W: number, H: number) {
  const n = W * H;
  const r = Math.max(2, Math.round(Math.max(W, H) * 0.001));
  const clear = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (alpha[i] < 0.5) clear[i] = 1;
  const near = clear.slice();
  dilate(near, W, H, r);
  const deep = clear.slice();
  dilate(deep, W, H, r + 1);
  // Nearest solid inside pixel for every band pixel, by a breadth-first walk outward from the inside.
  const src = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (!deep[i] && alpha[i] >= 0.98) src[i] = i;
  let frontier: number[] = [];
  for (let i = 0; i < n; i++) {
    if (src[i] < 0) continue;
    const x = i % W;
    if ((x > 0 && src[i - 1] < 0) || (x < W - 1 && src[i + 1] < 0) || (i >= W && src[i - W] < 0) || (i < n - W && src[i + W] < 0)) frontier.push(i);
  }
  for (let step = 0; step < r + 3 && frontier.length; step++) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p >= W ? p - W : -1, p < n - W ? p + W : -1]) {
        if (q >= 0 && src[q] < 0 && alpha[q] > 0) {
          src[q] = src[p];
          next.push(q);
        }
      }
    }
    frontier = next;
  }
  const lum = (i: number) => 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  for (let i = 0; i < n; i++) {
    const s = src[i];
    if (s < 0 || s === i || !near[i] || alpha[i] <= 0) continue;
    if (lum(i) > lum(s)) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgb[s * 3 + c];
  }
}

/**
 * holes: 'exact'. Saliency models fill the openings of a frame in (between a hamper's legs, under
 * its base bars). Those openings show the backdrop itself: flat, within a level or two of it. Each
 * connected patch of such pixels bigger than a crumb goes, and its rim fades with distance from
 * the backdrop colour, so anti-aliased edges stay clean and a white body a few levels off the
 * backdrop is left alone. With minThick (holes: 'through'), a patch goes only if a square of
 * that half-width fits inside it somewhere: an opening is a broad patch, glare on chrome a thin arc.
 */
function keyBackdropPatches(rgba: Buffer, alpha: Float32Array, bg: [number, number, number], W: number, H: number, TOL = 3, minThick = 0) {
  const n = W * H;
  const RAMP = 18;
  const dist = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    dist[i] = Math.max(Math.abs(rgba[i * 4] - bg[0]), Math.abs(rgba[i * 4 + 1] - bg[1]), Math.abs(rgba[i * 4 + 2] - bg[2]));
  }
  const minArea = Math.max(64, Math.round(n * 0.0002));
  // Where a backdrop-coloured square of half-width minThick fits (erode = dilate the complement).
  let core: Uint8Array | null = null;
  if (minThick > 0) {
    core = new Uint8Array(n);
    for (let i = 0; i < n; i++) core[i] = dist[i] > TOL ? 1 : 0;
    dilate(core, W, H, minThick);
  }
  const patch = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const members: number[] = [];
  for (let start = 0; start < n; start++) {
    if (seen[start] || dist[start] > TOL || alpha[start] < 0.02) continue;
    members.length = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      members.push(p);
      const x = p % W, y = (p - x) / W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && !seen[q] && dist[q] <= TOL) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (members.length >= minArea && (!core || members.some((p) => !core![p]))) for (const p of members) patch[p] = 1;
  }
  const rim = patch.slice();
  dilate(rim, W, H, Math.max(2, Math.round(Math.max(W, H) * 0.0015)));
  for (let i = 0; i < n; i++) {
    if (patch[i]) alpha[i] = 0;
    else if (rim[i]) alpha[i] *= smoothstep(TOL, TOL + RAMP, dist[i]);
  }
}

/**
 * holes: 'grow'. A backdrop in shade (the gap between two cards) is no longer the backdrop's
 * colour, but it keeps its hue and changes slowly from pixel to pixel, while an object's edge is a
 * step. Starting from what is already clear, the backdrop spreads into shaded neighbours that
 * differ by a few levels at most and keep the backdrop's hue.
 */
function growBackdrop(rgba: Buffer, alpha: Float32Array, bg: [number, number, number], W: number, H: number) {
  const n = W * H;
  const STEP = 4, HUE = 5;
  const hue = (i: number) => [rgba[i * 4] - rgba[i * 4 + 1], rgba[i * 4 + 1] - rgba[i * 4 + 2]];
  const bgHue = [bg[0] - bg[1], bg[1] - bg[2]];
  // Only into shade: an object of the backdrop's hue (a cream card) is lit, the gap behind it isn't.
  const bgLum = (bg[0] + bg[1] + bg[2]) / 3;
  const backdropLike = (i: number) => {
    const [a, b] = hue(i);
    const lum = (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3;
    return lum < bgLum - 8 && Math.abs(a - bgHue[0]) <= HUE && Math.abs(b - bgHue[1]) <= HUE;
  };
  const grown = new Uint8Array(n);
  let frontier: number[] = [];
  for (let i = 0; i < n; i++) if (alpha[i] < 0.05) { grown[i] = 1; frontier.push(i); }
  while (frontier.length) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p >= W ? p - W : -1, p < n - W ? p + W : -1]) {
        if (q < 0 || grown[q]) continue;
        const step = Math.max(Math.abs(rgba[p * 4] - rgba[q * 4]), Math.abs(rgba[p * 4 + 1] - rgba[q * 4 + 1]), Math.abs(rgba[p * 4 + 2] - rgba[q * 4 + 2]));
        if (step <= STEP && backdropLike(q)) {
          grown[q] = 1;
          next.push(q);
        }
      }
    }
    frontier = next;
  }
  for (let i = 0; i < n; i++) if (grown[i]) alpha[i] = 0;
}

/** floor: clear everything below the polyline through the points (flat beyond the ends), with a one-pixel soft edge. */
function clearBelow(alpha: Float32Array, W: number, H: number, points: [number, number][]) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  for (let x = 0; x < W; x++) {
    const fx = (x + 0.5) / W;
    let k = 0;
    while (k < pts.length - 2 && fx > pts[k + 1][0]) k++;
    const [x0, y0] = pts[k], [x1, y1] = pts[Math.min(k + 1, pts.length - 1)];
    const t = x1 > x0 ? clamp((fx - x0) / (x1 - x0), 0, 1) : 0;
    const edge = (y0 + (y1 - y0) * t) * H;
    for (let y = Math.max(0, Math.floor(edge) - 1); y < H; y++) {
      alpha[y * W + x] *= clamp(edge - (y + 0.5) + 0.5, 0, 1);
    }
  }
}

/**
 * holes: 'fill'. A matting model can key out light parts of an object that sit against light
 * parts of the photo (a kalimba's chrome tines over white), leaving slots the dark page shows
 * through. The real backdrop is all connected to the photo's edge, so a clear pixel the edge can't
 * reach through other clear pixels is part of the object and becomes solid (soft edge pixels are
 * left as they are, so a thin soft rim doesn't let the backdrop leak in).
 */
function fillEnclosed(alpha: Float32Array, W: number, H: number) {
  const n = W * H;
  const outside = new Uint8Array(n);
  const stack: number[] = [];
  const seed = (p: number) => {
    if (!outside[p] && alpha[p] < 0.5) {
      outside[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < W; x++) seed(x), seed(n - W + x);
  for (let y = 0; y < H; y++) seed(y * W), seed(y * W + W - 1);
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % W;
    if (x > 0) seed(p - 1);
    if (x < W - 1) seed(p + 1);
    if (p >= W) seed(p - W);
    if (p < n - W) seed(p + W);
  }
  for (let i = 0; i < n; i++) if (!outside[i] && alpha[i] < 0.5) alpha[i] = 1;
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
