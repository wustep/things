/**
 * Turns an Item into a Three.js node for the shelf. GLB assets are loaded and their materials
 * finished in place (with the procedural asset as a fallback); procedural assets become a floating
 * cut-out card (picked only where the photo is opaque), a rounded carton with the photo printed
 * on, or a bottle turned from the photo's own silhouette.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Item, ModelOrientation, ProceduralAsset, ProceduralShape } from '../shared/types.ts';
import { assetUrl } from './data.ts';
import sizesJson from '../data/sizes.json';

/** Every item is fitted into this footprint (world units) so the shelf reads evenly. */
const FIT = { w: 1.2, h: 1.05, d: 1.1 };
const MAX_TEXTURE = 1024;

export type NodeKind = ProceduralShape | 'glb';

export interface ItemNode {
  item: Item;
  kind: NodeKind;
  /** Sits on the shelf slot; owns the glow disc and the pivot. */
  root: THREE.Group;
  /** Animated (sway, spin, bob, hover); owns the mesh. */
  pivot: THREE.Group;
  glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** Soft contact shadow baked from the item's own footprint; sits under the pivot. */
  shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** Invisible box the picker tests instead of every triangle (and so open shapes are easy to hover). */
  hit: THREE.Mesh;
  /** Cut-outs: after the box, the ray must land on an opaque pixel of the photo. */
  precise?: Precise;
  size: { w: number; h: number; d: number };
  /** Per-item animation offset so the shelf never moves in lockstep. */
  phase: number;
  /** performance.now() at creation, for the fade-in. */
  born: number;
  hoverAmount: number;
  dispose(): void;
}

interface Built {
  object: THREE.Object3D;
  kind: NodeKind;
  size: { w: number; h: number; d: number };
  disposables: { dispose(): void }[];
  /** Exact-pick surface for see-through shapes: a hit only counts where the photo is opaque. */
  precise?: Precise;
}

export interface Precise {
  mesh: THREE.Mesh;
  opaque(u: number, v: number): boolean;
}

const imageLoader = new THREE.ImageLoader();
const gltfLoader = new GLTFLoader();
let maxAnisotropy = 1;

export function setMaxAnisotropy(n: number) {
  maxAnisotropy = Math.max(1, Math.min(8, n));
}

/** `?procedural` in the URL shows every item's procedural shape instead of its model. */
const forceProcedural = typeof location !== 'undefined' && new URLSearchParams(location.search).has('procedural');

