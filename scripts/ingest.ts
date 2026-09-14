#!/usr/bin/env tsx
/**
 * Things ingest: turn product URLs into items in the void.
 *
 *   npm run ingest -- <url> [<url> ...]
 *   npm run ingest -- batch.json            # JSON array of urls or {url, title?, brand?, price?, section?}
 *   npm run ingest -- --force <url>         # re-ingest even if the item already exists
 *   npm run ingest -- --remesh <url>        # give an existing item a Meshy model from the photos it already has
 *   npm run ingest -- --remove <id|url>     # drop an item and its files
 *   npm run ingest -- --list
 *
 * Flags: --force, --remesh (existing items keep their photos and metadata and only get a model;
 * with --force it also replaces a model they already have), --no-mesh (skip Meshy even if
 * MESHY_API_KEY is set), --max-refs N (default 6), --parallel N (work on N entries at once; default 1).
 * Batch entries may also carry `image` (primary image URL), `images` (more reference image URLs),
 * `section` (a shelf label such as "Office"), `shape: 'card' | 'box' | 'cylinder'` and `meshTask`
 * (the id of a Meshy task that already succeeded, to attach its model instead of paying for a new one).
 *
 * Writes data/items.json and public/items/<id>/{primary.png, ref-N.jpg, model.glb?}.
 * Idempotent: the same URL always maps to the same id and is skipped unless --force.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleWithoutBrand } from '../shared/text.ts';
import type { Asset, Item, ModelAsset, ProceduralAsset, ProceduralShape } from '../shared/types.ts';
import { buildProceduralAsset } from './lib/asset.ts';
import { extractProduct, type Extracted } from './lib/extract.ts';
import { fetchBinary, fetchHtml } from './lib/fetch.ts';
import { slimGlb } from './lib/glb.ts';
import {
  decode,
  hashDistance,
  NEAR_DUPLICATE,
  normalizeReference,
  perceptualHash,
  processPrimary,
  type ProcessedPrimary,
} from './lib/images.ts';
import { fetchTaskGlb, generateGlb, MAX_MESH_IMAGES, meshyAvailable } from './lib/meshy.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'items.json');
const PUBLIC_ITEMS = path.join(ROOT, 'public', 'items');
const ENV_FILE = path.join(ROOT, '.env');
const DEFAULT_MAX_REFS = 6;
const MAX_PARALLEL = 8;
/** How many of the downloaded references are tried as the primary cut-out. */
const PRIMARY_CANDIDATES = 3;
const SHAPES: ProceduralShape[] = ['card', 'box', 'cylinder'];

// Optional MESHY_API_KEY lives in .env (see .env.example). Node < 20.12 lacks loadEnvFile;
// export the variable in the shell there instead.
if (existsSync(ENV_FILE) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    /* unreadable .env: fall through to the shell environment */
  }
}

interface BatchEntry {
  url: string;
  title?: string;
  brand?: string;
  price?: string;
  /** Shelf grouping, e.g. the Moonsift section the item came from. */
  section?: string;
  /** Use this image as the primary instead of whatever the page declares. */
  image?: string;
  /** More reference photos of the product, tried before anything scraped from the page. */
  images?: string[];
  /** Force the procedural shape instead of guessing from the title and cut-out. */
  shape?: ProceduralShape;
  /** A Meshy task that already succeeded: use its GLB instead of creating a new task. */
  meshTask?: string;
}

interface Options {
  force: boolean;
  remesh: boolean;
  remove: boolean;
  list: boolean;
  noMesh: boolean;
  maxRefs: number;
  parallel: number;
  inputs: string[];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const items = await loadItems();

