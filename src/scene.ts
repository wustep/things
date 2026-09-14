/**
 * The void: a black scene with a shelf of items, soft orbit controls, a little drifting dust,
 * and pointer picking for hover / select.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Item } from '../shared/types.ts';
import { buildItemNode, setMaxAnisotropy, type ItemNode, type NodeKind } from './items.ts';
import { layoutShelf, maxPerRow, type Group, type Shelf, type Slot } from './layout.ts';
import { groupItems } from './sections.ts';

export interface StageEvents {
  hover(node: ItemNode | null): void;
  select(node: ItemNode): void;
}

/** Idle yaw amplitude (radians) per kind; keeps the front toward the camera. */
const SWAY: Record<NodeKind, number> = { card: 0.14, box: 0.42, cylinder: 0.95, glb: 0.28 };
const CLICK_SLOP_PX = 6;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private readonly world = new THREE.Group();
  private readonly shelf = new THREE.Group();
  private readonly dust: THREE.Points;
  private readonly nodes = new Map<string, ItemNode>();
  private readonly targets = new Map<string, Slot>();
  private readonly pending = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2(2, 2); // off-screen until the pointer moves
  private readonly clock = new THREE.Clock();
  private pointerDirty = false;
  private hovered: ItemNode | null = null;
  private pressed: { x: number; y: number } | null = null;
  private frameDistance = 8;
  /** Where the orbit target should ease to while the camera is ours (whole shelf or one section). */
  private readonly goal = new THREE.Vector3(0, 0.4, 0);
  private autoFrame = true;
  /** Item ids in layout order (grouped by section). */
  private order: string[] = [];
  private groups: Group[] = [];
  private layout: Shelf = layoutShelf([], 1);
  private focus: string | null = null;
  private readonly motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly events: StageEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // photos stay true to the product page
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.camera.position.set(0.3, 1.1, this.frameDistance);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.4, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.6;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 60;
    this.controls.minPolarAngle = Math.PI * 0.3;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.minAzimuthAngle = -Math.PI * 0.34;
    this.controls.maxAzimuthAngle = Math.PI * 0.34;
    this.controls.addEventListener('start', () => {
      this.autoFrame = false; // the viewer took the camera; stop re-framing on their behalf
      canvas.classList.add('is-dragging');
    });
    this.controls.addEventListener('end', () => canvas.classList.remove('is-dragging'));

    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.world);
    this.world.add(this.shelf);
    this.addLights();
    this.dust = makeDust();
    this.world.add(this.dust);

    this.bindPointer();
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  start() {
    this.clock.start();
    this.renderer.setAnimationLoop(this.tick);
  }

  /** Reconcile the shelf with a new item list: drop what left, build what arrived, re-layout all. */
  async setItems(items: Item[]) {
    const ids = new Set(items.map((i) => i.id));
    for (const [id, node] of this.nodes) {
      const next = items.find((i) => i.id === id);
      // A re-ingest keeps the id but bumps addedAt; rebuild so the new asset shows.
      if (!next || next.addedAt !== node.item.addedAt) {
        this.shelf.remove(node.root);
        node.dispose();
        this.nodes.delete(id);
        if (this.hovered === node) this.setHovered(null);
      }
    }
    for (const id of this.targets.keys()) if (!ids.has(id)) this.targets.delete(id);

    const groups = groupItems(items);
    this.groups = groups.map((g) => ({ label: g.label, count: g.items.length }));
    this.order = groups.flatMap((g) => g.items.map((i) => i.id));
    this.focus = null;
    this.autoFrame = true;
    this.relayout();

    await Promise.all(
      items
        .filter((item) => !this.nodes.has(item.id) && !this.pending.has(item.id))
        .map(async (item) => {
          this.pending.add(item.id);
          try {
            const node = await buildItemNode(item);
            const slot = this.targets.get(item.id);
            if (!slot || this.nodes.has(item.id)) {
              node.dispose(); // removed (or replaced) while loading
              return;
            }
            node.root.position.copy(slot.position);
            node.root.rotation.y = slot.yaw;
            node.root.scale.setScalar(0.001);
            this.nodes.set(item.id, node);
            this.shelf.add(node.root);
          } catch (err) {
            console.error(`[things] ${item.id}: could not build`, err);
          } finally {
            this.pending.delete(item.id);
          }
        }),
    );
  }

  /**
   * Frame one section (its label) or the whole shelf (null, or the section already focused).
   * Returns what is focused now.
   */
  focusSection(label: string | null): string | null {
    const known = label !== null && this.groups.some((g) => g.label === label);
    this.focus = known && this.focus !== label ? label : null;
    this.autoFrame = true;
    this.reframe();
    return this.focus;
  }

  // ---------- frame ----------

  private tick = () => {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    if (this.pointerDirty) {
      this.pointerDirty = false;
      this.setHovered(this.pick(this.pointer));
    }

    if (this.motion) {
      this.world.rotation.y = Math.sin(t * 0.11) * 0.018;
      this.dust.rotation.y = t * 0.007;
      this.dust.position.y = Math.sin(t * 0.05) * 0.4;
    }

    const follow = 1 - Math.exp(-dt * 5);
    for (const node of this.nodes.values()) this.animate(node, t, dt, follow);

    if (this.autoFrame) this.easeCamera(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private animate(node: ItemNode, t: number, dt: number, follow: number) {
    const slot = this.targets.get(node.item.id);
    if (slot) {
      node.root.position.lerp(slot.position, follow);
      node.root.rotation.y += (slot.yaw - node.root.rotation.y) * follow;
    }

    const age = (performance.now() - node.born) / 800;
    const grow = age >= 1 ? 1 : 1 - Math.pow(1 - age, 3);
    node.root.scale.setScalar(Math.max(0.001, grow));

    node.hoverAmount += ((node === this.hovered ? 1 : 0) - node.hoverAmount) * (1 - Math.exp(-dt * 9));
    const h = node.hoverAmount;

    // Gentle sway around the facing direction; settle to face the viewer on hover.
    const idle = this.motion ? Math.sin(t * 0.32 + node.phase) * SWAY[node.kind] : 0;
    node.pivot.rotation.y = idle * (1 - h);
    node.pivot.position.y = this.motion ? Math.sin(t * 0.55 + node.phase) * 0.025 : 0;
    node.pivot.scale.setScalar(1 + 0.06 * h);
    node.glow.material.opacity = 0.2 + 0.22 * h;
  }

  /** Slide the orbit target (and the camera with it) toward the goal, and settle the distance. */
  private easeCamera(dt: number) {
    const k = 1 - Math.exp(-dt * 2.2);
    const pan = this.goal.clone().sub(this.controls.target).multiplyScalar(k);
    if (pan.lengthSq() > 1e-8) {
      this.controls.target.add(pan);
      this.camera.position.add(pan);
    }
    const offset = this.camera.position.clone().sub(this.controls.target);
    const d = offset.length();
    if (Math.abs(d - this.frameDistance) < 0.005) return;
    const nd = d + (this.frameDistance - d) * k;
    this.camera.position.copy(this.controls.target).add(offset.multiplyScalar(nd / d));
  }

  /** Assign shelf slots for the current viewport shape, then frame the camera on them. */
  private relayout() {
    this.layout = layoutShelf(this.groups, maxPerRow(this.camera.aspect));
    this.order.forEach((id, i) => this.targets.set(id, this.layout.slots[i]));
    if (this.autoFrame) this.reframe();
  }

  /** Pull back just far enough that the focused section, or the whole shelf, fits the viewport. */
  private reframe() {
    if (this.order.length === 0) {
      this.frameDistance = 8;
      this.goal.set(0, 0.4, 0);
      return;
    }
    const band = this.focus === null ? undefined : this.layout.bands.find((b) => b.label === this.focus);
    const extent = band ?? { ...this.layout, y: 0, rows: this.layout.rows };
    // Pad for item footprint (~FIT) plus breathing room so a section zoom does not clip the band.
    const halfW = extent.halfWidth + 1.85;
    const halfH = extent.halfHeight + 1.65;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const byWidth = halfW / Math.tan(hfov / 2);
    const byHeight = halfH / Math.tan(vfov / 2);
    this.frameDistance = THREE.MathUtils.clamp(Math.max(byWidth, byHeight) * 1.06 + 0.6, 5, 60);
    // Items stand up from their slot, so the visual centre sits a little above the shelf line.
    this.goal.set(0, extent.y + (extent.rows > 1 ? 0.45 : 0.55), 0);
  }

  private resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.fov = this.camera.aspect < 1 ? 48 : 38; // portrait: open up so a stacked shelf still fills the screen
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.relayout();
  };

  // ---------- picking ----------

  private bindPointer() {
    const c = this.canvas;
    // Hover is a mouse / pen affair. Touch pointers "leave" the moment a finger lifts, which
    // would clear the label a tap just revealed, so touch only ever goes through pointerup.
    c.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.pointerDirty = true;
    });
    c.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      // Moving onto the product card must not clear the hover it belongs to.
      const to = e.relatedTarget as Element | null;
      if (to?.closest?.('[data-keep-hover]')) return;
      this.pointer.set(2, 2);
      this.pointerDirty = true;
    });
    c.addEventListener('pointerdown', (e) => {
      this.pressed = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener('pointerup', (e) => {
      const p = this.pressed;
      this.pressed = null;
      if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP_PX) return;
      const at = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      const node = this.pick(at);
      if (e.pointerType === 'touch') {
        // First tap reveals the label, a second tap on the same item follows the link.
        if (node && node === this.hovered) this.events.select(node);
        else this.setHovered(node);
      } else if (node) {
        this.events.select(node);
      }
    });
  }

  private pick(at: THREE.Vector2): ItemNode | null {
    if (at.x > 1 || at.y > 1) return null;
    this.raycaster.setFromCamera(at, this.camera);
    const pivots = [...this.nodes.values()].map((n) => n.pivot);
    const hit = this.raycaster.intersectObjects(pivots, true)[0];
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o && !o.userData.itemId) o = o.parent;
    return o ? this.nodes.get(o.userData.itemId as string) ?? null : null;
  }

  private setHovered(node: ItemNode | null) {
    if (node === this.hovered) return;
    this.hovered = node;
    this.canvas.classList.toggle('is-pointing', !!node);
    this.events.hover(node);
  }

  // ---------- dressing ----------

  private addLights() {
    this.scene.add(new THREE.HemisphereLight(0xe6ebf7, 0x08080c, 0.4));
    const key = new THREE.DirectionalLight(0xfff1de, 1.7);
    key.position.set(3, 6, 5);
    const rim = new THREE.DirectionalLight(0xc2d3ff, 0.9);
    rim.position.set(-5, 3, -4);
    this.scene.add(key, rim);

    // Image-based lighting for GLBs and the procedural box / cylinder sides. Background stays black.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();
  }
}

/** Sparse, dim motes so orbiting reads as moving through space rather than rotating a picture. */
function makeDust(): THREE.Points {
  const count = 420;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 34;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 16;
    positions[i * 3 + 2] = -16 + Math.random() * 18;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    size: 0.045,
    color: 0x9aa4b8,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = -2;
  return points;
}
