/**
 * The cut-out's matte and edge colour, kept apart from build.ts's framing and colour work.
 *
 * - segment(): BiRefNet_HR (MIT, ZhengPeng7/BiRefNet release v1) run locally with
 *   onnxruntime-node at its native 2048², so thin parts (legs, cords, strap loops) survive that a
 *   1024² mask loses; the matting variant also keeps partial cover (clear acrylic, glass).
 * - refine(): a colour guided filter (He et al. 2010) on a trimap band around the edge, at the
 *   working resolution, so an edge the model drew at 2048² (or blurred when scaled up) follows the
 *   photo's own edge. Inside and outside the band the model's alpha stands.
 * - foreground(): the colour of the object itself in the transition band, by multi-level
 *   foreground/background estimation (Germer et al. 2021, as in pymatting's
 *   estimate_foreground_ml): each edge pixel is split into F and B with I = aF + (1-a)B, both kept
 *   smooth, so studio white or grey left in an edge is taken out rather than clamped.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache', 'birefnet');

/**
 * Pinned like dependencies: release assets of ZhengPeng7/BiRefNet v1 (MIT), checked by size and
 * SHA-256 after download. 'general' (DIS-style, crisp and solid) is the default; 'matting' gives
 * real partial alpha, for clear acrylic, glass or mesh (data/photos.json `matte`).
 */
export const MODELS = {
  general: {
    name: 'BiRefNet_HR-general',
    file: 'BiRefNet_HR-general-epoch_130.onnx',
    bytes: 1098928953,
    sha256: 'db0217e99b25e0c4f6f4dca2892ff1f7ea7aba38fb6ad84f93122a4024be536a',
  },
  matting: {
    name: 'BiRefNet_HR-matting',
    file: 'BiRefNet_HR-matting-epoch_135.onnx',
    bytes: 1098928867,
    sha256: '45b7d92ce0e2e75e1c8a564a9e84c87ac9da7f4315d2deeef3674864e809aef3',
  },
} as const;
export type MatteModel = keyof typeof MODELS;
const RELEASE = 'https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/';
/** Both run at 2048² input. */
const SIDE = 2048;

type Session = { run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>> };
const sessions = new Map<MatteModel, Promise<Session>>();