  if (opts.list) {
    for (const it of items) console.log(`${it.id}\t${it.title}\t${it.url}`);
    return;
  }
  if (opts.remove) {
    const remaining = items.filter((it) => !opts.inputs.some((q) => q === it.id || q === it.url || idForUrl(q) === it.id));
    for (const it of items.filter((it) => !remaining.includes(it))) {
      await rm(path.join(PUBLIC_ITEMS, it.id), { recursive: true, force: true });
      console.log(`removed ${it.id} (${it.title})`);
    }
    await saveItems(remaining);
    return;
  }
  if (opts.inputs.length === 0) {
    console.error(
      'usage: npm run ingest -- <url> [<url> ...] | <batch.json> | --remove <id> | --list  [--force] [--remesh] [--no-mesh] [--max-refs N] [--parallel N]',
    );
    process.exit(1);
  }

  const entries = await expandInputs(opts.inputs);
  const order = new Map(entries.map((e, i) => [idForUrl(e.url) ?? e.url, i]));
  let ok = 0, skipped = 0, failed = 0;
  await inParallel(entries, opts.parallel, async (entry) => {
    let id = entry.url;
    try {
      id = idFor(entry.url);
      const existing = items.find((it) => it.id === id);
      let item: Item;
      if (existing && opts.remesh) {
        if (existing.asset.kind === 'glb' && !opts.force && !entry.meshTask) {
          console.log(`skip  ${id}  already has a model: ${existing.title}`);
          skipped++;
          return;
        }
        item = await remeshOne(entry, existing, opts);
      } else {
        if (existing && !opts.force) {
          console.log(`skip  ${id}  already ingested: ${existing.title}`);
          skipped++;
          return;
        }
        item = await ingestOne(entry, id, existing, opts);
      }
      placeItem(items, item, order);
      await saveItems(items); // save incrementally so a later failure loses nothing
      ok++;
      console.log(
        `done  ${id}  ${item.title}${item.price ? `  ${item.price}` : ''}  refs=${item.images.length}  asset=${describe(item.asset)}`,
      );
    } catch (err) {
      failed++;
      console.error(`fail  ${id}  ${entry.url}\n      ${(err as Error).message}`);
    }
  });
  console.log(`\n${ok} ingested, ${skipped} skipped, ${failed} failed → ${path.relative(ROOT, DATA_FILE)}`);
  if (failed && !ok) process.exit(1);
}