export async function buildItemNode(item: Item): Promise<ItemNode> {
  let built: Built;
  if (item.asset.kind === 'glb' && forceProcedural) {
    built = await buildProcedural(item.asset.fallback, item.title);
  } else if (item.asset.kind === 'glb') {
    try {
      built = await buildGlb(item.asset.url, item.asset.orientation);
    } catch (err) {
      console.warn(`[things] ${item.id}: GLB failed to load, using the procedural fallback`, err);
      built = await buildProcedural(item.asset.fallback, item.title);
    }
  } else {
    built = await buildProcedural(item.asset, item.title);
  }
  applyRealScale(built, item.id);

  const root = new THREE.Group();
  root.name = item.id;
  root.userData.itemId = item.id;
  const pivot = new THREE.Group();
  pivot.add(built.object);
  root.add(pivot);

  const glow = makeGlow(glowColor(paletteOf(item)), built.size);
  root.add(glow);
  const shadow = makeContactShadow(built.object, built.size);
  root.add(shadow);
  const hit = makeHitBox(built.size);
  hit.userData.itemId = item.id;
  pivot.add(hit);

  const disposables = [...built.disposables, glow.geometry, glow.material, shadow.geometry, shadow.material, shadow.material.map!, hit.geometry];
  return {
    item,
    kind: built.kind,
    root,
    pivot,
    glow,
    shadow,
    hit,
    precise: built.precise,
    size: built.size,
    phase: hashPhase(item.id),
    born: performance.now(),
    hoverAmount: 0,
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}

// ---------- procedural ----------

async function buildProcedural(asset: ProceduralAsset, title: string): Promise<Built> {
  const image = await loadImage(assetUrl(asset.texture));
  const aspect = asset.aspect > 0 ? asset.aspect : image.width / image.height || 1;
  const palette = asset.palette.length ? asset.palette : ['#8a8a8a'];
  const mask = alphaMask(image);
  switch (asset.shape) {
    case 'box':
      return buildBox(image, aspect, palette);
    case 'cylinder':
      return mask ? buildBottle(image, aspect, palette, mask) : buildCylinder(image, aspect, palette);
    default:
      return buildCard(image, aspect, title, mask);
  }
}

/** Fit a w:h rectangle of the given aspect inside the footprint. */
function fitPlane(aspect: number): { w: number; h: number } {
  let h = FIT.h;
  let w = h * aspect;
  if (w > FIT.w) {
    w = FIT.w;
    h = w / aspect;
  }
  return { w, h };
}

function buildCard(image: HTMLImageElement, aspect: number, title: string, mask: Mask | null): Built {
  const { w, h } = fitPlane(aspect);
  const map = imageTexture(image);
  const material = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    alphaTest: 0.06,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const geometry = new THREE.PlaneGeometry(w, h);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `card:${title}`;
  mesh.position.y = h / 2;
  return {
    object: mesh,
    kind: 'card',
    size: { w, h, d: 0.02 },
    disposables: [geometry, material, map],
    precise: mask ? { mesh, opaque: (u, v) => maskAlpha(mask, u, v) > 24 } : undefined,
  };
}

/** A softly rounded carton with the photo printed on the front and back. */
function buildBox(image: HTMLImageElement, aspect: number, palette: string[]): Built {
  const { w, h } = fitPlane(aspect);
  const d = clamp(w * 0.28, 0.16, FIT.d);
  const accent = new THREE.Color(palette[0]);
  const radius = Math.min(w, h, d) * 0.07;

  const body = new RoundedBoxGeometry(w, h, d, 3, radius);
  const side = new THREE.MeshStandardMaterial({ color: sideColor(accent), roughness: 0.72, metalness: 0.02, envMapIntensity: 0.6 });
  // Composite the cut-out over a light paper so transparent regions don't show the carton.
  const face = compositeTexture(image, faceColor(accent));
  const print = new THREE.MeshBasicMaterial({ map: face, toneMapped: false });
  // The print stops short of the rounded edges, the way a label does.
  const plane = new THREE.PlaneGeometry(w - radius * 2, h - radius * 2);
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(body, side);
  const front = new THREE.Mesh(plane, print);
  front.position.z = d / 2 + 0.0015;
  const back = new THREE.Mesh(plane, print);
  back.position.z = -d / 2 - 0.0015;
  back.rotation.y = Math.PI;
  group.add(mesh, front, back);
  group.position.y = h / 2;
  return { object: group, kind: 'box', size: { w, h, d }, disposables: [body, side, face, print, plane] };
}

/**
 * A bottle turned on a lathe whose profile is the photo's own silhouette (the half-width of each
 * row of the cut-out), so caps, shoulders and tapers come out the shape they are. The photo is
 * projected on from the front, which is how a product shot sees it anyway.
 */
function buildBottle(image: HTMLImageElement, aspect: number, palette: string[], mask: Mask): Built {
  const { w, h } = fitPlane(aspect);
  const rows = 64;
  const radii: number[] = [];
  for (let j = 0; j <= rows; j++) {
    const r = Math.min(mask.h - 1, Math.floor((1 - j / rows) * (mask.h - 1)));
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < mask.w; x++) {
      if (mask.a[r * mask.w + x] > 96) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    radii.push(lo < 0 ? 0 : ((hi - lo + 1) / 2 / mask.w) * w);
  }
  // A light median pass so a stray strap or reflection doesn't put a notch in the profile.
  const smooth = radii.map((_, j) => {
    const win = radii.slice(Math.max(0, j - 2), j + 3).sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)];
  });
  if (Math.max(...smooth) < 0.02) return buildCylinder(image, aspect, palette);
  const points = [new THREE.Vector2(0, 0)];
  smooth.forEach((r, j) => points.push(new THREE.Vector2(Math.max(r, 0.002), (j / rows) * h)));
  points.push(new THREE.Vector2(0, h));
  const geometry = new THREE.LatheGeometry(points, 72);
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) uv.setXY(i, 0.5 + pos.getX(i) / w, pos.getY(i) / h);
  uv.needsUpdate = true;
  geometry.computeVertexNormals();

  const accent = new THREE.Color(palette[0]);
  const label = compositeTexture(image, sideColor(accent));
  const material = new THREE.MeshStandardMaterial({
    map: label,
    // The photo glows a little so it reads true on the shaded curve.
    emissiveMap: label,
    emissive: 0xffffff,
    emissiveIntensity: 0.35,
    roughness: 0.42,
    metalness: 0,
    envMapIntensity: 0.7,
  });
  const mesh = new THREE.Mesh(geometry, material);
  const d = Math.max(...smooth) * 2;
  return { object: mesh, kind: 'cylinder', size: { w, h, d }, disposables: [geometry, material, label] };
}

