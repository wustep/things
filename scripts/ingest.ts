#!/usr/bin/env tsx
/**
 * Things ingest: turn product URLs into items in the void.
 *
 *   npm run ingest -- <url> [<url> ...]
 *   npm run ingest -- batch.json            # JSON array of urls or {url, title?, brand?, price?}
 *   npm run ingest -- --force <url>         # re-ingest even if the item already exists
 *   npm run ingest -- --remove <id|url>     # drop an item and its files
 *   npm run ingest -- --list
 *
 * Flags: --force, --no-mesh (skip Meshy even if MESHY_API_KEY is set), --max-refs N (default 6).
 * Batch entries may also carry `image` (primary image URL) and `shape: 'card' | 'box' | 'cylinder'`.
 *
 * Writes data/items.json and public/items/<id>/{primary.png, ref-N.jpg, model.glb?}.
 * Idempotent: the same URL always maps to the same id and is skipped unless --force.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Asset, Item, ProceduralShape } from '../shared/types.ts';
import { buildProceduralAsset } from './lib/asset.ts';
import { extractProduct, type Extracted } from './lib/extract.ts';
import { fetchBinary, fetchHtml } from './lib/fetch.ts';
import { decode, normalizeReference, processPrimary, type ProcessedPrimary } from './lib/images.ts';
import { generateGlb, meshyAvailable } from './lib/meshy.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'items.json');
const PUBLIC_ITEMS = path.join(ROOT, 'public', 'items');
const ENV_FILE = path.join(ROOT, '.env');
const DEFAULT_MAX_REFS = 6;
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
  /** Use this image as the primary instead of whatever the page declares. */
  image?: string;
  /** Force the procedural shape instead of guessing from the title and cut-out. */
  shape?: ProceduralShape;
}

interface Options {
  force: boolean;
  remove: boolean;
  list: boolean;
  noMesh: boolean;
  maxRefs: number;
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
    console.error('usage: npm run ingest -- <url> [<url> ...] | <batch.json> | --remove <id> | --list  [--force] [--no-mesh] [--max-refs N]');
    process.exit(1);
  }

  const entries = await expandInputs(opts.inputs);
  let ok = 0, skipped = 0, failed = 0;
  for (const entry of entries) {
    const id = idFor(entry.url);
    const existing = items.find((it) => it.id === id);
    if (existing && !opts.force) {
      console.log(`skip  ${id}  already ingested: ${existing.title}`);
      skipped++;
      continue;
    }
    try {
      const item = await ingestOne(entry, id, opts);
      const idx = items.findIndex((it) => it.id === id);
      if (idx >= 0) items[idx] = item;
      else items.push(item);
      await saveItems(items); // save incrementally so a later failure loses nothing
      ok++;
      console.log(`done  ${id}  ${item.title}${item.price ? `  ${item.price}` : ''}  refs=${item.images.length}  asset=${describe(item.asset)}`);
    } catch (err) {
      failed++;
      console.error(`fail  ${id}  ${entry.url}\n      ${(err as Error).message}`);
    }
  }
  console.log(`\n${ok} ingested, ${skipped} skipped, ${failed} failed → ${path.relative(ROOT, DATA_FILE)}`);
  if (failed && !ok) process.exit(1);
}

async function ingestOne(entry: BatchEntry, id: string, opts: Options): Promise<Item> {
  const log = (m: string) => console.log(`      ${m}`);
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
  if (entry.image) {
    if (!/^https?:\/\//i.test(entry.image)) throw new Error(`image override must be an http(s) URL: ${entry.image}`);
    extracted.images.unshift(entry.image);
    extracted.declared += 1;
  }
  const title = entry.title ?? extracted.title ?? titleFromUrl(entry.url);
  const brand = entry.brand ?? extracted.brand;
  const price = entry.price ?? extracted.price;
  log(`title: ${title}${brand ? `  brand: ${brand}` : ''}${price ? `  price: ${price}` : ''}`);

  const dir = path.join(PUBLIC_ITEMS, id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const refs = await downloadReferences(extracted.images, extracted.declared, finalUrl, dir, opts.maxRefs, log);
  if (refs.length === 0) throw new Error('no usable images found on the page');

  const { primary, index } = await choosePrimary(refs);
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
      const glb = await generateGlb(primary.png, log);
      await writeFile(path.join(dir, 'model.glb'), glb);
      asset = { kind: 'glb', url: `${publicDir}/model.glb`, palette: primary.palette, fallback: procedural };
      log(`model.glb ${(glb.length / 1024).toFixed(0)} KB`);
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
    description: extracted.description,
    images: refs.map((r) => `${publicDir}/${r.file}`),
    asset,
    addedAt: new Date().toISOString(),
  };
}

interface Ref {
  file: string;
  buffer: Buffer;
  /** Declared by the page as this product's image (as opposed to scraped from any <img>). */
  declared: boolean;
}

/**
 * The first image on a page is usually the canonical product shot, but sometimes it is a wide
 * banner with the product tiny in the middle. Cut out the first few and keep the one with the
 * biggest subject. Only images the page declared as its own are eligible to replace the first
 * (scraped <img>s are often other products), a cleanly keyed subject always beats a photo whose
 * background could not be separated (usually a lifestyle shot), and later images must be
 * clearly bigger to displace an earlier one.
 */
async function choosePrimary(refs: Ref[]): Promise<{ primary: ProcessedPrimary; index: number }> {
  let best: { primary: ProcessedPrimary; index: number } | undefined;
  for (let i = 0; i < Math.min(PRIMARY_CANDIDATES, refs.length); i++) {
    if (i > 0 && !refs[i].declared) break;
    try {
      const primary = await processPrimary(refs[i].buffer);
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

async function downloadReferences(
  candidates: string[],
  declaredCount: number,
  referer: string,
  dir: string,
  maxRefs: number,
  log: (m: string) => void,
): Promise<Ref[]> {
  const refs: Ref[] = [];
  const hashes = new Set<string>();
  for (const [i, url] of candidates.entries()) {
    if (refs.length >= maxRefs) break;
    try {
      const { buffer, contentType } = await fetchBinary(url, referer);
      if (!/^image\//.test(contentType) && !looksLikeImage(buffer)) continue;
      const img = await decode(buffer);
      const { width, height } = img.bitmap;
      if (width < 200 || height < 200) continue; // thumbnails, icons
      if (width / height > 4 || height / width > 4) continue; // banners
      const hash = createHash('sha1').update(buffer).digest('hex');
      if (hashes.has(hash)) continue;
      hashes.add(hash);
      const { jpg } = await normalizeReference(buffer);
      const file = `ref-${refs.length}.jpg`;
      await writeFile(path.join(dir, file), jpg);
      refs.push({ file, buffer, declared: i < declaredCount });
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

async function saveItems(items: Item[]) {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(items, null, 2) + '\n');
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

function parseArgs(argv: string[]): Options {
  const opts: Options = { force: false, remove: false, list: false, noMesh: false, maxRefs: DEFAULT_MAX_REFS, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--remove' || a === '--rm') opts.remove = true;
    else if (a === '--list' || a === '-l') opts.list = true;
    else if (a === '--no-mesh') opts.noMesh = true;
    else if (a === '--max-refs' || a.startsWith('--max-refs=')) {
      const raw = a.includes('=') ? a.split('=')[1] : argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--max-refs needs a positive integer, got "${raw}"`);
      opts.maxRefs = n;
    } else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
