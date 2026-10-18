#!/usr/bin/env tsx
/**
 * Things ingest: turn product URLs into items in the void.
 *
 *   npm run ingest -- <url> [<url> ...]
 *   npm run ingest -- batch.json            # JSON array of urls or {url, title?, brand?, price?, section?}
 *   npm run ingest -- --force <url>         # re-ingest even if the item already exists
 *   npm run ingest -- --mesh <url>          # also ask Meshy for a 3D model (paid; needs MESHY_API_KEY)
 *   npm run ingest -- --remesh <url>        # give an existing item a Meshy model from the photos it already has
 *   npm run ingest -- --remove <id|url>     # drop an item and its files
 *   npm run ingest -- --list
 *   npm run ingest -- --originals [<id|batch.json> ...]  # re-download full-size photos only
 *
 * Flags: --force, --mesh (opt in to Meshy; without it, or --remesh, Meshy is never called even if
 * MESHY_API_KEY is set), --remesh (implies --mesh; existing items keep their photos and metadata and
 * only get a model; with --force it also replaces a model they already have), --no-mesh (the
 * default; kept for old scripts), --max-refs N (default 6), --parallel N (work on N entries at
 * once; default 1).
 * Batch entries may also carry `image` (primary image URL), `images` (more reference image URLs),
 * `maxRefs` (this entry's --max-refs),
 * `section` (a shelf label such as "Office"), `shape: 'card' | 'box' | 'cylinder'` and `meshTask`
 * (the id of a Meshy task that already succeeded, to attach its model instead of paying for a new one).
 *
 * Writes data/items.json, public/items/<id>/{primary.png, ref-N.jpg, model.glb?} and the untouched
 * downloads in media/originals/<id>/. New files are
 * built in a staging folder and swapped in only on success, so a failed --force keeps the old ones.
 * Idempotent: the same URL always maps to the same id and is skipped unless --force.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { affiliateUrl, amazonAsin } from '../shared/amazon.ts';
import { cleanLink } from '../shared/links.ts';
import { titleWithoutBrand, wholeDollars } from '../shared/text.ts';
import type { Asset, Item, ModelAsset, ProceduralAsset, ProceduralShape } from '../shared/types.ts';
import { buildProceduralAsset } from './lib/asset.ts';
import { extractProduct, extractShopifyProduct, fullSizeImageUrl, shopifyProductEndpoints, type Extracted } from './lib/extract.ts';
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
import { idFor } from './lib/ids.ts';
import { stageAssets, writeFileAtomic } from './lib/store.ts';
import type { Finish } from './lib/refine.ts';

// THINGS_ROOT points ingest at another checkout-shaped folder (the tests use a temp dir).
const ROOT = process.env.THINGS_ROOT
  ? path.resolve(process.env.THINGS_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'items.json');
const PUBLIC_ITEMS = path.join(ROOT, 'public', 'items');
/** Full-resolution downloads, exactly as the shop served them. Not deployed; `npm run images` reads them. */
const ORIGINALS = path.join(ROOT, 'media', 'originals');
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
  /** Keep at most this many photos for this entry (overrides --max-refs), e.g. to pin one variant's own. */
  maxRefs?: number;
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
  /** Only (re)download full-resolution originals for items already on the shelf. */
  originals: boolean;
  /** Ask Meshy for a model. Off unless --mesh or --remesh: models cost credits. */
  mesh: boolean;
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
      await rm(path.join(ORIGINALS, it.id), { recursive: true, force: true });
      console.log(`removed ${it.id} (${it.title})`);
    }
    await saveItems(remaining);
    return;
  }
  if (opts.originals) {
    await backfillOriginals(items, opts);
    return;
  }
  if (opts.inputs.length === 0) {
    console.error(
      'usage: npm run ingest -- <url> [<url> ...] | <batch.json> | --remove <id> | --list | --originals [<id> ...]  [--force] [--mesh] [--remesh] [--max-refs N] [--parallel N]',
    );
    process.exit(1);
  }

  if (opts.mesh && !opts.remesh && !meshyAvailable()) {
    console.log('--mesh: MESHY_API_KEY is not set; making image-based assets only');
  }
  const entries = await expandInputs(opts.inputs);
  const order = new Map(entries.map((e, i) => [idForUrl(e.url) ?? e.url, i]));
  let ok = 0, skipped = 0, failed = 0;
  await inParallel(entries, opts.parallel, async (entry) => {
    let id = entry.url;
    try {
      id = idFor(entry.url);
      // A stored link may have lost tracking or no-op params since its id was made: match it too.
      const byLink = items.find((it) => cleanLink(it.url) === cleanLink(affiliateUrl(entry.url)));
      if (!items.some((it) => it.id === id) && byLink) id = byLink.id;
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
    log(`page fetch failed (${(err as Error).message}); trying product JSON and overrides`);
  }
  // Thin metadata (client-rendered theme, bot wall): Shopify's public product JSON often still works.
  if (!extracted.images.length || !extracted.title || !extracted.price) {
    extracted = mergeExtracted(extracted, await fetchShopifyProduct(finalUrl, log));
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
  const price = wholeDollars((entry.price ?? extracted.price)?.trim() || undefined);
  const section = entry.section?.trim() || existing?.section;
  log(`title: ${title}${brand ? `  brand: ${brand}` : ''}${price ? `  price: ${price}` : ''}${section ? `  section: ${section}` : ''}`);

  // Build into a staging folder; the item's current files are only replaced once this succeeds.
  let downloaded: Ref[] = [];
  const item = await stageAssets(path.join(PUBLIC_ITEMS, id), async (dir) => {
    const refs = (downloaded = await downloadReferences(extracted.images, extracted.declared, finalUrl, dir, entry.maxRefs ?? opts.maxRefs, log));
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

    if (opts.mesh && meshyAvailable()) {
      try {
        asset = await meshAsset(entry, refs, processed, dir, procedural, log, id);
      } catch (err) {
        log(`mesh generation failed, keeping procedural asset: ${(err as Error).message}`);
      }
    }

    return {
      id,
      // Amazon links (short links resolved by the fetch) are stored canonical, with the affiliate tag.
      url: cleanLink(affiliateUrl(amazonAsin(finalUrl) ? finalUrl : entry.url)),
      domain: new URL(finalUrl).hostname.replace(/^www\./, ''),
      title,
      brand,
      price,
      section,
      description: extracted.description,
      // Stephen's notes belong to him, not to the shop page: a re-ingest carries them over.
      ...(existing?.commentary ? { commentary: existing.commentary } : {}),
      // So do earlier slugs: old /t/ links keep working after a re-ingest renames the thing.
      ...(existing?.aliases?.length ? { aliases: existing.aliases } : {}),
      images: refs.map((r) => `${publicDir}/${r.file}`),
      asset,
      addedAt: new Date().toISOString(),
    };
  });
  await saveOriginals(id, downloaded, log);
  return item;
}

/**
 * Keep the untouched downloads next to (not inside) the deployed files: `media/originals/<id>/`
 * holds ref-N.<ext> as the shop served it plus sources.json (where each came from). The 2D
 * image set (`npm run images`) is built from these, so a better processing pass never has to
 * go back to the shop. Swapped in whole, like the public folder.
 */
async function saveOriginals(id: string, refs: Ref[], log: (m: string) => void): Promise<void> {
  if (refs.length === 0) return;
  await stageAssets(path.join(ORIGINALS, id), async (dir) => {
    const sources = [];
    for (const r of refs) {
      const file = r.file.replace(/\.jpg$/, `.${extensionFor(r.buffer)}`);
      await writeFile(path.join(dir, file), r.buffer);
      sources.push({ file, url: r.url, width: r.width, height: r.height });
    }
    await writeFile(path.join(dir, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
  });
  log(`originals: ${refs.length} full-size photos in ${path.relative(ROOT, path.join(ORIGINALS, id))}`);
}

/**
 * --originals: for items already on the shelf, download the page's photos again at full size
 * into media/originals/<id>/ without touching items.json or public/items (so the 3D models and
 * cut-outs stay exactly as they are). Batch-file entries may add `image`/`images` URLs for
 * better shots than the page offers. With no inputs, every item that has no originals yet.
 */
async function backfillOriginals(items: Item[], opts: Options): Promise<void> {
  const entries = await expandInputs(opts.inputs.filter((q) => !items.some((it) => it.id === q)));
  const wanted = opts.inputs.length
    ? items.filter((it) => opts.inputs.includes(it.id) || entries.some((e) => idForUrl(e.url) === it.id))
    : items.filter((it) => opts.force || !existsSync(path.join(ORIGINALS, it.id, 'sources.json')));
  let ok = 0;
  await inParallel(wanted, opts.parallel, async (it) => {
    const log = (m: string) => console.log(`      ${it.id}  ${m}`);
    console.log(`fetch ${it.id}  ${it.url}`);
    const entry = entries.find((e) => idForUrl(e.url) === it.id);
    let extracted: Extracted = { images: [], declared: 0 };
    let finalUrl = it.url;
    try {
      const page = await fetchHtml(it.url);
      finalUrl = page.finalUrl;
      extracted = extractProduct(page.html, finalUrl);
    } catch (err) {
      log(`page fetch failed (${(err as Error).message})`);
    }
    if (!extracted.images.length) extracted = mergeExtracted(extracted, await fetchShopifyProduct(finalUrl, log));
    const overrides = [entry?.image, ...(entry?.images ?? [])].filter((u): u is string => !!u && /^https?:\/\//i.test(u));
    extracted.images.unshift(...overrides);
    extracted.declared += overrides.length;
    try {
      const scratch = path.join(ORIGINALS, `.${it.id}.refs-${process.pid}`);
      const refs = await stageAssets(scratch, (dir) => downloadReferences(extracted.images, extracted.declared, finalUrl, dir, entry?.maxRefs ?? opts.maxRefs, log));
      await rm(scratch, { recursive: true, force: true });
      if (refs.length === 0) throw new Error('no usable images');
      await saveOriginals(it.id, refs, log);
      ok++;
    } catch (err) {
      const kept = existsSync(path.join(ORIGINALS, it.id, 'sources.json'));
      if (!kept && (await originalsFromDisk(it, log))) ok++;
      else console.error(`fail  ${it.id}  ${(err as Error).message}${kept ? '; existing originals kept' : ''}`);
    }
  });
  console.log(`\n${ok} of ${wanted.length} items have fresh originals in ${path.relative(ROOT, ORIGINALS)}`);
}

/**
 * The shop now blocks us (or dropped the page): the photos this item was first ingested with are
 * the best there is, so they become its originals, marked as the 1200px copies they are.
 */
async function originalsFromDisk(it: Item, log: (m: string) => void): Promise<boolean> {
  const refs: Ref[] = [];
  for (const pub of it.images) {
    const full = path.join(ROOT, 'public', pub);
    if (!existsSync(full)) continue;
    const buffer = await readFile(full);
    const { width, height } = (await decode(buffer)).bitmap;
    refs.push({ file: path.basename(pub), url: `public${pub} (ingest copy; the shop blocked a fresh download)`, width, height, buffer, jpg: buffer, declared: true, hash: '', pixels: width * height });
  }
  if (refs.length === 0) return false;
  log('shop unavailable: the photos already on disk become the originals');
  await saveOriginals(it.id, refs, log);
  return true;
}

function extensionFor(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 4, 12).startsWith('ftypavi')) return 'avif';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return 'jpg';
}

/** Try `<product-url>.js`, then `.json`. Undefined when the URL is not a Shopify product or both fail. */
async function fetchShopifyProduct(pageUrl: string, log: (m: string) => void): Promise<Extracted | undefined> {
  for (const endpoint of shopifyProductEndpoints(pageUrl)) {
    try {
      const { html } = await fetchHtml(endpoint);
      const shop = extractShopifyProduct(JSON.parse(html), pageUrl);
      log(`shopify product JSON: ${shop.images.length} images  ${endpoint.slice(0, 90)}`);
      return shop;
    } catch {
      /* not Shopify, or this endpoint is blocked: try the next */
    }
  }
  return undefined;
}

/**
 * Page metadata wins field by field. The product JSON's images only lead when the page declared
 * none of its own (anything it has then was scraped from <img> tags and may be other products).
 */
function mergeExtracted(page: Extracted, shop: Extracted | undefined): Extracted {
  if (!shop) return page;
  const shopImagesFirst = page.declared === 0;
  return {
    title: page.title ?? shop.title,
    brand: page.brand ?? shop.brand,
    price: page.price ?? shop.price,
    description: page.description ?? shop.description,
    images: shopImagesFirst ? [...shop.images, ...page.images] : page.images,
    declared: shopImagesFirst ? shop.declared : page.declared,
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
  if (!opts.mesh || !meshyAvailable()) throw new Error('--remesh needs MESHY_API_KEY (and not --no-mesh)');

  const dir = path.join(PUBLIC_ITEMS, id);
  const refs: Ref[] = [];
  for (const pub of existing.images) {
    const file = path.basename(pub);
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    const jpg = await readFile(full);
    // The photos on disk all passed the download filters; treat them as the page's own.
    refs.push({ file, url: '', width: 0, height: 0, buffer: jpg, jpg, declared: true, hash: '', pixels: 0 });
  }
  if (refs.length === 0) throw new Error('no reference photos on disk; re-ingest with --force');

  const brand = entry.brand ?? existing.brand;
  const title = titleWithoutBrand(entry.title ?? existing.title, brand);
  const price = wholeDollars(entry.price?.trim() || existing.price);
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
  itemId = path.basename(dir),
): Promise<ModelAsset> {
  const publicDir = `/items/${itemId}`;
  const chosen = await chooseMeshReferences(refs, processed, log);
  const raw = entry.meshTask
    ? await fetchTaskGlb(entry.meshTask, log)
    : await generateGlb(chosen.map((r) => ({ data: r.jpg, mime: 'image/jpeg' as const })), log);
  let glb = raw;
  try {
    glb = await slimGlb(raw, log, finishFor(path.basename(dir)));
    log(`model.glb ${kb(raw)} KB from Meshy, ${kb(glb)} KB slimmed`);
  } catch (err) {
    log(`could not slim the GLB, keeping Meshy's original (${kb(raw)} KB): ${(err as Error).message}`);
  }
  // --remesh writes into the live folder: never leave a truncated model behind.
  await writeFileAtomic(path.join(dir, 'model.glb'), glb);
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
  /** Where the original came from (empty for photos reused from disk by --remesh). */
  url: string;
  width: number;
  height: number;
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
  for (const [i, candidate] of candidates.entries()) {
    if (refs.length >= maxRefs) break;
    const url = fullSizeImageUrl(candidate);
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
          Object.assign(twin, { url, width, height, buffer, jpg, hash, pixels, declared: twin.declared || declared });
          log(`${twin.file} upgraded to ${width}x${height}  ${url.slice(0, 90)}`);
        }
        continue;
      }
      const { jpg } = await normalizeReference(buffer);
      const file = `ref-${refs.length}.jpg`;
      await writeFile(path.join(dir, file), jpg);
      refs.push({ file, url, width, height, buffer, jpg, declared, hash, pixels });
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
    .then(() => writeFileAtomic(DATA_FILE, JSON.stringify(items, null, 2) + '\n'));
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
    originals: false,
    mesh: false,
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
    else if (a === '--remesh') opts.remesh = opts.mesh = true;
    else if (a === '--remove' || a === '--rm') opts.remove = true;
    else if (a === '--list' || a === '-l') opts.list = true;
    else if (a === '--originals') opts.originals = true;
    else if (a === '--mesh') opts.mesh = true;
    else if (a === '--no-mesh') opts.mesh = false;
    else if (a === '--max-refs' || a.startsWith('--max-refs=')) [opts.maxRefs, i] = intFlag(a, i, '--max-refs', 50);
    else if (a === '--parallel' || a.startsWith('--parallel=')) [opts.parallel, i] = intFlag(a, i, '--parallel', MAX_PARALLEL);
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else opts.inputs.push(a);
  }
  return opts;
}

// ---------- ids ----------

export { idFor };

/** idFor for user input that may be an id rather than a URL. */
function idForUrl(input: string): string | undefined {
  try {
    return /^https?:\/\//i.test(input) ? idFor(input) : undefined;
  } catch {
    return undefined;
  }
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

/** Per-item refine settings (data/mesh-finish.json), or the defaults. */
function finishFor(id: string): Finish {
  try {
    const all = JSON.parse(readFileSync(path.join(ROOT, 'data', 'mesh-finish.json'), 'utf8')) as Record<string, Finish>;
    return all[id] ?? {};
  } catch {
    return {};
  }
}