async function ensureModel(MODEL: (typeof MODELS)[MatteModel]): Promise<string> {
  const file = path.join(CACHE, MODEL.file);
  if (existsSync(file) && (await stat(file)).size === MODEL.bytes) return file;
  await mkdir(CACHE, { recursive: true });
  console.log(`model ${MODEL.name}: downloading ${(MODEL.bytes / 1e9).toFixed(1)} GB once into tools/images/.cache`);
  const res = await fetch(RELEASE + MODEL.file);
  if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status}`);
  const part = `${file}.part`;
  const { createWriteStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(part));
  const hash = createHash('sha256');
  await pipeline(createReadStream(part), hash);
  const digest = hash.digest('hex');
  if (digest !== MODEL.sha256) {
    await rm(part, { force: true });
    throw new Error(`model checksum mismatch (${digest}); refusing to use it`);
  }
  await rename(part, file);
  return file;
}

/** Soft alpha for the whole photo at W×H, from the model at its native square input. */
export async function segment(rgba: Buffer, W: number, H: number, model: MatteModel = 'general'): Promise<Float32Array> {
  const ort = await import('onnxruntime-node');
  let s = sessions.get(model);
  if (!s) {
    const M = MODELS[model];
    s = ensureModel(M).then(async (file) => {
      console.log(`model ${M.name} (sha256 ${M.sha256.slice(0, 12)}), onnxruntime-node CPU`);
      return (await ort.InferenceSession.create(file)) as unknown as Session;
    });
    sessions.set(model, s);
  }
  const session = await s;
  const N = SIDE;
  const { data: rgb } = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .flatten({ background: '#ffffff' })
    .resize(N, N, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = N * N;
  const input = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) input[c * n + i] = (rgb[i * 3 + c] / 255 - mean[c]) / std[c];
  const out = await session.run({ input_image: new ort.Tensor('float32', input, [1, 3, N, N]) });
  const logits = Object.values(out)[0].data;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = 1 / (1 + Math.exp(-logits[i]));
  // Back to the photo's size in floats (bilinear), so a soft edge doesn't band when it is stretched.
  const a = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(N - 1, Math.max(0, ((y + 0.5) * N) / H - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(N - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(N - 1, Math.max(0, ((x + 0.5) * N) / W - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(N - 1, x0 + 1), tx = fx - x0;
      const top = m[y0 * N + x0] * (1 - tx) + m[y0 * N + x1] * tx;
      const bot = m[y1 * N + x0] * (1 - tx) + m[y1 * N + x1] * tx;
      a[y * W + x] = top * (1 - ty) + bot * ty;
    }
  }
  return a;
}

// ---------- refinement ----------

/** Box mean of radius r over a W×H float plane (integral image; edges use the pixels that exist). */
function boxMean(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += src[y * W + x];
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const sum = S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0];
      out[y * W + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/**
 * Colour guided filter of `p` by the photo, radius r, regulariser eps (in 0..1 colour units²).
 * Works on the bounding box of `band` (plus a margin) only.
 */
function guidedFilter(rgba: Buffer, W: number, p: Float32Array, box: [number, number, number, number], r: number, eps: number): Float32Array {
  const [bx, by, bw, bh] = box;
  const n = bw * bh;
  const I = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const P = new Float32Array(n);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const s = (by + y) * W + bx + x, d = y * bw + x;
    for (let c = 0; c < 3; c++) I[c][d] = rgba[s * 4 + c] / 255;
    P[d] = p[s];
  }
  const mean = (a: Float32Array) => boxMean(a, bw, bh, r);
  const mul = (a: Float32Array, b: Float32Array) => {
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = a[i] * b[i];
    return o;
  };
  const mI = I.map(mean);
  const mP = mean(P);
  const mIP = I.map((c) => mean(mul(c, P)));
  const v = (a: number, b: number) => mean(mul(I[a], I[b]));
  const vrr = v(0, 0), vrg = v(0, 1), vrb = v(0, 2), vgg = v(1, 1), vgb = v(1, 2), vbb = v(2, 2);
  const A = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [r0, g0, b0] = [mI[0][i], mI[1][i], mI[2][i]];
    const covR = mIP[0][i] - r0 * mP[i], covG = mIP[1][i] - g0 * mP[i], covB = mIP[2][i] - b0 * mP[i];
    const a11 = vrr[i] - r0 * r0 + eps, a12 = vrg[i] - r0 * g0, a13 = vrb[i] - r0 * b0;
    const a22 = vgg[i] - g0 * g0 + eps, a23 = vgb[i] - g0 * b0, a33 = vbb[i] - b0 * b0 + eps;
    // Symmetric 3×3 inverse.
    const c11 = a22 * a33 - a23 * a23, c12 = a13 * a23 - a12 * a33, c13 = a12 * a23 - a13 * a22;
    const c22 = a11 * a33 - a13 * a13, c23 = a13 * a12 - a11 * a23, c33 = a11 * a22 - a12 * a12;
    const det = a11 * c11 + a12 * c12 + a13 * c13;
    const k0 = (c11 * covR + c12 * covG + c13 * covB) / det;
    const k1 = (c12 * covR + c22 * covG + c23 * covB) / det;
    const k2 = (c13 * covR + c23 * covG + c33 * covB) / det;
    A[0][i] = k0; A[1][i] = k1; A[2][i] = k2;
    B[i] = mP[i] - k0 * r0 - k1 * g0 - k2 * b0;
  }
  const mA = A.map(mean), mB = mean(B);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = mA[0][i] * I[0][i] + mA[1][i] * I[1][i] + mA[2][i] * I[2][i] + mB[i];
  return q;
}

/**
 * Sharpen the matte along the photo's own edges. The band is where the model is unsure (0.02 < a <
 * 0.98) grown by a few pixels; only there does the filtered alpha replace the model's, and it is
 * kept within reach of the model (a guide with no contrast, white on white, can't move an edge far).
 */
export function refine(rgba: Buffer, alpha: Float32Array, W: number, H: number, opts: { radius?: number; eps?: number } = {}): Float32Array {
  const n = W * H;
  const side = Math.max(W, H);
  const r = opts.radius ?? Math.max(2, Math.round(side / 800));
  const eps = opts.eps ?? 1e-3;
  const band = new Uint8Array(n);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let i = 0; i < n; i++) {
    if (alpha[i] > 0.02 && alpha[i] < 0.98) {
      band[i] = 1;
      const x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return alpha;
  dilate(band, W, H, r * 2);
  const m = r * 4;
  const box: [number, number, number, number] = [Math.max(0, x0 - m), Math.max(0, y0 - m), 0, 0];
  box[2] = Math.min(W, x1 + m + 1) - box[0];
  box[3] = Math.min(H, y1 + m + 1) - box[1];
  const q = guidedFilter(rgba, W, alpha, box, r, eps);
  const out = alpha.slice();
  for (let y = 0; y < box[3]; y++) for (let x = 0; x < box[2]; x++) {
    const i = (box[1] + y) * W + box[0] + x;
    if (!band[i]) continue;
    const g = Math.min(1, Math.max(0, q[y * box[2] + x]));
    // Never further than 0.35 from what the model said: the filter tidies the edge, it doesn't redraw it.
    out[i] = Math.min(alpha[i] + 0.35, Math.max(alpha[i] - 0.35, g));
  }
  return out;
}

// ---------- foreground colour ----------

/**
 * Foreground colour (0..255 floats, RGB) for every pixel with some alpha, by multi-level
 * estimation: from a 1×1 start, each level is solved with a few Jacobi-style sweeps of the 2×2
 * system per pixel (data term a·F + (1-a)·B = I, plus smoothness weighted by how much the alpha
 * changes), then upsampled as the start for the next. Runs on the object's bounding box.
 */
export function foreground(rgba: Buffer, alpha: Float32Array, W: number, H: number): Float32Array {
  const n = W * H;
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
  for (let i = 0; i < n; i++) if (alpha[i] > 0.002) {
    const x = i % W, y = (i - x) / W;
    if (x < bx0) bx0 = x;
    if (x > bx1) bx1 = x;
    if (y < by0) by0 = y;
    if (y > by1) by1 = y;
  }
  const F = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) F[i * 3 + c] = rgba[i * 4 + c];
  if (bx1 < 0) return F;
  const pad = 8;
  bx0 = Math.max(0, bx0 - pad); by0 = Math.max(0, by0 - pad);
  bx1 = Math.min(W - 1, bx1 + pad); by1 = Math.min(H - 1, by1 + pad);
  const w0 = bx1 - bx0 + 1, h0 = by1 - by0 + 1;
  const img = new Float32Array(w0 * h0 * 3), al = new Float32Array(w0 * h0);
  for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) {
    const s = (by0 + y) * W + bx0 + x, d = y * w0 + x;
    al[d] = alpha[s];
    for (let c = 0; c < 3; c++) img[d * 3 + c] = rgba[s * 4 + c] / 255;
  }
  const fg = estimateML(img, al, w0, h0);
  for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) {
    const s = (by0 + y) * W + bx0 + x, d = y * w0 + x;
    for (let c = 0; c < 3; c++) F[s * 3 + c] = fg[d * 3 + c] * 255;
  }
  return F;
}

function estimateML(image: Float32Array, alpha: Float32Array, w0: number, h0: number): Float32Array {
  const REG = 1e-5, GRAD = 1, SMALL = 32, SMALL_ITERS = 10, BIG_ITERS = 2;
  const levels = Math.ceil(Math.log2(Math.max(w0, h0)));
  const mean = [0, 0, 0];
  for (let i = 0; i < w0 * h0; i++) for (let c = 0; c < 3; c++) mean[c] += image[i * 3 + c] / (w0 * h0);
  let F: Float32Array = new Float32Array(mean), B: Float32Array = new Float32Array(mean);
  let pw = 1, ph = 1;
  for (let level = 0; level <= levels; level++) {
    const w = Math.round(Math.pow(w0, level / levels)), h = Math.round(Math.pow(h0, level / levels));
    const I = nearest(image, w0, h0, w, h, 3), A = nearest(alpha, w0, h0, w, h, 1);
    F = nearest(F, pw, ph, w, h, 3);
    B = nearest(B, pw, ph, w, h, 3);
    const iters = w <= SMALL && h <= SMALL ? SMALL_ITERS : BIG_ITERS;
    const b0 = [0, 0, 0], b1 = [0, 0, 0];
    for (let it = 0; it < iters; it++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const a0 = A[i], a1 = 1 - a0;
        let a00 = a0 * a0, a11 = a1 * a1;
        const a01 = a0 * a1;
        for (let c = 0; c < 3; c++) {
          b0[c] = a0 * I[i * 3 + c];
          b1[c] = a1 * I[i * 3 + c];
        }
        for (let d = 0; d < 4; d++) {
          const x2 = Math.max(0, Math.min(w - 1, x + (d === 0 ? -1 : d === 1 ? 1 : 0)));
          const y2 = Math.max(0, Math.min(h - 1, y + (d === 2 ? -1 : d === 3 ? 1 : 0)));
          const j = y2 * w + x2;
          const da = REG + GRAD * Math.abs(a0 - A[j]);
          a00 += da;
          a11 += da;
          for (let c = 0; c < 3; c++) {
            b0[c] += da * F[j * 3 + c];
            b1[c] += da * B[j * 3 + c];
          }
        }
        const inv = 1 / (a00 * a11 - a01 * a01);
        const k00 = inv * a11, k01 = -inv * a01, k11 = inv * a00;
        for (let c = 0; c < 3; c++) {
          F[i * 3 + c] = Math.min(1, Math.max(0, k00 * b0[c] + k01 * b1[c]));
          B[i * 3 + c] = Math.min(1, Math.max(0, k01 * b0[c] + k11 * b1[c]));
        }
      }
    }
    pw = w;
    ph = h;
  }
  return F;
}

function nearest(src: Float32Array, sw: number, sh: number, w: number, h: number, ch: number): Float32Array {
  if (sw === w && sh === h) return src.slice();
  const out = new Float32Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / w));
      for (let c = 0; c < ch; c++) out[(y * w + x) * ch + c] = src[(sy * sw + sx) * ch + c];
    }
  }
  return out;
}

export function dilate(m: Uint8Array, W: number, H: number, r: number) {
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