/** Plain cylinder with the photo wrapped round as a label: the fallback when there is no alpha to read. */
function buildCylinder(image: HTMLImageElement, aspect: number, palette: string[]): Built {
  const { w, h } = fitPlane(aspect);
  const r = w / 2;
  const accent = new THREE.Color(palette[0]);

  const label = labelTexture(image, sideColor(accent));
  // The photo glows a little so it reads true on the shaded curve; the body around it does not.
  const emissive = labelTexture(image, new THREE.Color(0x000000));
  const side = new THREE.MeshStandardMaterial({
    map: label,
    emissiveMap: emissive,
    emissive: 0xffffff,
    emissiveIntensity: 0.4,
    roughness: 0.8,
    metalness: 0.05,
    envMapIntensity: 0.35,
  });
  const cap = new THREE.MeshStandardMaterial({ color: sideColor(accent).multiplyScalar(0.7), roughness: 0.8, metalness: 0.05, envMapIntensity: 0.35 });
  const geometry = new THREE.CylinderGeometry(r, r, h, 64, 1, false);
  const mesh = new THREE.Mesh(geometry, [side, cap, cap]);
  mesh.position.y = h / 2;
  mesh.rotation.y = Math.PI; // the label is drawn around u = 0.5, which this turns to face +z
  return { object: mesh, kind: 'cylinder', size: { w, h, d: w }, disposables: [geometry, side, cap, label, emissive] };
}

// ---------- real-world scale ----------

/**
 * Largest real dimension (cm) per item from data/sizes.json. Literal scale would make a mouse a
 * sixteenth of a sofa and invisible on the shelf, so display size follows (cm / largest)^0.3,
 * never below SCALE_FLOOR: the sofa stays full size, a mouse lands near half of it, and order is
 * always preserved.
 */
const SCALE_EXPONENT = 0.3;
const SCALE_FLOOR = 0.42;
const REAL_SIZES = new Map(Object.entries(sizesJson).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0));
const LARGEST_CM = Math.max(1, ...REAL_SIZES.values());
/** Things not measured yet sit at the collection's median size rather than the largest. */
const MEDIAN_CM = (() => {
  const v = [...REAL_SIZES.values()].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : LARGEST_CM;
})();

function applyRealScale(built: Built, id: string) {
  const cm = REAL_SIZES.get(id) ?? MEDIAN_CM;
  const target = Math.max(FIT.w, FIT.h) * Math.max(SCALE_FLOOR, Math.pow(cm / LARGEST_CM, SCALE_EXPONENT));
  const k = Math.min(1, target / Math.max(built.size.w, built.size.h, built.size.d, 1e-6));
  if (k >= 0.999) return;
  // The object already sits centred on its base; scaling its offset with it keeps it there.
  built.object.scale.multiplyScalar(k);
  built.object.position.multiplyScalar(k);
  built.size = { w: built.size.w * k, h: built.size.h * k, d: built.size.d * k };
}

// ---------- glb ----------

