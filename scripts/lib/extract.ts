import * as cheerio from 'cheerio';

export interface Extracted {
  title?: string;
  brand?: string;
  price?: string;
  description?: string;
  /** Candidate image URLs, best first. May contain duplicates. */
  images: string[];
  /**
   * How many leading entries of `images` the page declared as this product's own (JSON-LD,
   * Open Graph, site-specific markup). The rest were scraped from <img> tags and may well
   * show other products, so only the declared ones are safe substitutes for the first.
   */
  declared: number;
}

type Cheerio = cheerio.CheerioAPI;

/** Pull product metadata out of a page using JSON-LD, Open Graph, and site-specific fallbacks. */
export function extractProduct(html: string, pageUrl: string): Extracted {
  const $ = cheerio.load(html);
  const out: Extracted = { images: [], declared: 0 };
  const host = new URL(pageUrl).hostname;

  applyJsonLd($, out, pageUrl);
  if (/amazon\./.test(host)) applyAmazon($, out);
  applyOpenGraph($, out, pageUrl);
  const finalize = (list: string[]) => dedupe(list.map((u) => absolutize(u, pageUrl)).filter(isLikelyProductImage));
  out.declared = finalize(out.images).length;
  applyGenericFallbacks($, out, pageUrl);

  out.images = finalize(out.images); // declared entries come first, so they survive dedupe as the prefix
  if (out.title) out.title = clean(out.title);
  if (out.brand) out.brand = clean(out.brand);
  if (out.description) out.description = clean(out.description).slice(0, 400);
  return out;
}

// ---------- JSON-LD ----------

function applyJsonLd($: Cheerio, out: Extracted, pageUrl: string) {
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    for (const node of flattenJsonLd(parsed)) {
      if (!isProductNode(node)) continue;
      const n = node as Record<string, unknown>;
      out.title ??= str(n.name);
      out.description ??= str(n.description);
      out.brand ??= brandOf(n.brand);
      out.price ??= priceOf(n.offers);
      for (const img of imagesOf(n.image)) out.images.push(absolutize(img, pageUrl));
    }
  });
}

function flattenJsonLd(node: unknown, acc: unknown[] = []): unknown[] {
  if (Array.isArray(node)) node.forEach((n) => flattenJsonLd(n, acc));
  else if (node && typeof node === 'object') {
    acc.push(node);
    const graph = (node as Record<string, unknown>)['@graph'];
    if (graph) flattenJsonLd(graph, acc);
  }
  return acc;
}

function isProductNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const type = (node as Record<string, unknown>)['@type'];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && /product/i.test(t));
}

function brandOf(b: unknown): string | undefined {
  if (!b) return undefined;
  if (typeof b === 'string') return b;
  if (Array.isArray(b)) return brandOf(b[0]);
  if (typeof b === 'object') return str((b as Record<string, unknown>).name);
  return undefined;
}

function priceOf(offers: unknown): string | undefined {
  if (!offers) return undefined;
  const list = Array.isArray(offers) ? offers : [offers];
  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    const price = r.price ?? r.lowPrice ?? (r.priceSpecification as Record<string, unknown> | undefined)?.price;
    const currency = str(r.priceCurrency) ?? str((r.priceSpecification as Record<string, unknown> | undefined)?.priceCurrency);
    if (price !== undefined && price !== null && price !== '') return formatPrice(String(price), currency);
  }
  return undefined;
}

function imagesOf(img: unknown): string[] {
  if (!img) return [];
  if (typeof img === 'string') return [img];
  if (Array.isArray(img)) return img.flatMap(imagesOf);
  if (typeof img === 'object') {
    const r = img as Record<string, unknown>;
    return imagesOf(r.url ?? r.contentUrl);
  }
  return [];
}

// ---------- Amazon ----------

function applyAmazon($: Cheerio, out: Extracted) {
  out.title ??= $('#productTitle').text().trim() || undefined;
  const byline = $('#bylineInfo').text().trim();
  if (byline && !out.brand) {
    const m = byline.match(/(?:Visit the (.+?) Store|Brand:\s*(.+))/i);
    out.brand = (m?.[1] ?? m?.[2] ?? byline).trim();
  }
  if (!out.price) {
    const p = $('#corePrice_feature_div .a-offscreen, #apex_desktop .a-offscreen, .priceToPay .a-offscreen, #price_inside_buybox')
      .first()
      .text()
      .trim();
    if (p) out.price = p;
  }
  // Gallery images live in a JSON attribute: {"url": [w, h], ...}
  $('#landingImage, #imgBlkFront, .a-dynamic-image, #altImages img').each((_, el) => {
    const dyn = $(el).attr('data-a-dynamic-image');
    if (dyn) {
      try {
        const parsed = JSON.parse(dyn) as Record<string, [number, number]>;
        const best = Object.entries(parsed).sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1]);
        for (const [u] of best) out.images.push(u);
      } catch {
        /* ignore */
      }
    }
    const hires = $(el).attr('data-old-hires') || $(el).attr('src');
    if (hires) out.images.push(upsizeAmazon(hires));
  });
  // Color/alt thumbnails are tiny; request the large variant.
  const colorImages = $.html().match(/"hiRes":"(https:[^"]+)"/g) ?? [];
  for (const m of colorImages) {
    const u = m.match(/"hiRes":"(https:[^"]+)"/)?.[1];
    if (u) out.images.push(u);
  }
}

