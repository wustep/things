/**
 * Share cards (Open Graph images): one 1200×630 JPEG per thing, made at build time. The thing's
 * cut-out stands on a shelf lip in the site's dark room, in a pool of lamplight, with its maker
 * and name set on the shelf's face below, as the shelf labels its things. No chrome.
 *
 * The text is drawn as glyph outlines from the site's own fonts (Spectral, IBM Plex Mono), read
 * with opentype.js, so the card looks the same on any machine: sharp's own text goes through
 * fontconfig, which can't load a web font and silently falls back to a system face.
 *
 * Also the room for the shelf's own card (tools/images/home-card.ts), which keeps its lower lip.
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import opentype, { type Font, type Path } from 'opentype.js';
import sharp from 'sharp';

export const W = 1200, H = 630;
/** The shelf line on the shelf's own card (tools/images/home-card.ts). */
export const LIP = 520;
/** The shelf line on a thing's card: higher, so its maker and name fit on the face below. */
export const CARD_LIP = 448;
/** The box a thing must fit in above the lip. */
const FIT = { w: 920, h: 360 };
/** Text: centred, within this width. */
const TEXT_W = 1040;

export interface Hero {
  base: string;
  widths: number[];
  subject: [number, number, number, number];
}

/** Bump to remake every card (a change in this file that changes the picture). */
export const CARD_VERSION = 1;