async function buildGlb(url: string, orientation?: ModelOrientation): Promise<Built> {
  const gltf = await gltfLoader.loadAsync(assetUrl(url));
  const model = gltf.scene;
  // Presentation wrapper so source transforms stay intact while we upright / face / fit.
  const object = new THREE.Group();
  object.add(model);

  applyOrientation(model, orientation);
  finishGlbMaterials(model);

  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const scale = fitScale(size);
  object.scale.setScalar(scale);
  box.setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  object.position.set(-center.x, -box.min.y, -center.z);

  const fitted = box.getSize(new THREE.Vector3());
  const disposables: { dispose(): void }[] = [];
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      disposables.push(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        disposables.push(m);
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) disposables.push(v);
      }
    }
  });
  return { object, kind: 'glb', size: { w: fitted.x, h: fitted.y, d: fitted.z }, disposables };
}

/** Uniform scale that nests the AABB inside FIT. */
function fitScale(size: THREE.Vector3): number {
  return Math.min(FIT.w / Math.max(size.x, 1e-6), FIT.h / Math.max(size.y, 1e-6), FIT.d / Math.max(size.z, 1e-6));
}

function applyOrientation(model: THREE.Object3D, orientation?: ModelOrientation) {
  const upright = orientation?.upright ?? 'auto';
  const face = orientation?.face ?? 'auto';
  if (upright === 'tip' || (upright === 'auto' && shouldTipUpright(model))) {
    model.rotateX(-Math.PI / 2);
    model.updateMatrixWorld(true);
  } else if (upright === 'tip-rev') {
    model.rotateX(Math.PI / 2);
    model.updateMatrixWorld(true);
  }
  if (face === 'auto' && shouldFaceCamera(model)) {
    model.rotateY(Math.PI / 2);
    model.updateMatrixWorld(true);
  }
  const pitchDeg = orientation?.pitchDeg ?? 0;
  const yawDeg = orientation?.yawDeg ?? 0;
  const rollDeg = orientation?.rollDeg ?? 0;
  if (pitchDeg) model.rotateX(THREE.MathUtils.degToRad(pitchDeg));
  if (yawDeg) model.rotateY(THREE.MathUtils.degToRad(yawDeg));
  if (rollDeg) model.rotateZ(THREE.MathUtils.degToRad(rollDeg));
  if (pitchDeg || yawDeg || rollDeg) model.updateMatrixWorld(true);
}

/**
 * Meshy / CAD exports sometimes arrive lying on their back (tall axis along Z). Tip only when Z
 * clearly dominates both footprint axes — nearly-cubic or disc-like meshes stay put (a pill
 * case tipped on edge is worse than a slightly deep AABB).
 */
function shouldTipUpright(model: THREE.Object3D): boolean {
  model.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  return size.z > size.y * 1.35 && size.z > size.x * 1.15;
}

/** Yaw so the broader horizontal face looks toward +Z (the camera side of the shelf). */
function shouldFaceCamera(model: THREE.Object3D): boolean {
  model.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  return size.z > size.x * 1.18;
}
/**
 * Meshy's PBR maps are noisy in two ways that read badly on black: roughness that dips to ~0
 * (glitter and hot speckles across plastic, cork, stainless) and normal maps that carry the
 * same baking noise as the colour. Both are tamed in the shader of the material that came with
 * the GLB, which is edited in place: nothing is swapped or disposed, so shared textures are
 * never torn down under another mesh.
 */
const ROUGHNESS_FLOOR = 0.32;
const NORMAL_STRENGTH = 0.7;

