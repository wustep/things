import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createJimp } from '@jimp/core';
import type { Bitmap } from '@jimp/types';
import decodeAvif, { init as initAvif } from '@jsquash/avif/decode.js';
import decodeWebp, { init as initWebp } from '@jsquash/webp/decode.js';
import { defaultFormats, defaultPlugins } from 'jimp';

/** Stock jimp plus WebP and AVIF decoding: most product CDNs serve those to modern clients. */
const Jimp = createJimp({
  formats: [...defaultFormats, () => wasmFormat('image/webp', decodeWebp), () => wasmFormat('image/avif', decodeAvif)],
  plugins: defaultPlugins,
});

const require = createRequire(import.meta.url);
let decodersReady: Promise<void> | undefined;

/**
 * jsquash's emscripten glue locates its .wasm by URL and fetches it, which Node cannot do for
 * file URLs. Compile the modules from disk once and hand them over instead.
 */
function ensureDecoders(): Promise<void> {
  return (decodersReady ??= (async () => {
    const compile = async (pkg: string, file: string) => {
      const dir = path.dirname(require.resolve(`${pkg}/decode.js`));
      return WebAssembly.compile(await readFile(path.join(dir, 'codec', 'dec', file)));
    };
    // The webp typings predate the (module, options) signature the runtime accepts.
    const initWebpModule = initWebp as unknown as (m: WebAssembly.Module) => Promise<void>;
    await initWebpModule(await compile('@jsquash/webp', 'webp_dec.wasm'));
    await initAvif(await compile('@jsquash/avif', 'avif_dec.wasm'));
  })());
}

function wasmFormat(mime: 'image/webp' | 'image/avif', decode: (buf: ArrayBuffer) => Promise<ImageData>) {
  return {
    mime,
    hasAlpha: true,
    decode: async (data: Buffer): Promise<Bitmap> => {
      await ensureDecoders();
      const copy = new Uint8Array(data); // a fresh ArrayBuffer of exactly these bytes
      const img = await decode(copy.buffer);
      return { data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height };
    },
    encode: (): Buffer => {
      throw new Error(`${mime} encoding is not supported; references are stored as JPEG and PNG`);
    },
  };
}

export interface ProcessedPrimary {
  png: Buffer;
  width: number;
  height: number;
  aspect: number;
  palette: string[];
  /** Fraction of pixels that were keyed out as background. */
  removedFraction: number;
  /** Pixel area of the subject's bounding box before the final downscale; bigger = sharper texture. */
  subjectArea: number;
}

type Img = Awaited<ReturnType<typeof Jimp.fromBuffer>>;

export async function decode(buffer: Buffer): Promise<Img> {
  return Jimp.fromBuffer(buffer);
}

/** Downscale a reference image to a sane size and re-encode as JPEG. */
export async function normalizeReference(buffer: Buffer, maxSide = 1200): Promise<{ jpg: Buffer; width: number; height: number }> {
  const img = await decode(buffer);
  flattenOntoWhite(img);
  fit(img, maxSide);
  const jpg = await img.getBuffer('image/jpeg', { quality: 86 });
  return { jpg, width: img.bitmap.width, height: img.bitmap.height };
}

/**
 * Turn a product photo into a floating cut-out: flood-fill the background from the
 * edges (so interior highlights survive), trim to the subject, pad, and resize.
 */
export async function processPrimary(buffer: Buffer, maxSide = 1024): Promise<ProcessedPrimary> {
  const img = await decode(buffer);
  flattenOntoWhite(img);
  fit(img, 1400);

  const { width, height, data } = img.bitmap;
  const bg = estimateBackground(data, width, height);
  const removed = bg ? keyOutBackground(data, width, height, bg) : 0;
  const removedFraction = removed / (width * height);

  const box = opaqueBounds(data, width, height);
  const pad = Math.round(Math.max(box.w, box.h) * 0.04);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const w = Math.min(width - x, box.w + pad * 2);
  const h = Math.min(height - y, box.h + pad * 2);
  if (w > 8 && h > 8 && (w < width || h < height)) img.crop({ x, y, w, h });

  fit(img, maxSide);
  const palette = extractPalette(img.bitmap.data, img.bitmap.width, img.bitmap.height);
  const png = await img.getBuffer('image/png');
  return {
    png,
    width: img.bitmap.width,
    height: img.bitmap.height,
    aspect: img.bitmap.width / img.bitmap.height,
    palette,
    removedFraction,
    subjectArea: box.w * box.h,
  };
}

