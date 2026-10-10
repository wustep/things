/**
 * Local clean-up for Meshy GLBs, no API calls. Meshy bakes its colour into an atlas of hundreds
 * of small UV islands, and each island comes out a slightly different brightness: on a plain
 * surface (brushed steel, matte plastic, a fabric shade) that reads as camouflage. Image filters
 * can't fix it, because islands that touch on the object sit far apart in the atlas. So the
 * colour is evened out on the mesh instead:
 *
 *   1. sample a low-passed luminance at every vertex through its UV;
 *   2. weld vertices by position and Laplacian-smooth that luminance across the surface, which
 *      ignores UV seams;
 *   3. rasterize each triangle's per-vertex gain (smoothed / sampled) back into UV space;
 *   4. scale the texels by it, luminance only, so labels and edges keep their chroma and detail.
 *
 * Alongside: albedo lift (near-black plastics otherwise vanish on a black page), a roughness
 * floor and optional metalness / roughness overrides baked into the metallic-roughness map.
 * Every step is close to idempotent, and the GLB records what was applied in its asset extras.
 */
import { type Document, type Primitive, type Texture } from '@gltf-transform/core';
import { decode, type Img } from './images.ts';

export interface Finish {
  /** 0..1: how far patchy island brightness is pulled toward the mesh-smoothed value. */
  harmonize?: number;
  /** 0..1: also pull each texel toward the smoothed surface value (for uniform finishes). */
  flatten?: number;
  /** Laplacian iterations for harmonize; more = broader evening-out. */
  spread?: number;
  /** Linear albedo floor, e.g. 0.03 lifts black plastic just off the void. */
  lift?: number;
  /** Bake a roughness floor into the metallic-roughness map. */
  roughnessMin?: number;
  /** Replace roughness with this constant (a uniform finish, e.g. brushed steel). */
  roughness?: number;
  /** Replace metalness with this constant (0 for wood/plastic Meshy marked as metal). */
  metalness?: number;
  /** Multiply base colour saturation (1 = as is). */
  saturation?: number;
}

export const DEFAULT_FINISH: Required<Pick<Finish, 'harmonize' | 'spread' | 'roughnessMin'>> = {
  harmonize: 0.4,
  spread: 60,
  roughnessMin: 0.3,
};

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export async function refineDocument(doc: Document, finish: Finish, log: (m: string) => void = () => {}): Promise<void> {
  const f = { ...DEFAULT_FINISH, ...finish };
  const root = doc.getRoot();
  for (const material of root.listMaterials()) {
    const prims = root
      .listMeshes()
      .flatMap((m) => m.listPrimitives())
      .filter((p) => p.getMaterial() === material);
    const base = material.getBaseColorTexture();
    if (base && prims.length && (f.harmonize > 0 || f.lift || (f.saturation ?? 1) !== 1)) {
      const img = await read(base);
      if (f.harmonize > 0) {
        const stats = harmonize(img, prims, f.harmonize, f.spread, f.flatten ?? 0);
        log(`harmonize ${f.harmonize} over ${stats.vertices} vertices, mean |gain-1| ${stats.meanShift.toFixed(3)}`);
      }
      if (f.lift || (f.saturation ?? 1) !== 1) tone(img, f.lift ?? 0, f.saturation ?? 1);
      await write(base, img, 'image/jpeg', 90);
    }
    const mr = material.getMetallicRoughnessTexture();
    if (mr && (f.roughnessMin || f.roughness !== undefined || f.metalness !== undefined)) {
      const img = await read(mr);
      const d = img.bitmap.data;
      for (let i = 0; i < d.length; i += 4) {
        // glTF: green = roughness, blue = metalness (linear data).
        let g = d[i + 1] / 255;
        if (f.roughness !== undefined) g = f.roughness;
        if (f.roughnessMin) g = Math.max(g, f.roughnessMin);
        d[i + 1] = Math.round(g * 255);
        if (f.metalness !== undefined) d[i + 2] = Math.round(f.metalness * 255);
      }
      await write(mr, img, 'image/jpeg', 92);
      material.setRoughnessFactor(1).setMetallicFactor(1);
    }
  }
  root.setExtras({ ...(root.getExtras() as object), thingsFinish: f });
}

async function read(tex: Texture): Promise<Img> {
  return decode(Buffer.from(tex.getImage()!));
}

async function write(tex: Texture, img: Img, mime: 'image/jpeg', quality: number) {
  const out = await img.getBuffer(mime, { quality });
  tex.setImage(new Uint8Array(out)).setMimeType(mime);
}