/** The room, as on the site (style.css: --night, --lamp, the shelf lip). */
export function roomSvg(lip: number, extra = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="pool">
      <stop offset="0" stop-color="#ffd59e" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#ffd59e" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="wall"><rect width="${W}" height="${lip}"/></clipPath>
    <radialGradient id="corners" cx="50%" cy="45%" r="75%">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.4"/>
    </radialGradient>
    <linearGradient id="lip" x1="0" x2="1">
      <stop offset="0" stop-color="#3d362d" stop-opacity="0"/>
      <stop offset="0.08" stop-color="#3d362d"/>
      <stop offset="0.92" stop-color="#3d362d"/>
      <stop offset="1" stop-color="#3d362d" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="face" x1="0" x2="1">
      <stop offset="0" stop-color="#221e19" stop-opacity="0"/>
      <stop offset="0.08" stop-color="#221e19"/>
      <stop offset="0.92" stop-color="#221e19"/>
      <stop offset="1" stop-color="#221e19" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#13110e"/>
  <ellipse cx="${W / 2}" cy="${lip}" rx="560" ry="360" fill="url(#pool)" clip-path="url(#wall)"/>
  <rect y="${lip}" width="${W}" height="14" fill="url(#face)"/>
  <rect y="${lip}" width="${W}" height="1.5" fill="url(#lip)"/>
  <rect width="${W}" height="${H}" fill="url(#corners)"/>${extra}
</svg>`;
}

/** The shelf's own card's room (home-card.ts), drawn once. */
export const room = sharp(Buffer.from(roomSvg(LIP))).png();

// ---- Text ----

const require = createRequire(import.meta.url);
const fontFile = (pkg: string, file: string) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'files', file);
let fonts: Promise<{ serif: Font; mono: Font }> | undefined;
function loadFonts() {
  const load = async (f: string) => {
    const b = await readFile(f);
    return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  };
  return (fonts ??= Promise.all([
    load(fontFile('@fontsource/spectral', 'spectral-latin-300-normal.woff')),
    load(fontFile('@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff')),
  ]).then(([serif, mono]) => ({ serif, mono })));
}

/** Width of a line set with extra letter-spacing (in px) after each character but the last. */
function width(font: Font, text: string, size: number, tracking = 0): number {
  if (!tracking) return font.getAdvanceWidth(text, size, { kerning: true });
  const chars = [...text];
  return chars.reduce((s, c) => s + font.getAdvanceWidth(c, size), 0) + tracking * (chars.length - 1);
}

/**
 * A path's commands as SVG path data. (opentype.js 2.0's own toPathData writes NaN for some
 * coordinates, depending on where the line starts, and the renderer stops drawing there.)
 */
function pathData(p: Path): string {
  const n = (v: number) => {
    if (!Number.isFinite(v)) throw new Error(`bad glyph coordinate ${v}`);
    return (Math.round(v * 100) / 100).toString();
  };
  let d = '';
  for (const c of p.commands) {
    if (c.type === 'M' || c.type === 'L') d += `${c.type}${n(c.x)} ${n(c.y)}`;
    else if (c.type === 'Q') d += `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
    else if (c.type === 'C') d += `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
    else d += 'Z';
  }
  return d;
}

/** One centred line as SVG path data, at baseline y. Letter-spaced lines are set a glyph at a time. */
function line(font: Font, text: string, size: number, y: number, tracking = 0): string {
  let x = (W - width(font, text, size, tracking)) / 2;
  if (!tracking) return pathData(font.getPath(text, x, y, size, { kerning: true }));
  let d = '';
  for (const c of text) {
    d += pathData(font.getPath(c, x, y, size));
    x += font.getAdvanceWidth(c, size) + tracking;
  }
  return d;
}

/** The largest size from max down to min that fits; below that, the text is cut with an ellipsis. */
function fit(font: Font, text: string, max: number, min: number, tracking = 0): { text: string; size: number } {
  for (let size = max; size >= min; size -= 1) if (width(font, text, size, tracking * size) <= TEXT_W) return { text, size };
  let t = text;
  while (t.length > 1 && width(font, `${t}…`, min, tracking * min) > TEXT_W) t = t.slice(0, -1);
  return { text: `${t.trimEnd()}…`, size: min };
}

export interface Label {
  /** The maker, set small in capitals (may be absent). */
  brand?: string;
  /** The thing's name, without the maker. */
  name: string;
}

/** How a label is set: each line's text (cut with an ellipsis only if it can't fit at the smallest size) and size. */
export async function labelLayout({ brand, name }: Label) {
  const { serif, mono } = await loadFonts();
  return { brand: brand?.trim() ? fit(mono, brand.trim().toUpperCase(), 17, 13, 0.2) : undefined, name: fit(serif, name, 54, 36) };
}

/** The maker and name, as path data on the shelf's face. */
export async function labelSvg({ brand, name }: Label): Promise<string> {
  const { serif, mono } = await loadFonts();
  const n = fit(serif, name, 54, 36);
  const paths: string[] = [];
  if (brand?.trim()) {
    const b = fit(mono, brand.trim().toUpperCase(), 17, 13, 0.2);
    paths.push(`<path fill="#8e8577" d="${line(mono, b.text, b.size, CARD_LIP + 58, 0.2 * b.size)}"/>`);
    paths.push(`<path fill="#ede6da" d="${line(serif, n.text, n.size, CARD_LIP + 58 + 18 + n.size * 0.92, 0)}"/>`);
  } else {
    paths.push(`<path fill="#ede6da" d="${line(serif, n.text, n.size, CARD_LIP + (H - CARD_LIP) / 2 + n.size * 0.32, 0)}"/>`);
  }
  return paths.join('\n  ');
}

// ---- The card ----

/** The hero's largest cut-out file (in public/). */
export function heroFile(publicDir: string, hero: Hero): string {
  return path.join(publicDir, `${hero.base}-${Math.max(...hero.widths)}.webp`);
}

/** Just the object (the hero's padding trimmed), scaled to stand on the lip. */
async function cutout(src: Buffer, hero: Hero, fitBox: { w: number; h: number }) {
  const img = sharp(src);
  const { width = 0, height = 0 } = await img.metadata();
  const [l, t, w, h] = hero.subject;
  const left = Math.max(0, Math.floor(l * width)), top = Math.max(0, Math.floor(t * height));
  const box = { left, top, width: Math.min(width - left, Math.ceil(w * width)), height: Math.min(height - top, Math.ceil(h * height)) };
  const scale = Math.min(fitBox.w / box.width, fitBox.h / box.height);
  return img
    .extract(box)
    .resize(Math.round(box.width * scale), Math.round(box.height * scale), { kernel: 'lanczos3' })
    .png()
    .toBuffer({ resolveWithObject: true });
}

/** A thing's card, from its hero cut-out (the file's bytes) and its label. */
export async function itemCard(heroSrc: Buffer, hero: Hero, label: Label): Promise<Buffer> {
  const thing = await cutout(heroSrc, hero, FIT);
  const bg = Buffer.from(roomSvg(CARD_LIP, `\n  ${await labelSvg(label)}`));
  return sharp(bg)
    .composite([{ input: thing.data, left: Math.round((W - thing.info.width) / 2), top: CARD_LIP - thing.info.height + 2 }])
    .flatten({ background: '#13110e' })
    .jpeg({ quality: 84, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
}