function upsizeAmazon(u: string): string {
  // https://m.media-amazon.com/images/I/71abc._AC_SX38_.jpg -> strip size modifiers
  return u.replace(/\._[A-Z0-9_,]+_\.(jpg|png|webp)/i, '.$1');
}

// ---------- Open Graph / meta ----------

function applyOpenGraph($: Cheerio, out: Extracted, pageUrl: string) {
  const meta = (sel: string) => $(sel).attr('content')?.trim() || undefined;
  out.title ??= meta('meta[property="og:title"]') ?? meta('meta[name="twitter:title"]');
  out.description ??= meta('meta[property="og:description"]') ?? meta('meta[name="description"]');
  out.brand ??= meta('meta[property="product:brand"]') ?? meta('meta[property="og:brand"]');
  if (!out.price) {
    const amount = meta('meta[property="product:price:amount"]') ?? meta('meta[property="og:price:amount"]');
    const currency = meta('meta[property="product:price:currency"]') ?? meta('meta[property="og:price:currency"]');
    if (amount) out.price = formatPrice(amount, currency);
  }
  $('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"], meta[itemprop="image"]').each(
    (_, el) => {
      const c = $(el).attr('content');
      if (c) out.images.push(absolutize(c, pageUrl));
    },
  );
  const siteName = meta('meta[property="og:site_name"]');
  if (siteName && !out.brand) out.brand = siteName;
}

// ---------- Generic ----------

function applyGenericFallbacks($: Cheerio, out: Extracted, pageUrl: string) {
  out.title ??= $('h1').first().text().trim() || $('title').first().text().trim() || undefined;
  if (!out.price) {
    const text = $('[itemprop="price"]').attr('content') ?? $('[itemprop="price"]').first().text();
    const candidate = text?.trim();
    if (candidate && /\d/.test(candidate)) {
      const currency = $('[itemprop="priceCurrency"]').attr('content');
      out.price = formatPrice(candidate, currency);
    }
  }
  if (!out.price) {
    // Look for a visible price-ish string near the top of the body.
    const body = $('body').text();
    const m = body.match(/(?:[$€£¥]\s?\d{1,5}(?:[.,]\d{2,3})?(?:[.,]\d{2})?)/);
    if (m) out.price = m[0].replace(/\s/g, '');
  }
  // Gallery images: prefer large <img> in product-y containers, then any big srcset.
  const selectors = [
    '[class*="gallery"] img',
    '[class*="product"] img',
    '[class*="carousel"] img',
    '[id*="gallery"] img',
    'main img',
    'picture source',
  ];
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const $el = $(el);
      const srcset = $el.attr('srcset') ?? $el.attr('data-srcset');
      if (srcset) {
        const best = pickLargestFromSrcset(srcset);
        if (best) out.images.push(absolutize(best, pageUrl));
      }
      const src = $el.attr('data-src') ?? $el.attr('data-zoom-image') ?? $el.attr('data-large_image') ?? $el.attr('src');
      if (src && !src.startsWith('data:')) out.images.push(absolutize(src, pageUrl));
    });
    if (out.images.length > 24) break;
  }
}

function pickLargestFromSrcset(srcset: string): string | undefined {
  let best: { url: string; w: number } | undefined;
  for (const part of srcset.split(',')) {
    const [url, size] = part.trim().split(/\s+/);
    if (!url) continue;
    const w = size ? parseFloat(size) * (size.endsWith('x') ? 1000 : 1) : 0;
    if (!best || w > best.w) best = { url, w };
  }
  return best?.url;
}

// ---------- helpers ----------

function isLikelyProductImage(u: string): boolean {
  if (!/^https?:/i.test(u)) return false;
  if (/\.(svg|gif)(\?|$)/i.test(u)) return false;
  if (/(sprite|icon|logo|badge|flag|pixel|tracking|avatar|placeholder|spinner|loading|1x1|blank)/i.test(u)) return false;
  return true;
}

function absolutize(u: string, base: string): string {
  try {
    return new URL(u.trim(), base).toString();
  } catch {
    return u;
  }
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of list) {
    const key = u.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'CA$', AUD: 'A$' };

export function formatPrice(amount: string, currency?: string): string {
  const trimmed = amount.trim();
  if (/^[^\d]/.test(trimmed)) return trimmed; // already has a symbol
  const num = Number(trimmed.replace(/,/g, ''));
  if (!Number.isFinite(num)) return trimmed;
  const sym = currency ? SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} ` : '$';
  const fixed = Number.isInteger(num) ? num.toString() : num.toFixed(2);
  return `${sym}${fixed}`;
}
