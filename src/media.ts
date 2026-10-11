/**
 * The 2D image set (`npm run images` → data/media.json + public/items/<id>/2d/). Items that have
 * not been through it yet (a fresh paste-to-ingest) fall back to ingest's own cut-out.
 */
import type { Item } from '../shared/types.ts';
import { assetUrl } from './data.ts';
import mediaJson from '../data/media.json';
import sizesJson from '../data/sizes.json';

export interface MediaImage {
  base: string;
  widths: number[];
  width: number;
  height: number;
}
export interface Hero extends MediaImage {
  mode: 'cutout' | 'photo';
  /** Object box inside the image: left, top, width, height as fractions. */
  subject: [number, number, number, number];
  tone: string;
}
export interface Media {
  hero: Hero;
  gallery: MediaImage[];
}

let media = mediaJson as unknown as Record<string, Media & { key?: string }>;

export function setMedia(next: unknown) {
  if (next && typeof next === 'object') media = next as typeof media;
}

/** Hero for an item: the processed cut-out, or ingest's keyed primary.png until `npm run images` has run. */
export function heroFor(item: Item): Hero & { fallback?: string } {
  const m = media[item.id];
  if (m?.hero) return m.hero;
  const proc = item.asset.kind === 'glb' ? item.asset.fallback : item.asset;
  const aspect = proc.aspect > 0 ? proc.aspect : 1;
  return {
    base: '',
    widths: [],
    width: Math.round(800 * Math.min(1, aspect)),
    height: Math.round(800 / Math.max(1, aspect)),
    mode: 'cutout',
    subject: [0, 0, 1, 1],
    tone: proc.palette[0] ?? '#6f675e',
    fallback: proc.texture,
  };
}

export function galleryFor(item: Item): MediaImage[] {
  return media[item.id]?.gallery ?? [];
}

/**
 * A <picture> with AVIF and WebP candidates. `sizes` is what the layout knows about the display
 * width, so the browser never pulls the 1600px file for a 90px thumbnail.
 */
export function picture(img: MediaImage & { fallback?: string }, opts: { alt: string; sizes: string; eager?: boolean; className?: string }): HTMLPictureElement {
  const pic = document.createElement('picture');
  const el = document.createElement('img');
  el.alt = opts.alt;
  el.decoding = 'async';
  el.loading = opts.eager ? 'eager' : 'lazy';
  if (opts.eager) el.setAttribute('fetchpriority', 'high');
  el.width = img.width;
  el.height = img.height;
  if (opts.className) el.className = opts.className;
  if (img.fallback) {
    el.src = assetUrl(img.fallback);
  } else {
    for (const ext of ['avif', 'webp'] as const) {
      const source = document.createElement('source');
      source.type = `image/${ext}`;
      source.srcset = img.widths.map((w) => `${assetUrl(`${img.base}-${w}.${ext}`)} ${w}w`).join(', ');
      source.sizes = opts.sizes;
      pic.append(source);
    }
    el.src = assetUrl(`${img.base}-${img.widths[Math.min(1, img.widths.length - 1)]}.webp`);
  }
  pic.append(el);
  return pic;
}

// ---------- real size ----------

const SIZES = new Map(
  Object.entries(sizesJson).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0),
);
const MEDIAN_CM = (() => {
  const v = [...SIZES.values()].sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : 50;
})();

/** Largest real dimension in cm (data/sizes.json), or the shelf's median when unknown. */
export function realSizeCm(item: Item): number {
  return SIZES.get(item.id) ?? MEDIAN_CM;
}

/**
 * True scale would make a watch a speck next to a sofa. Size grows with the square root of the
 * real size instead: a sofa still reads as the biggest thing on the shelf, a mouse is about a
 * third of it rather than a sixteenth.
 */
export const SCALE_EXPONENT = 0.5;
export const REFERENCE_CM = 60;
