/**
 * The void: a black scene with a shelf of items, soft orbit controls, a little drifting dust,
 * and pointer picking for hover / select.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Item } from '../shared/types.ts';
import { buildItemNode, setMaxAnisotropy, type ItemNode, type NodeKind } from './items.ts';
import { layoutShelf, maxPerRow, type Group, type Shelf, type Slot } from './layout.ts';
import { groupItems } from './sections.ts';

export interface StageEvents {
  hover(node: ItemNode | null): void;
  select(node: ItemNode): void;
  /** Models arriving: `ready` of `total` built (failed ones count as done). */
  progress(ready: number, total: number): void;
  /** The GPU dropped the WebGL context; the browser may hand it back. */
  lost(lost: boolean): void;
}

/** Idle yaw amplitude (radians) per kind; keeps the front toward the camera. */
const SWAY: Record<NodeKind, number> = { card: 0.14, box: 0.42, cylinder: 0.95, glb: 0.28 };
const CLICK_SLOP_PX = 6;
/** With nothing moving but the idle sway, 30 fps is indistinguishable and halves the GPU time. */
const IDLE_FRAME_MS = 1000 / 30;

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
  /** Render on demand: a frame is scheduled only while something is changing (or idling, with motion). */
  private frame = 0;
  private activeUntil = 0;
  private lastRender = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly events: StageEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Khronos PBR Neutral: built for product colour fidelity, it only rolls off highlights, so
    // meshes keep their catalogue colours while studio reflections don't clip. Photo cut-outs
    // opt out (toneMapped: false) and stay exactly as on the product page.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
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
    // Dolly along the pointer ray and slide the orbit target so zoom feels anchored under the cursor.
    this.controls.zoomToCursor = true;
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
    this.controls.addEventListener('change', () => this.invalidate(200));

    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.world);
    this.world.add(this.shelf);
    this.addLights();
    this.dust = makeDust();
    this.world.add(this.dust);

    this.bindPointer();
    this.bindKeys();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // ask for it back
      this.events.lost(true);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.events.lost(false);
      this.invalidate();
    });
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  start() {
    this.clock.start();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.invalidate();
    });
    this.invalidate();
  }

  /** Keep frames coming for at least `ms` (and as long after that as anything is still settling). */
  invalidate(ms = 600) {
    this.activeUntil = Math.max(this.activeUntil, performance.now() + ms);
    if (!this.frame && !document.hidden) this.frame = requestAnimationFrame(this.tick);
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

    const total = items.length;
    let ready = items.filter((item) => this.nodes.has(item.id)).length;
    this.events.progress(ready, total);
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
            this.invalidate(1000);
          } catch (err) {
            console.error(`[things] ${item.id}: could not build`, err);
          } finally {
            this.pending.delete(item.id);
            this.events.progress(++ready, total);
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
    this.invalidate();
    return this.focus;
  }

  // ---------- frame ----------

  private tick = (now: number) => {
    this.frame = 0;
    if (document.hidden) return;
    const active = now < this.activeUntil;
    if (!active && !this.motion) return;
    if (!active && now - this.lastRender < IDLE_FRAME_MS - 4) {
      this.frame = requestAnimationFrame(this.tick);
      return;
    }
    this.lastRender = now;
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
    let settling = false;
    for (const node of this.nodes.values()) settling = this.animate(node, t, dt, follow) || settling;
    if (this.autoFrame) settling = this.easeCamera(dt) || settling;
    settling = this.controls.update() || settling;
    this.renderer.render(this.scene, this.camera);

    if (settling) this.activeUntil = Math.max(this.activeUntil, now + 120);
    // invalidate() during this frame may already have queued the next one; never run two loops.
    if (!this.frame && (now < this.activeUntil || this.motion)) this.frame = requestAnimationFrame(this.tick);
  };

  /** Returns true while the node is still in a transition (arriving, moving slots, hover easing). */
  private animate(node: ItemNode, t: number, dt: number, follow: number): boolean {
    let settling = false;
    const slot = this.targets.get(node.item.id);
    if (slot) {
      settling = node.root.position.distanceToSquared(slot.position) > 1e-6 || Math.abs(slot.yaw - node.root.rotation.y) > 1e-4;
      node.root.position.lerp(slot.position, follow);
      node.root.rotation.y += (slot.yaw - node.root.rotation.y) * follow;
    }

    const age = (performance.now() - node.born) / 800;
    const grow = age >= 1 ? 1 : 1 - Math.pow(1 - age, 3);
    node.root.scale.setScalar(Math.max(0.001, grow));

    const hoverGoal = node === this.hovered ? 1 : 0;
    node.hoverAmount += (hoverGoal - node.hoverAmount) * (1 - Math.exp(-dt * 9));
    if (Math.abs(hoverGoal - node.hoverAmount) < 1e-3) node.hoverAmount = hoverGoal;
    else settling = true;
    if (age < 1) settling = true;
    const h = node.hoverAmount;

    // Gentle sway around the facing direction; settle to face the viewer on hover.
    const idle = this.motion ? Math.sin(t * 0.32 + node.phase) * SWAY[node.kind] : 0;
    node.pivot.rotation.y = idle * (1 - h);
    node.pivot.position.y = this.motion ? Math.sin(t * 0.55 + node.phase) * 0.025 : 0;
    node.pivot.scale.setScalar(1 + 0.06 * h);
    node.glow.material.opacity = 0.2 + 0.22 * h;
    // The contact shadow loosens as the thing lifts (bob, hover) so it never looks glued on.
    const lift = node.pivot.position.y + 0.04 * h;
    node.shadow.material.opacity = 0.8 * (1 - THREE.MathUtils.clamp(lift * 6, 0, 0.35)) * Math.min(1, grow * 1.2);
    node.shadow.scale.setScalar(1 + lift * 1.5);
    return settling;
  }

  /** Slide the orbit target (and the camera with it) toward the goal, and settle the distance. */
  private easeCamera(dt: number): boolean {
    // Reduced motion: frame changes jump rather than glide.
    const k = this.motion ? 1 - Math.exp(-dt * 2.2) : 1;
    const pan = this.goal.clone().sub(this.controls.target);
    const offset = this.camera.position.clone().sub(this.controls.target);
    const d = offset.length();
    // Close enough: land exactly, so an idle shelf stops asking for frames.
    const done = pan.lengthSq() < 1e-6 && Math.abs(d - this.frameDistance) < 0.002;
    const step = done ? 1 : k;
    if (pan.lengthSq() > 0) {
      pan.multiplyScalar(step);
      this.controls.target.add(pan);
      this.camera.position.add(pan);
    }
    const nd = d + (this.frameDistance - d) * step;
    if (d > 0) this.camera.position.copy(this.controls.target).add(offset.multiplyScalar(nd / d));
    return !done;
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
    // Portrait screens are width-bound, so the side margin there is kept to the item itself.
    const portrait = this.camera.aspect < 1;
    const halfW = extent.halfWidth + (portrait ? 0.95 : 1.85);
    const halfH = extent.halfHeight + (portrait ? 1.25 : 1.65);
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
    this.invalidate();
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
      this.invalidate(200);
    });
    c.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      // Moving onto the product card must not clear the hover it belongs to.
      const to = e.relatedTarget as Element | null;
      if (to?.closest?.('[data-keep-hover]')) return;
      this.pointer.set(2, 2);
      this.pointerDirty = true;
      this.invalidate(200);
    });
    c.addEventListener('pointerdown', (e) => {
      this.pressed = { x: e.clientX, y: e.clientY };
    });
    // Double-click the void (not a thing: a click there already opened its page) to put the
    // camera back on the whole shelf after orbiting or zooming.
    c.addEventListener('dblclick', (e) => {
      const at = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      if (!this.pick(at)) this.resetView();
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

  /** Frame the whole shelf again, as on load. */
  resetView() {
    this.focusSection(null);
  }

  /**
   * Keyboard: arrows walk the shelf (left/right along it, up/down to the nearest thing on the
   * next shelf), Enter opens the hovered thing, Escape lets go and reframes the shelf.
   */
  private bindKeys() {
    this.canvas.tabIndex = 0;
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName)))) return;
      if (e.key === 'Escape') {
        this.setHovered(null);
        this.resetView();
        return;
      }
      if (e.key === 'Enter' && this.hovered && target?.closest?.('a, button') == null) {
        this.events.select(this.hovered);
        return;
      }
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
      if (!dir) return;
      e.preventDefault();
      this.setHovered(this.neighbour(dir[0], dir[1]));
    });
  }

  private neighbour(dx: number, dy: number): ItemNode | null {
    const built = this.order.map((id) => this.nodes.get(id)).filter((n): n is ItemNode => !!n);
    if (!built.length) return null;
    const cur = this.hovered;
    if (!cur) return dx < 0 || dy < 0 ? built[built.length - 1] : built[0];
    if (dx) {
      const i = built.indexOf(cur);
      return built[(i + dx + built.length) % built.length];
    }
    const p = this.targets.get(cur.item.id)!.position;
    let best: ItemNode | null = null;
    let bestScore = Infinity;
    for (const n of built) {
      const q = this.targets.get(n.item.id)!.position;
      const rise = (q.y - p.y) * dy;
      if (rise < 0.5) continue; // must be on a shelf in that direction
      const score = rise * 2 + Math.abs(q.x - p.x);
      if (score < bestScore) (bestScore = score), (best = n);
    }
    return best ?? cur;
  }

  private pick(at: THREE.Vector2): ItemNode | null {
    if (at.x > 1 || at.y > 1) return null;
    this.raycaster.setFromCamera(at, this.camera);
    // One invisible box per item: cheap, and open shapes (a headband, a desk) hover anywhere inside.
    const boxes = [...this.nodes.values()].map((n) => n.hit);
    for (const hit of this.raycaster.intersectObjects(boxes, false)) {
      const node = this.nodes.get(hit.object.userData.itemId as string);
      if (!node) continue;
      if (!node.precise) return node;
      // Cut-outs are mostly air: only an opaque pixel of the photo counts, else look behind it.
      const { mesh, opaque } = node.precise;
      if (this.raycaster.intersectObject(mesh, false).some((h) => h.uv && opaque(h.uv.x, h.uv.y))) return node;
    }
    return null;
  }

  private setHovered(node: ItemNode | null) {
    if (node === this.hovered) return;
    this.hovered = node;
    this.canvas.classList.toggle('is-pointing', !!node);
    this.events.hover(node);
    this.invalidate();
  }

  // ---------- dressing ----------

  private addLights() {
    // A warm key from upper right shapes the forms; rims from behind separate dark things from
    // the void. Most of the light comes from the studio environment below.
    this.scene.add(new THREE.HemisphereLight(0xe6ebf7, 0x08080c, 0.25));
    const key = new THREE.DirectionalLight(0xfff1de, 1.25);
    key.position.set(3, 6, 5);
    const rim = new THREE.DirectionalLight(0xc2d3ff, 1.6);
    rim.position.set(-5, 3, -4);
    const rim2 = new THREE.DirectionalLight(0xffe8d6, 0.9);
    rim2.position.set(5, 2.5, -5);
    // Low, soft fill from the viewer's side so black plastic still shows its form.
    const fill = new THREE.DirectionalLight(0xdfe6f5, 0.45);
    fill.position.set(-2, 1, 6);
    this.scene.add(key, rim, rim2, fill);

    // Image-based lighting: an unseen photo studio, so steel, glass and lacquer have something
    // to reflect besides black. The background stays the void.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const studio = makeStudio();
    this.scene.environment = pmrem.fromScene(studio, 0.035).texture;
    this.scene.environmentIntensity = 1;
    pmrem.dispose();
    studio.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}

/**
 * A dim grey cyclorama with softboxes: a big overhead diffuser, a key panel front-right, a
 * narrower fill front-left and two strip lights behind for rims. Only ever seen as reflections.
 */
function makeStudio(): THREE.Scene {
  const scene = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(20, 12, 20), new THREE.MeshBasicMaterial({ color: 0x7a7c82, side: THREE.BackSide }));
  room.position.y = 4;
  scene.add(room);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: 0x5c5d62 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.9;
  scene.add(floor);
  const panel = (w: number, h: number, intensity: number, tint: number, pos: [number, number, number]) => {
    const color = new THREE.Color(tint).multiplyScalar(intensity);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0.5, 0);
    scene.add(m);
  };
  panel(12, 9, 1.8, 0xffffff, [0, 9.5, 1]); // overhead diffuser
  panel(8, 7, 2.4, 0xfff2e2, [6, 3.5, 7]); // key
  panel(7, 6, 1.3, 0xe6eeff, [-7, 3, 6]); // fill
  panel(1.4, 8, 2.6, 0xd4e0ff, [-7, 3, -7]); // rims
  panel(1.4, 8, 2.0, 0xfff0e0, [7, 3, -7]);
  return scene;
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