function finishGlbMaterials(root: THREE.Object3D) {
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (seen.has(m) || !(m instanceof THREE.MeshStandardMaterial)) continue;
      seen.add(m);
      m.normalScale.multiplyScalar(NORMAL_STRENGTH);
      for (const tex of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap, m.emissiveMap]) {
        if (tex && tex.anisotropy !== maxAnisotropy) {
          tex.anisotropy = maxAnisotropy;
          tex.needsUpdate = true;
        }
      }
      m.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>\n\troughnessFactor = max(roughnessFactor, ${ROUGHNESS_FLOOR.toFixed(2)});`,
        );
      };
      m.customProgramCacheKey = () => 'things-finish';
      m.needsUpdate = true;
    }
  });
}

// ---------- contact & picking ----------

const SHADOW_RES = 96;

/**
 * A soft shadow under the item, splatted from its own vertices seen from above: points near the
 * base weigh most, so legs make four little pools and a bottle makes one round one. Drawn in
 * normal blending over the additive glow, it reads as the thing resting on its light.
 */
function makeContactShadow(object: THREE.Object3D, size: { w: number; h: number; d: number }) {
  object.updateMatrixWorld(true);
  const pad = 0.22;
  const ext = Math.max(size.w, size.d) * 0.5 + pad; // half side of the square the shadow covers
  const grid = new Float32Array(SHADOW_RES * SHADOW_RES);
  const v = new THREE.Vector3();
  const falloff = Math.max(0.06, size.h * 0.22);
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const stride = Math.max(1, Math.floor(pos.count / 30000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const wgt = Math.exp(-Math.max(0, v.y) / falloff);
      if (wgt < 0.02) continue;
      const gx = Math.floor(((v.x + ext) / (2 * ext)) * SHADOW_RES);
      const gz = Math.floor(((v.z + ext) / (2 * ext)) * SHADOW_RES);
      if (gx < 0 || gz < 0 || gx >= SHADOW_RES || gz >= SHADOW_RES) continue;
      grid[gz * SHADOW_RES + gx] += wgt;
    }
  });
  // Procedural cards are a single quad: give them a slim pool of their own width.
  if (size.d < 0.05) {
    for (let x = 0; x < SHADOW_RES; x++) {
      const wx = (x / SHADOW_RES) * 2 * ext - ext;
      if (Math.abs(wx) < size.w / 2) grid[Math.floor(SHADOW_RES / 2) * SHADOW_RES + x] += 4;
    }
  }
  blur(grid, SHADOW_RES, 3);
  blur(grid, SHADOW_RES, 3);
  let max = 0;
  for (const g of grid) max = Math.max(max, g);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SHADOW_RES;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SHADOW_RES, SHADOW_RES);
  for (let i = 0; i < grid.length; i++) {
    // Soft knee so a dense patch saturates and a sparse one still shows.
    const a = max > 0 ? 1 - Math.exp(-3 * (grid[i] / max)) : 0;
    img.data[i * 4 + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(canvas);
  const geometry = new THREE.PlaneGeometry(2 * ext, 2 * ext);
  const material = new THREE.MeshBasicMaterial({ map, color: 0x000000, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(geometry, material);
  // Canvas row 0 is the far edge (-z): with flipY that is v = 1, which lying flat puts at -z too.
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.03;
  mesh.renderOrder = -0.5;
  return mesh;
}

/** Separable box blur, in place. */
function blur(grid: Float32Array, n: number, r: number) {
  const tmp = new Float32Array(grid.length);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? grid : tmp;
    const dst = pass === 0 ? tmp : grid;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let sum = 0;
        let cnt = 0;
        for (let k = -r; k <= r; k++) {
          const xx = pass === 0 ? x + k : x;
          const yy = pass === 0 ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
          sum += src[yy * n + xx];
          cnt++;
        }
        dst[y * n + x] = sum / cnt;
      }
    }
  }
}

const hitMaterial = new THREE.MeshBasicMaterial();

function makeHitBox(size: { w: number; h: number; d: number }): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(Math.max(size.w, 0.3), Math.max(size.h, 0.3), Math.max(size.d, 0.3));
  const mesh = new THREE.Mesh(geometry, hitMaterial);
  mesh.position.y = Math.max(size.h, 0.3) / 2;
  mesh.visible = false;
  return mesh;
}

// ---------- alpha ----------

interface Mask {
  w: number;
  h: number;
  /** Alpha, row 0 at the top of the image. */
  a: Uint8Array;
}

const MASK_MAX = 160;

/** A small copy of the cut-out's alpha, or null when the pixels can't be read (cross-origin). */
function alphaMask(image: HTMLImageElement): Mask | null {
  const scale = Math.min(1, MASK_MAX / Math.max(image.width, image.height));
  const w = Math.max(2, Math.round(image.width * scale));
  const h = Math.max(2, Math.round(image.height * scale));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const a = new Uint8Array(w * h);
    let opaque = 0;
    for (let i = 0; i < a.length; i++) if ((a[i] = data[i * 4 + 3]) > 127) opaque++;
    // A fully opaque photo has no silhouette to trace.
    return opaque > 0 && opaque < a.length * 0.97 ? { w, h, a } : null;
  } catch {
    return null;
  }
}

function maskAlpha(mask: Mask, u: number, v: number): number {
  const x = Math.min(mask.w - 1, Math.max(0, Math.floor(u * mask.w)));
  const y = Math.min(mask.h - 1, Math.max(0, Math.floor((1 - v) * mask.h)));
  return mask.a[y * mask.w + x];
}

// ---------- textures ----------

function loadImage(url: string): Promise<HTMLImageElement> {
  return imageLoader.loadAsync(url);
}

function imageTexture(image: HTMLImageElement | HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.Texture(image);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** The image drawn over a flat color, for box faces. */
function compositeTexture(image: HTMLImageElement, bg: THREE.Color): THREE.Texture {
  const scale = Math.min(1, MAX_TEXTURE / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(image.width * scale));
  canvas.height = Math.max(2, Math.round(image.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = `#${bg.getHexString()}`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return imageTexture(canvas);
}