/** Luminance-only albedo lift and saturation, in linear light. */
function tone(img: Img, lift: number, saturation: number) {
  const d = img.bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = toLin(d[i] / 255);
    let g = toLin(d[i + 1] / 255);
    let b = toLin(d[i + 2] / 255);
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (saturation !== 1) {
      r = y + (r - y) * saturation;
      g = y + (g - y) * saturation;
      b = y + (b - y) * saturation;
    }
    if (lift > 0) {
      r = lift + r * (1 - lift);
      g = lift + g * (1 - lift);
      b = lift + b * (1 - lift);
    }
    d[i] = Math.round(toSrgb(clamp01(r)) * 255);
    d[i + 1] = Math.round(toSrgb(clamp01(g)) * 255);
    d[i + 2] = Math.round(toSrgb(clamp01(b)) * 255);
  }
}

interface Tri {
  uv: [number, number, number, number, number, number]; // pixel space
  v: [number, number, number]; // global vertex ids
}

function harmonize(img: Img, prims: Primitive[], strength: number, spread: number, flatten: number) {
  const W = img.bitmap.width;
  const H = img.bitmap.height;
  const d = img.bitmap.data;

  // Linear luminance per texel.
  const lum = new Float32Array(W * H);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    lum[p] = 0.2126 * toLin(d[i] / 255) + 0.7152 * toLin(d[i + 1] / 255) + 0.0722 * toLin(d[i + 2] / 255);
  }

  // Gather triangles from every primitive into one vertex space.
  const tris: Tri[] = [];
  const posKey: string[] = [];
  const vu: number[] = [];
  const vv: number[] = [];
  const a3 = [0, 0, 0];
  const a2 = [0, 0];
  for (const prim of prims) {
    const pos = prim.getAttribute('POSITION');
    const uv = prim.getAttribute('TEXCOORD_0');
    if (!pos || !uv) continue;
    const offset = posKey.length;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, a3);
      uv.getElement(i, a2);
      // Weld tolerance: positions quantized to ~1e-4 of the model.
      posKey.push(`${Math.round(a3[0] * 1e4)},${Math.round(a3[1] * 1e4)},${Math.round(a3[2] * 1e4)}`);
      vu.push(a2[0] * W - 0.5);
      vv.push(a2[1] * H - 0.5);
    }
    const idx = prim.getIndices();
    const count = idx ? idx.getCount() : pos.getCount();
    for (let t = 0; t + 2 < count; t += 3) {
      const i0 = offset + (idx ? idx.getScalar(t) : t);
      const i1 = offset + (idx ? idx.getScalar(t + 1) : t + 1);
      const i2 = offset + (idx ? idx.getScalar(t + 2) : t + 2);
      tris.push({ v: [i0, i1, i2], uv: [vu[i0], vv[i0], vu[i1], vv[i1], vu[i2], vv[i2]] });
    }
  }
  const n = posKey.length;

  // UV islands: Meshy splits vertices along UV seams, so triangles connected through shared
  // (unwelded) vertex indices form one island of the atlas.
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const t of tris) {
    const a = find(t.v[0]);
    parent[find(t.v[1])] = a;
    parent[find(t.v[2])] = a;
  }
  const islandOf = new Int32Array(n);
  const islandIds = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let k = islandIds.get(r);
    if (k === undefined) islandIds.set(r, (k = islandIds.size));
    islandOf[i] = k;
  }
  // Exact island means over the texels each island covers.
  const islandSum = new Float64Array(islandIds.size);
  const islandCnt = new Float64Array(islandIds.size);
  for (const t of tris) {
    const k = islandOf[t.v[0]];
    raster(t.uv, W, H, (p) => {
      islandSum[k] += lum[p];
      islandCnt[k]++;
    }, false);
  }
  const islandMean = new Float32Array(islandIds.size);
  for (let k = 0; k < islandMean.length; k++) islandMean[k] = islandCnt[k] ? islandSum[k] / islandCnt[k] : 0;

  // Per welded point: the mean of the islands that meet there.
  const weld = new Map<string, number>();
  const wid = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let w = weld.get(posKey[i]);
    if (w === undefined) weld.set(posKey[i], (w = weld.size));
    wid[i] = w;
  }
  const m = weld.size;
  const sum = new Float32Array(m);
  const cnt = new Float32Array(m);
  for (let i = 0; i < n; i++) {
    sum[wid[i]] += islandMean[islandOf[i]];
    cnt[wid[i]]++;
  }
  let field = new Float32Array(m);
  for (let w = 0; w < m; w++) field[w] = sum[w] / cnt[w];

  // Welded adjacency (edges of every triangle), then Laplacian smoothing on the surface.
  const nbr: number[][] = Array.from({ length: m }, () => []);
  for (const t of tris) {
    const [a, b, c] = t.v.map((i) => wid[i]);
    nbr[a].push(b, c);
    nbr[b].push(a, c);
    nbr[c].push(a, b);
  }
  for (let it = 0; it < spread; it++) {
    const next = new Float32Array(m);
    for (let w = 0; w < m; w++) {
      const list = nbr[w];
      if (!list.length) {
        next[w] = field[w];
        continue;
      }
      let s = 0;
      for (const k of list) s += field[k];
      next[w] = 0.5 * field[w] + 0.5 * (s / list.length);
    }
    field = next;
  }

  // Per-vertex gain: the smoothed surface value over the vertex's own island mean. Welded copies
  // on either side of a seam share the field value, so each island lands on the same brightness
  // where they meet; inside an island the gain varies smoothly, keeping its detail.
  const gain = new Float32Array(n);
  let shift = 0;
  for (let i = 0; i < n; i++) {
    const ratio = (field[wid[i]] + 0.004) / (islandMean[islandOf[i]] + 0.004);
    gain[i] = Math.min(1.8, Math.max(0.55, ratio ** strength));
    shift += Math.abs(gain[i] - 1);
  }

  // Rasterize gains into UV space (barycentric), dilate into the gutter, apply.
  const gmap = new Float32Array(W * H).fill(1);
  const tmap = new Float32Array(W * H);
  const have = new Uint8Array(W * H);
  for (const t of tris) {
    const [g0, g1, g2] = t.v.map((i) => gain[i]);
    const [f0, f1, f2] = t.v.map((i) => field[wid[i]]);
    raster(t.uv, W, H, (p, b0, b1, b2) => {
      gmap[p] = g0 * b0 + g1 * b1 + g2 * b2;
      tmap[p] = f0 * b0 + f1 * b1 + f2 * b2;
      have[p] = 1;
    });
  }
  const haveT = have.slice();
  dilate(gmap, have, W, H, 4);
  dilate(tmap, haveT, W, H, 4);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    if (!have[p]) continue;
    const l = lum[p];
    // Target luminance: the evened-out texel, then (optionally) most of the way to the field.
    const target = l * gmap[p] * (1 - flatten) + tmap[p] * flatten;
    const k = (target + 1e-4) / (l + 1e-4);
    for (let c = 0; c < 3; c++) d[i + c] = Math.round(toSrgb(clamp01(toLin(d[i + c] / 255) * k)) * 255);
  }
  return { vertices: m, meanShift: shift / n };
}

