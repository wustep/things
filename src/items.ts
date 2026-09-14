/**
 * Turns an Item into a Three.js node for the shelf. GLB assets are loaded as-is (with the
 * procedural asset as a fallback); procedural assets become a floating cut-out card, a box
 * with the photo on its face, or a cylinder with the photo wrapped on as a label.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Item, ModelOrientation, ProceduralAsset, ProceduralShape } from '../shared/types.ts';
import { assetUrl } from './data.ts';

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
}

const imageLoader = new THREE.ImageLoader();
const gltfLoader = new GLTFLoader();
let maxAnisotropy = 1;

export function setMaxAnisotropy(n: number) {
  maxAnisotropy = Math.max(1, Math.min(8, n));
}

export async function buildItemNode(item: Item): Promise<ItemNode> {
  let built: Built;
  if (item.asset.kind === 'glb') {
    try {
      built = await buildGlb(item.asset.url, item.asset.orientation);
    } catch (err) {
      console.warn(`[things] ${item.id}: GLB failed to load, using the procedural fallback`, err);
      built = await buildProcedural(item.asset.fallback, item.title);
    }
  } else {
    built = await buildProcedural(item.asset, item.title);
  }

  const root = new THREE.Group();
  root.name = item.id;
  root.userData.itemId = item.id;
  const pivot = new THREE.Group();
  pivot.add(built.object);
  root.add(pivot);

  const glow = makeGlow(glowColor(paletteOf(item)), built.size);
  root.add(glow);

  const disposables = [...built.disposables, glow.geometry, glow.material];
  return {
    item,
    kind: built.kind,
    root,
    pivot,
    glow,
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
  switch (asset.shape) {
    case 'box':
      return buildBox(image, aspect, palette);
    case 'cylinder':
      return buildCylinder(image, aspect, palette);
    default:
      return buildCard(image, aspect, title);
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

function buildCard(image: HTMLImageElement, aspect: number, title: string): Built {
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
  return { object: mesh, kind: 'card', size: { w, h, d: 0.02 }, disposables: [geometry, material, map] };
}

function buildBox(image: HTMLImageElement, aspect: number, palette: string[]): Built {
  const { w, h } = fitPlane(aspect);
  const d = clamp(w * 0.28, 0.16, FIT.d);
  const accent = new THREE.Color(palette[0]);

  // Composite the cut-out over a light face so transparent regions don't show the box interior.
  const face = compositeTexture(image, faceColor(accent));
  const back = face.clone();
  back.repeat.x = -1;
  back.offset.x = 1;
  back.needsUpdate = true;

  const photo = (map: THREE.Texture) => new THREE.MeshBasicMaterial({ map, toneMapped: false });
  const side = new THREE.MeshStandardMaterial({ color: sideColor(accent), roughness: 0.8, metalness: 0.04, envMapIntensity: 0.5 });
  const materials = [side, side, side, side, photo(face), photo(back)]; // +x -x +y -y +z -z
  const geometry = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.position.y = h / 2;
  return { object: mesh, kind: 'box', size: { w, h, d }, disposables: [geometry, side, ...materials.slice(4), face, back] };
}

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

// ---------- glb ----------

async function buildGlb(url: string, orientation?: ModelOrientation): Promise<Built> {
  const gltf = await gltfLoader.loadAsync(assetUrl(url));
  const model = gltf.scene;
  // Presentation wrapper so source transforms stay intact while we upright / face / fit.
  const object = new THREE.Group();
  object.add(model);

  applyOrientation(model, orientation);

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