function fit(img: Img, maxSide: number) {
  const { width, height } = img.bitmap;
  const scale = maxSide / Math.max(width, height);
  if (scale < 1) img.resize({ w: Math.round(width * scale), h: Math.round(height * scale) });
}

/** Composite semi-transparent sources onto white so keying behaves predictably. */
function flattenOntoWhite(img: Img) {
  const d = img.bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a === 1) continue;
    d[i] = Math.round(d[i] * a + 255 * (1 - a));
    d[i + 1] = Math.round(d[i + 1] * a + 255 * (1 - a));
    d[i + 2] = Math.round(d[i + 2] * a + 255 * (1 - a));
    d[i + 3] = 255;
  }
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Sample the border; if it is mostly one flat color, that is the background. */
function estimateBackground(data: Buffer, w: number, h: number): RGB | null {
  const samples: RGB[] = [];
  const step = Math.max(1, Math.floor((w + h) / 200));
  for (let x = 0; x < w; x += step) {
    samples.push(px(data, w, x, 0), px(data, w, x, h - 1));
  }
  for (let y = 0; y < h; y += step) {
    samples.push(px(data, w, 0, y), px(data, w, w - 1, y));
  }
  const mean = samples.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b }), { r: 0, g: 0, b: 0 });
  mean.r /= samples.length;
  mean.g /= samples.length;
  mean.b /= samples.length;
  const close = samples.filter((c) => dist(c, mean) < 40).length / samples.length;
  // Only key when the border is consistently flat; otherwise leave the image intact.
  return close > 0.8 ? mean : null;
}

function keyOutBackground(data: Buffer, w: number, h: number, bg: RGB): number {
  const tol = isNearWhite(bg) ? 46 : 34;
  const soft = tol * 1.6;
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * w + x;
    if (!visited[i]) {
      visited[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  let removed = 0;
  while (stack.length) {
    const i = stack.pop()!;
    const o = i * 4;
    const d = dist({ r: data[o], g: data[o + 1], b: data[o + 2] }, bg);
    if (d > soft) continue;
    // Soft edge: partially transparent between tol and soft.
    const alpha = d <= tol ? 0 : Math.round(((d - tol) / (soft - tol)) * 255);
    data[o + 3] = alpha;
    if (alpha === 0) removed++;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  return removed;
}

function opaqueBounds(data: Buffer, w: number, h: number) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Coarse color quantization over opaque pixels; returns up to 4 distinct hex colors. */
export function extractPalette(data: Buffer, w: number, h: number): string[] {
  const bins = new Map<string, { n: number; r: number; g: number; b: number }>();
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const o = (y * w + x) * 4;
      if (data[o + 3] < 200) continue;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const key = `${r >> 5},${g >> 5},${b >> 5}`;
      const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bins.set(key, bin);
    }
  }
  const ranked = [...bins.values()]
    .map((b) => ({ n: b.n, r: b.r / b.n, g: b.g / b.n, b: b.b / b.n }))
    .sort((a, b) => b.n - a.n);
  const picked: RGB[] = [];
  for (const c of ranked) {
    if (picked.some((p) => dist(p, c) < 60)) continue;
    picked.push(c);
    if (picked.length === 4) break;
  }
  // Prefer a saturated accent as the first entry when the dominant color is a neutral.
  picked.sort((a, b) => score(b) - score(a));
  return picked.length ? picked.map(hex) : ['#8a8a8a'];
}

function score(c: RGB): number {
  const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
  const sat = max === 0 ? 0 : (max - min) / max;
  const lum = (c.r + c.g + c.b) / (3 * 255);
  return sat * 2 + (1 - Math.abs(lum - 0.5));
}

function px(data: Buffer, w: number, x: number, y: number): RGB {
  const o = (y * w + x) * 4;
  return { r: data[o], g: data[o + 1], b: data[o + 2] };
}

function dist(a: RGB, b: RGB): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function isNearWhite(c: RGB): boolean {
  return c.r > 225 && c.g > 225 && c.b > 225;
}

function hex(c: RGB): string {
  return '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}