/** Visit pixel centres inside a triangle given in pixel space, with barycentric weights. */
function raster(t: Tri['uv'], W: number, H: number, visit: (p: number, b0: number, b1: number, b2: number) => void, pad = true) {
  const [x0, y0, x1, y1, x2, y2] = t;
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-9) return;
  // Pad by a pixel so thin slivers still cover their texels (and seams get both sides).
  const minX = clampInt(Math.floor(Math.min(x0, x1, x2)) - 1, 0, W - 1);
  const eps = pad ? 1.2 / Math.sqrt(Math.abs(area)) : 0;
  const maxX = clampInt(Math.ceil(Math.max(x0, x1, x2)) + 1, 0, W - 1);
  const minY = clampInt(Math.floor(Math.min(y0, y1, y2)) - 1, 0, H - 1);
  const maxY = clampInt(Math.ceil(Math.max(y0, y1, y2)) + 1, 0, H - 1);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const b1 = ((x - x0) * (y2 - y0) - (x2 - x0) * (y - y0)) / area;
      const b2 = ((x1 - x0) * (y - y0) - (x - x0) * (y1 - y0)) / area;
      const b0 = 1 - b1 - b2;
      if (b0 < -eps || b1 < -eps || b2 < -eps) continue;
      const c0 = Math.max(0, b0);
      const c1 = Math.max(0, b1);
      const c2 = Math.max(0, b2);
      const s = c0 + c1 + c2 || 1;
      visit(y * W + x, c0 / s, c1 / s, c2 / s);
    }
  }
}

/** Grow known values into unknown neighbours, a pixel ring per pass. */
function dilate(a: Float32Array, have: Uint8Array, W: number, H: number, passes: number) {
  for (let it = 0; it < passes; it++) {
    const add: [number, number][] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (have[p]) continue;
        let s = 0;
        let c = 0;
        if (x > 0 && have[p - 1]) (s += a[p - 1]), c++;
        if (x < W - 1 && have[p + 1]) (s += a[p + 1]), c++;
        if (y > 0 && have[p - W]) (s += a[p - W]), c++;
        if (y < H - 1 && have[p + W]) (s += a[p + W]), c++;
        if (c) add.push([p, s / c]);
      }
    }
    for (const [p, v] of add) {
      a[p] = v;
      have[p] = 1;
    }
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