/**
 * A label that wraps the whole circumference: the photo at natural proportions centred at
 * u = 0.5, the rest the item's own colour. Canvas width = circumference in texels.
 */
function labelTexture(image: HTMLImageElement, bg: THREE.Color): THREE.Texture {
  const imgH = Math.min(MAX_TEXTURE, image.height);
  const imgW = Math.round(image.width * (imgH / image.height));
  const width = Math.min(4096, Math.round(imgW * Math.PI));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, width);
  canvas.height = Math.max(2, imgH);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = `#${bg.getHexString()}`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, Math.round((canvas.width - imgW) / 2), 0, imgW, imgH);
  const tex = imageTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

let radial: THREE.Texture | undefined;

/** Soft radial falloff shared by every glow disc. */
function radialTexture(): THREE.Texture {
  if (radial) return radial;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  radial = new THREE.CanvasTexture(canvas);
  return radial;
}

function makeGlow(color: THREE.Color, size: { w: number; h: number; d: number }) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({
    map: radialTexture(),
    color,
    transparent: true,
    opacity: 0.2,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.04;
  const s = Math.max(size.w, size.d) * 2.4;
  mesh.scale.set(s, s, 1);
  mesh.renderOrder = -1;
  return mesh;
}

// ---------- colours ----------

function paletteOf(item: Item): string[] {
  const p = item.asset.palette;
  return p && p.length ? p : ['#8a8a8a'];
}

const hsl = { h: 0, s: 0, l: 0 };

/** A glow that reads on black without shouting: mid lightness, tamed saturation. */
function glowColor(palette: string[]): THREE.Color {
  const c = new THREE.Color(palette[0]).getHSL(hsl);
  return new THREE.Color().setHSL(c.h, Math.min(c.s, 0.55), clamp(c.l, 0.42, 0.62));
}

/** Box sides and cylinder body: the accent, darkened so the photo stays the focus. */
function sideColor(accent: THREE.Color): THREE.Color {
  const c = accent.getHSL(hsl);
  return new THREE.Color().setHSL(c.h, Math.min(c.s, 0.55), clamp(c.l * 0.35, 0.05, 0.14));
}

/** Box front: a light, barely tinted paper the cut-out sits on. */
function faceColor(accent: THREE.Color): THREE.Color {
  const c = accent.getHSL(hsl);
  return new THREE.Color().setHSL(c.h, Math.min(c.s, 0.2), 0.9);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function hashPhase(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000 * Math.PI * 2;
}