async function ingestOne(entry: BatchEntry, id: string, existing: Item | undefined, opts: Options): Promise<Item> {
  const tag = opts.parallel > 1 ? `${id}  ` : '';
  const log = (m: string) => console.log(`      ${tag}${m}`);
  console.log(`fetch ${id}  ${entry.url}`);

  let extracted: Extracted = { images: [], declared: 0 };
  let finalUrl = entry.url;
  try {
    const page = await fetchHtml(entry.url);
    finalUrl = page.finalUrl;
    extracted = extractProduct(page.html, finalUrl);
  } catch (err) {
    log(`page fetch failed (${(err as Error).message}); continuing with overrides only`);
  }
  const overrides = [entry.image, ...(entry.images ?? [])].filter((u): u is string => typeof u === 'string' && u.length > 0);
  for (const u of overrides) {
    if (!/^https?:\/\//i.test(u)) throw new Error(`image override must be an http(s) URL: ${u}`);
  }
  extracted.images.unshift(...overrides);
  extracted.declared += overrides.length;

  const brand = entry.brand ?? extracted.brand;
  // The brand gets its own line on the card, so it comes out of the title.
  const title = titleWithoutBrand(entry.title ?? extracted.title ?? titleFromUrl(entry.url), brand);
  const price = (entry.price ?? extracted.price)?.trim() || undefined;
  const section = entry.section?.trim() || existing?.section;
  log(`title: ${title}${brand ? `  brand: ${brand}` : ''}${price ? `  price: ${price}` : ''}${section ? `  section: ${section}` : ''}`);

  const dir = path.join(PUBLIC_ITEMS, id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const refs = await downloadReferences(extracted.images, extracted.declared, finalUrl, dir, opts.maxRefs, log);
  if (refs.length === 0) throw new Error('no usable images found on the page');

  const processed = new Map<Ref, ProcessedPrimary>();
  const { primary, index } = await choosePrimary(refs, processed);
  if (index !== 0) {
    log(`primary: using reference ${index + 1} (larger subject than the first image)`);
    refs.unshift(...refs.splice(index, 1)); // keep item.images "primary first"
  }
  await writeFile(path.join(dir, 'primary.png'), primary.png);
  log(`primary cut-out ${primary.width}x${primary.height}, background removed ${(primary.removedFraction * 100).toFixed(0)}%, palette ${primary.palette.join(' ')}`);

  const publicDir = `/items/${id}`;
  const procedural = buildProceduralAsset({
    title,
    texture: `${publicDir}/primary.png`,
    aspect: primary.aspect,
    palette: primary.palette,
    removedFraction: primary.removedFraction,
  });
  if (entry.shape) {
    if (!SHAPES.includes(entry.shape)) throw new Error(`unknown shape "${entry.shape}" (use ${SHAPES.join(' | ')})`);
    procedural.shape = entry.shape;
  }
  let asset: Asset = procedural;

  if (meshyAvailable() && !opts.noMesh) {
    try {
      asset = await meshAsset(entry, refs, processed, dir, procedural, log);
    } catch (err) {
      log(`mesh generation failed, keeping procedural asset: ${(err as Error).message}`);
    }
  }

  return {
    id,
    url: entry.url,
    domain: new URL(finalUrl).hostname.replace(/^www\./, ''),
    title,
    brand,
    price,
    section,
    description: extracted.description,
    images: refs.map((r) => `${publicDir}/${r.file}`),
    asset,
    addedAt: new Date().toISOString(),
  };
}

/**
 * --remesh: the item keeps its photos, cut-out and metadata; only the model is (re)made, from
 * the reference photos already on disk. Batch overrides for title, brand, price and section
 * still apply, so a batch file can backfill those at the same time. Nothing is written unless
 * Meshy delivers, so a failure leaves the item exactly as it was.
 */
async function remeshOne(entry: BatchEntry, existing: Item, opts: Options): Promise<Item> {
  const id = existing.id;
  const tag = opts.parallel > 1 ? `${id}  ` : '';
  const log = (m: string) => console.log(`      ${tag}${m}`);
  console.log(`mesh  ${id}  ${existing.title}`);
  if (!meshyAvailable() || opts.noMesh) throw new Error('--remesh needs MESHY_API_KEY (and not --no-mesh)');

  const dir = path.join(PUBLIC_ITEMS, id);
  const refs: Ref[] = [];
  for (const pub of existing.images) {
    const file = path.basename(pub);
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    const jpg = await readFile(full);
    // The photos on disk all passed the download filters; treat them as the page's own.
    refs.push({ file, buffer: jpg, jpg, declared: true, hash: '', pixels: 0 });
  }
  if (refs.length === 0) throw new Error('no reference photos on disk; re-ingest with --force');

  const brand = entry.brand ?? existing.brand;
  const title = titleWithoutBrand(entry.title ?? existing.title, brand);
  const price = entry.price?.trim() || existing.price;
  const section = entry.section?.trim() || existing.section;
  log(`title: ${title}${brand ? `  brand: ${brand}` : ''}${price ? `  price: ${price}` : ''}${section ? `  section: ${section}` : ''}`);

  const processed = new Map<Ref, ProcessedPrimary>();
  processed.set(refs[0], await processPrimary(refs[0].buffer));
  const fallback = existing.asset.kind === 'glb' ? existing.asset.fallback : existing.asset;
  const asset = await meshAsset(entry, refs, processed, dir, fallback, log);
  return { ...existing, title, brand, price, section, asset, addedAt: new Date().toISOString() };
}

/** Pick the photos, get a GLB from Meshy (a fresh task, or one that already finished), slim it, store it. */
async function meshAsset(
  entry: BatchEntry,
  refs: Ref[],
  processed: Map<Ref, ProcessedPrimary>,
  dir: string,
  fallback: ProceduralAsset,
  log: (m: string) => void,
): Promise<ModelAsset> {
  const publicDir = `/items/${path.basename(dir)}`;
  const chosen = await chooseMeshReferences(refs, processed, log);
  const raw = entry.meshTask
    ? await fetchTaskGlb(entry.meshTask, log)
    : await generateGlb(chosen.map((r) => ({ data: r.jpg, mime: 'image/jpeg' as const })), log);
  let glb = raw;
  try {
    glb = await slimGlb(raw, log);
    log(`model.glb ${kb(raw)} KB from Meshy, ${kb(glb)} KB slimmed`);
  } catch (err) {
    log(`could not slim the GLB, keeping Meshy's original (${kb(raw)} KB): ${(err as Error).message}`);
  }
  await writeFile(path.join(dir, 'model.glb'), glb);
  return {
    kind: 'glb',
    url: `${publicDir}/model.glb`,
    palette: fallback.palette,
    refs: chosen.map((r) => `${publicDir}/${r.file}`),
    fallback,
  };
}

interface Ref {
  file: string;
  /** The original download. */
  buffer: Buffer;
  /** The normalized JPEG written to disk (flattened, at most 1200px). */
  jpg: Buffer;
  /** Declared by the page as this product's image (as opposed to scraped from any <img>). */
  declared: boolean;
  hash: string;
  pixels: number;
}

/**
 * The first image on a page is usually the canonical product shot, but sometimes it is a wide
 * banner with the product tiny in the middle. Cut out the first few and keep the one with the
 * biggest subject. Only images the page declared as its own are eligible to replace the first
 * (scraped <img>s are often other products), a cleanly keyed subject always beats a photo whose
 * background could not be separated (usually a lifestyle shot), and later images must be
 * clearly bigger to displace an earlier one.
 */
async function choosePrimary(refs: Ref[], processed: Map<Ref, ProcessedPrimary>): Promise<{ primary: ProcessedPrimary; index: number }> {
  let best: { primary: ProcessedPrimary; index: number } | undefined;
  for (let i = 0; i < Math.min(PRIMARY_CANDIDATES, refs.length); i++) {
    if (i > 0 && !refs[i].declared) break;
    try {
      const primary = await processPrimary(refs[i].buffer);
      processed.set(refs[i], primary);
      if (!best) {
        best = { primary, index: i };
        continue;
      }
      const keyed = isKeyed(primary);
      const bestKeyed = isKeyed(best.primary);
      if (keyed !== bestKeyed) {
        if (keyed) best = { primary, index: i };
        continue;
      }
      if (primary.subjectArea > best.primary.subjectArea * (best.index === 0 ? 1.5 : 1.05)) best = { primary, index: i };
    } catch {
      /* undecodable reference: skip */
    }
  }
  if (!best) throw new Error('could not process any reference image');
  return best;
}

function isKeyed(p: ProcessedPrimary): boolean {
  return p.removedFraction >= 0.05;
}

/** Extra mesh references must be mostly one object; group shots and size charts confuse the model. */
const MIN_DOMINANCE = 0.7;

/**
 * Meshy wants one to four photos of the same object, front view first. The primary leads; the
 * rest are the cleanest other shots: only keyed ones showing a single object qualify (a
 * lifestyle photo's room, or a second colourway, would end up in the mesh), declared images beat
 * scraped ones, and bigger subjects beat smaller ones.
 */
async function chooseMeshReferences(refs: Ref[], processed: Map<Ref, ProcessedPrimary>, log: (m: string) => void): Promise<Ref[]> {
  const chosen = [refs[0]];
  const candidates: { ref: Ref; p: ProcessedPrimary }[] = [];
  for (const ref of refs.slice(1)) {
    try {
      let p = processed.get(ref);
      if (!p) processed.set(ref, (p = await processPrimary(ref.buffer)));
      if (isKeyed(p) && p.dominance >= MIN_DOMINANCE) candidates.push({ ref, p });
    } catch {
      /* undecodable reference: skip */
    }
  }
  candidates.sort((a, b) => Number(b.ref.declared) - Number(a.ref.declared) || b.p.subjectArea - a.p.subjectArea);
  for (const c of candidates) {
    if (chosen.length >= MAX_MESH_IMAGES) break;
    chosen.push(c.ref);
  }
  log(`meshy refs: ${chosen.map((r) => r.file).join(' ')}  (primary dominance ${processed.get(refs[0])!.dominance.toFixed(2)})`);
  return chosen;
}

/**
 * Download candidates in order until maxRefs usable ones are on disk. Thumbnails, banners and
 * broken files are skipped. The same photo often shows up several times at different sizes (CDN
 * thumbnail ladders, a collection's own copy of the product shot): those are collapsed by
 * perceptual hash, keeping the largest version in the slot of the first.
 */
async function downloadReferences(
  candidates: string[],
  declaredCount: number,
  referer: string,
  dir: string,
  maxRefs: number,
  log: (m: string) => void,
): Promise<Ref[]> {
  const refs: Ref[] = [];
  const seen = new Set<string>();
  for (const [i, url] of candidates.entries()) {
    if (refs.length >= maxRefs) break;
    try {
      const { buffer, contentType } = await fetchBinary(url, referer);
      if (!/^image\//.test(contentType) && !looksLikeImage(buffer)) continue;
      const sha = createHash('sha1').update(buffer).digest('hex');
      if (seen.has(sha)) continue;
      seen.add(sha);
      const img = await decode(buffer);
      const { width, height } = img.bitmap;
      if (width < 200 || height < 200) continue; // thumbnails, icons
      if (width / height > 4 || height / width > 4) continue; // banners
      const hash = perceptualHash(img);
      const pixels = width * height;
      const declared = i < declaredCount;
      const twin = refs.find((r) => hashDistance(r.hash, hash) < NEAR_DUPLICATE);
      if (twin) {
        if (pixels > twin.pixels * 1.2) {
          const { jpg } = await normalizeReference(buffer);
          await writeFile(path.join(dir, twin.file), jpg);
          Object.assign(twin, { buffer, jpg, hash, pixels, declared: twin.declared || declared });
          log(`${twin.file} upgraded to ${width}x${height}  ${url.slice(0, 90)}`);
        }
        continue;
      }
      const { jpg } = await normalizeReference(buffer);
      const file = `ref-${refs.length}.jpg`;
      await writeFile(path.join(dir, file), jpg);
      refs.push({ file, buffer, jpg, declared, hash, pixels });
      log(`ref ${refs.length}/${maxRefs}  ${width}x${height}  ${url.slice(0, 90)}`);
    } catch {
      /* skip broken images */
    }
  }
  return refs;
}

function looksLikeImage(buf: Buffer): boolean {
  const head = buf.subarray(0, 12);
  return (
    head[0] === 0xff && head[1] === 0xd8 || // jpeg
    head[0] === 0x89 && head[1] === 0x50 || // png
    head.toString('ascii', 8, 12) === 'WEBP' ||
    head.toString('ascii', 0, 3) === 'GIF'
  );
}

// ---------- items.json ----------

async function loadItems(): Promise<Item[]> {
  if (!existsSync(DATA_FILE)) return [];
  const raw = await readFile(DATA_FILE, 'utf8');
  return raw.trim() ? (JSON.parse(raw) as Item[]) : [];
}

/** Writes are queued so parallel ingests never interleave inside the file. */
let saving: Promise<void> = Promise.resolve();

function saveItems(items: Item[]): Promise<void> {
  saving = saving
    .catch(() => undefined)
    .then(async () => {
      await mkdir(path.dirname(DATA_FILE), { recursive: true });
      await writeFile(DATA_FILE, JSON.stringify(items, null, 2) + '\n');
    });
  return saving;
}

/** Replace an existing item in place; otherwise insert where the batch order says it belongs. */
function placeItem(items: Item[], item: Item, order: Map<string, number>) {
  const idx = items.findIndex((it) => it.id === item.id);
  if (idx >= 0) {
    items[idx] = item;
    return;
  }
  const mine = order.get(item.id) ?? Number.POSITIVE_INFINITY;
  const before = items.findIndex((it) => (order.get(it.id) ?? -1) > mine);
  if (before >= 0) items.splice(before, 0, item);
  else items.push(item);
}

// ---------- inputs ----------

async function expandInputs(inputs: string[]): Promise<BatchEntry[]> {
  const entries: BatchEntry[] = [];
  for (const input of inputs) {
    if (/^https?:\/\//i.test(input)) {
      entries.push({ url: input });
      continue;
    }
    const file = path.resolve(input);
    if (!existsSync(file)) throw new Error(`not a URL or existing file: ${input}`);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown[] }).items ?? [];
    for (const e of list) {
      if (typeof e === 'string') entries.push({ url: e });
      else if (e && typeof e === 'object' && typeof (e as BatchEntry).url === 'string') entries.push(e as BatchEntry);
    }
  }
  return entries;
}

async function inParallel<T>(list: T[], limit: number, fn: (entry: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    while (next < list.length) await fn(list[next++]);
  });
  await Promise.all(workers);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    force: false,
    remesh: false,
    remove: false,
    list: false,
    noMesh: false,
    maxRefs: DEFAULT_MAX_REFS,
    parallel: 1,
    inputs: [],
  };
  const intFlag = (a: string, i: number, name: string, max: number): [number, number] => {
    const raw = a.includes('=') ? a.split('=')[1] : argv[i + 1];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} needs an integer from 1 to ${max}, got "${raw}"`);
    return [n, a.includes('=') ? i : i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--remesh') opts.remesh = true;
    else if (a === '--remove' || a === '--rm') opts.remove = true;
    else if (a === '--list' || a === '-l') opts.list = true;
    else if (a === '--no-mesh') opts.noMesh = true;
    else if (a === '--max-refs' || a.startsWith('--max-refs=')) [opts.maxRefs, i] = intFlag(a, i, '--max-refs', 50);
    else if (a === '--parallel' || a.startsWith('--parallel=')) [opts.parallel, i] = intFlag(a, i, '--parallel', MAX_PARALLEL);
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else opts.inputs.push(a);
  }
  return opts;
}

// ---------- ids ----------

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|ref$|ref_|tag$|th$|psc$|pd_rd|pf_rd|sr$|keywords$|qid$|sprefix$|crid$|linkCode$|_encoding$|smid$|dib)/i;

/** Stable id: hostname slug + short hash of the URL without tracking params. */
export function idFor(url: string): string {
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.hash = '';
  const host = u.hostname.replace(/^www\./, '').split('.').slice(0, -1).join('-') || u.hostname;
  // Amazon: collapse to the ASIN so /dp/ASIN and /Long-Title/dp/ASIN agree.
  const asin = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
  const canonical = asin ? `${u.hostname}/dp/${asin.toUpperCase()}` : u.toString();
  const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 8);
  return `${slug(host)}-${hash}`;
}

/** idFor for user input that may be an id rather than a URL. */
function idForUrl(input: string): string | undefined {
  try {
    return /^https?:\/\//i.test(input) ? idFor(input) : undefined;
  } catch {
    return undefined;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function titleFromUrl(url: string): string {
  const u = new URL(url);
  const last = u.pathname.split('/').filter(Boolean).pop() ?? u.hostname;
  return decodeURIComponent(last).replace(/[-_+]+/g, ' ').replace(/\.\w+$/, '').trim() || u.hostname;
}

function describe(asset: Asset): string {
  return asset.kind === 'glb' ? 'glb' : asset.shape;
}

function kb(buf: Buffer): string {
  return (buf.length / 1024).toFixed(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
