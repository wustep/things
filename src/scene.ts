/**
 * The void: a black scene with a shelf of items, a camera in front of it, a little drifting
 * dust, and pointer picking for hover / focus.
 *
 * Two ways of looking:
 *  - browsing: the camera faces the shelf from the distance that fits its width and rides a
 *    vertical rail along the rows (wheel, drag, arrow keys, the section labels). A drag also
 *    leans a little to the side for parallax; that is all the orbit there is.
 *  - focused: one item is framed close, in the part of the viewport the detail card leaves
 *    free. Drag orbits it, wheel zooms it, ←/→ step along the shelf, Esc or a click on the
 *    void steps back out.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Item } from '../shared/types.ts';
import { buildItemNode, setMaxAnisotropy, type ItemNode, type NodeKind } from './items.ts';
import { layoutShelf, maxPerRow, ROW_HEIGHT, type Group, type Shelf, type Slot } from './layout.ts';
import { groupItems } from './sections.ts';

export interface StageEvents {
  hover(node: ItemNode | null): void;
  /** Focus moved to an item (with its place in shelf order), or with null back to browsing. */
  focus(item: Item | null, index: number, total: number): void;
  /** While browsing, the section under the reading line changed (null: the whole shelf is in view). */
  section(label: string | null): void;
  /** Share of the viewport the chrome covers on the right and at the bottom while an item is focused. */
  insets(): { right: number; bottom: number };
}

/** Idle yaw amplitude (radians) per kind; keeps the front toward the camera. */
const SWAY: Record<NodeKind, number> = { card: 0.14, box: 0.42, cylinder: 0.95, glb: 0.28 };
const CLICK_SLOP_PX = 6;
/** Items stand up from their slot, so the visual centre of a row sits above the shelf line. */
const ROW_LIFT = 0.5;
/** Browsing: camera a touch above the shelf line; focused: a little more, like looking at a desk. */
const BROWSE_PITCH = 0.1;
const FOCUS_PITCH = 0.16;
/** How far a drag may lean the browsing camera to the side (radians). */
const LEAN_MAX = 0.2;
/**
 * Orbit range around a focused item: turn it about 70° either way and look from a little
 * below to well above, but never spin it or lose it; the framed view is always one ←/→ away.
 */
const ORBIT_YAW_MAX = 1.2;
const ORBIT_PITCH = { min: -0.2, max: 0.7 };
const BROWSE_ZOOM = { min: 0.3, max: 1.5 };
/** Wheel around a focused item nudges the framed distance, it does not dolly off into the void. */
const FOCUS_ZOOM = { min: 0.7, max: 1.8 };
/** Share of the free viewport a focused item may fill (height, then width for wide things). */
const FOCUS_FILL = { h: 0.52, w: 0.6 };

interface View {
  target: THREE.Vector3;
  distance: number;
  yaw: number;
  pitch: number;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly world = new THREE.Group();
  private readonly shelf = new THREE.Group();
  private readonly dust: THREE.Points;
  private readonly nodes = new Map<string, ItemNode>();
  private readonly items = new Map<string, Item>();
  private readonly targets = new Map<string, Slot>();
  private readonly pending = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2(2, 2); // off-screen until the pointer moves
  private readonly clock = new THREE.Clock();
  private pointerDirty = false;
  private hovered: ItemNode | null = null;
  /** Item ids in layout order (grouped by section). */
  private order: string[] = [];
  private groups: Group[] = [];
  private layout: Shelf = layoutShelf([], 1);
  private readonly motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- camera rig ----
  /** Where the camera is (eased every frame toward `goal`). */
  private readonly view: View = { target: new THREE.Vector3(0, ROW_LIFT, 0), distance: 12, yaw: 0, pitch: BROWSE_PITCH };
  private readonly goal: View = { target: new THREE.Vector3(0, ROW_LIFT, 0), distance: 12, yaw: 0, pitch: BROWSE_PITCH };
  private snap = true;
  /** Browsing: height along the shelf the camera looks at, and the shelf's vertical extent. */
  private rail = ROW_LIFT;
  private contentTop = ROW_LIFT;
  private contentBottom = ROW_LIFT;
  private browseDistance = 12;
  private zoom = 1;
  private lean = 0;
  /** Focused: which item, and how the viewer has turned / zoomed it. */
  private focusId: string | null = null;
  private readonly orbit = { yaw: 0, pitch: 0 };
  private focusZoom = 1;
  private activeSection: string | null | undefined;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly events: StageEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Khronos PBR Neutral: made for product renders — hue and saturation survive, only the
    // brightest highlights roll off. Photo cut-outs opt out (toneMapped: false) so they stay
    // exactly as the product page had them.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);

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

  get focused(): string | null {
    return this.focusId;
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
    this.items.clear();
    for (const item of items) this.items.set(item.id, item);

    const groups = groupItems(items);
    this.groups = groups.map((g) => ({ label: g.label, count: g.items.length }));
    this.order = groups.flatMap((g) => g.items.map((i) => i.id));
    this.relayout();
    if (this.focusId && !ids.has(this.focusId)) this.focusItem(null);
    else if (this.focusId) this.announceFocus();

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

  // ---------- navigation ----------

  /** Focus an item (frame it, tell the chrome) or, with null, go back to browsing where it was. */
  focusItem(id: string | null) {
    if (id !== null && !this.items.has(id)) return;
    const was = this.focusId;
    this.focusId = id;
    this.orbit.yaw = 0;
    this.orbit.pitch = 0;
    this.focusZoom = 1;
    if (id === null && was) {
      // Come back out onto the rail at the row we were looking at.
      const slot = this.targets.get(was);
      if (slot) this.rail = this.clampRail(slot.position.y + ROW_LIFT);
      this.lean = 0;
      this.activeSection = undefined; // the chrome showed the item's section; re-read the rail
    }
    this.announceFocus();
  }

  /** Step to the previous / next item in shelf order (wrapping). With nothing focused, start at an end. */
  focusNeighbor(step: 1 | -1) {
    const n = this.order.length;
    if (n === 0) return;
    const at = this.focusId ? this.order.indexOf(this.focusId) : -1;
    const next = at < 0 ? (step > 0 ? 0 : n - 1) : (at + step + n) % n;
    this.focusItem(this.order[next]);
  }

  /**
   * Frame a section's shelves (leaving any focused item): come in close enough that its block
   * fills the view, centred on it. Picking the section already framed that way pulls back out
   * to the whole shelf again, staying at its rows.
   */
  focusSection(label: string) {
    const band = this.layout.bands.find((b) => b.label === label);
    if (!band) return;
    if (this.focusId) this.focusItem(null);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const byH = (band.halfHeight + ROW_LIFT + 1.05) / Math.tan(vfov / 2);
    const byW = (band.halfWidth + 1.65) / Math.tan(hfov / 2);
    const fit = THREE.MathUtils.clamp(Math.max(byH, byW) / this.browseDistance, BROWSE_ZOOM.min, 1);
    const framed = this.activeSection === label && Math.abs(this.zoom - fit) < 1e-3;
    this.zoom = framed ? 1 : fit;
    this.rail = this.clampRail(band.y + ROW_LIFT);
    this.lean = 0;
  }

  /** Keyboard scrolling while browsing: a share of the visible height per press. */
  scrollBy(pages: number) {
    if (this.focusId) return;
    this.rail = this.clampRail(this.rail - pages * this.visibleHeight(this.browseDistance * this.zoom) * 0.6);
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

    this.updateGoal();
    this.easeCamera(dt);
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

    const lit = node === this.hovered || node.item.id === this.focusId;
    node.hoverAmount += ((lit ? 1 : 0) - node.hoverAmount) * (1 - Math.exp(-dt * 9));
    const h = node.hoverAmount;

    // Gentle sway around the facing direction; settle to face the viewer on hover / focus.
    const idle = this.motion ? Math.sin(t * 0.32 + node.phase) * SWAY[node.kind] : 0;
    node.pivot.rotation.y = idle * (1 - h);
    node.pivot.position.y = this.motion ? Math.sin(t * 0.55 + node.phase) * 0.025 * (1 - h) : 0;
    node.pivot.scale.setScalar(1 + 0.06 * h);
    node.glow.material.opacity = 0.2 + 0.22 * h;
  }

  /** Decide where the camera wants to be this frame, from the mode and what the viewer did. */
  private updateGoal() {
    const g = this.goal;
    const slot = this.focusId ? this.targets.get(this.focusId) : undefined;
    if (this.focusId && slot) {
      const size = this.nodes.get(this.focusId)?.size ?? { w: 1, h: 1, d: 1 };
      const { right, bottom } = this.events.insets();
      const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
      // Close enough that the item fills its share of the free viewport, by height and by footprint.
      const byH = size.h / (2 * tanH * FOCUS_FILL.h * Math.max(0.2, 1 - bottom));
      const byW = Math.max(size.w, size.d) / (2 * tanH * this.camera.aspect * FOCUS_FILL.w * Math.max(0.2, 1 - right));
      g.distance = THREE.MathUtils.clamp(Math.max(byH, byW), 1.3, 8) * this.focusZoom;
      this.shelf.localToWorld(g.target.copy(slot.position).setY(slot.position.y + size.h / 2));
      g.yaw = slot.yaw + this.orbit.yaw;
      g.pitch = FOCUS_PITCH + this.orbit.pitch;
      return;
    }
    g.target.set(0, this.rail, 0);
    g.distance = this.browseDistance * this.zoom;
    g.yaw = this.lean;
    g.pitch = BROWSE_PITCH;
    this.setActiveSection(this.sectionAt(this.rail));
  }

  /** Ease the view toward the goal and place the camera; a focused item is shifted clear of the chrome. */
  private easeCamera(dt: number) {
    const v = this.view;
    const g = this.goal;
    const k = this.snap ? 1 : 1 - Math.exp(-dt * 4.5);
    this.snap = false;
    v.target.lerp(g.target, k);
    v.distance += (g.distance - v.distance) * k;
    v.yaw += (g.yaw - v.yaw) * k;
    v.pitch += (g.pitch - v.pitch) * k;

    const cp = Math.cos(v.pitch);
    this.camera.position.set(
      v.target.x + Math.sin(v.yaw) * cp * v.distance,
      v.target.y + Math.sin(v.pitch) * v.distance,
      v.target.z + Math.cos(v.yaw) * cp * v.distance,
    );
    this.camera.lookAt(v.target);

    if (!this.focusId) return;
    // Slide the framing sideways / down by half the chrome's share, so the item is centred in the
    // free part of the viewport (right of a phone's bottom sheet, left of a desktop panel).
    const { right, bottom } = this.events.insets();
    if (right <= 0 && bottom <= 0) return;
    const h = this.visibleHeight(v.distance);
    const w = h * this.camera.aspect;
    const q = this.camera.quaternion;
    this.camera.position
      .addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(q), (right / 2) * w)
      .addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(q), (-bottom / 2) * h);
  }

  /** World height in view at a distance. */
  private visibleHeight(distance: number): number {
    return 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
  }

  /** Assign shelf slots for the current viewport shape, then set the browsing distance and rail. */
  private relayout() {
    this.layout = layoutShelf(this.groups, maxPerRow(this.camera.aspect));
    this.order.forEach((id, i) => this.targets.set(id, this.layout.slots[i]));
    this.reframe();
  }

  /**
   * Browsing distance: pull back just far enough that the widest shelf fits the viewport, but
   * never so close that fewer than about two rows show. The rail then runs from the top row to
   * the bottom one; when the whole shelf fits, it has nowhere to go and rests on the centre.
   */
  private reframe() {
    const atTop = this.rail >= this.railRange().max - 1e-3;
    if (this.order.length === 0) {
      this.browseDistance = 8;
      this.contentTop = this.contentBottom = this.rail = ROW_LIFT;
      return;
    }
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const byWidth = (this.layout.halfWidth + 1.65) / Math.tan(hfov / 2);
    const twoRows = (ROW_HEIGHT * 1.1) / Math.tan(vfov / 2);
    this.browseDistance = THREE.MathUtils.clamp(Math.max(byWidth, twoRows), 4, 40);
    this.contentTop = this.layout.halfHeight + ROW_LIFT + 1.1; // the top row's items, plus air
    this.contentBottom = -this.layout.halfHeight - 0.7;
    // Start at the top (first section) and stay there across resizes; otherwise keep our place.
    this.rail = atTop || this.snap ? this.railRange().max : this.clampRail(this.rail);
  }

  /**
   * How far the rail may travel at the current zoom; a point when the whole shelf is in view.
   * The top stays tight (void above a shelf looks like a mistake); the bottom may run on far
   * enough to centre the last section, since void below one reads as the end of the page.
   */
  private railRange(): { min: number; max: number } {
    const halfVisible = this.visibleHeight(this.browseDistance * this.zoom) / 2;
    const max = this.contentTop - halfVisible;
    const last = this.layout.bands.at(-1);
    const min = Math.min(this.contentBottom + halfVisible, last ? last.y + ROW_LIFT : Infinity);
    if (min >= max) {
      const mid = (this.contentTop + this.contentBottom) / 2;
      return { min: mid, max: mid };
    }
    return { min, max };
  }

  private clampRail(y: number): number {
    const { min, max } = this.railRange();
    return THREE.MathUtils.clamp(y, min, max);
  }

  /**
   * Which section the chrome should call current while browsing: none when the whole shelf is
   * in view; the first or last when the rail is at its end; otherwise the one under a reading
   * line in the upper part of the view.
   */
  private sectionAt(rail: number): string | null {
    const { min, max } = this.railRange();
    const bands = this.layout.bands;
    if (max - min < 1e-3 || bands.length === 0) return null;
    if (rail >= max - 1e-3) return bands[0].label ?? null;
    if (rail <= min + 1e-3) return bands[bands.length - 1].label ?? null;
    const line = rail + this.visibleHeight(this.browseDistance * this.zoom) * 0.2;
    let best: { label?: string; d: number } | undefined;
    for (const b of bands) {
      const d = Math.max(0, Math.abs(line - (b.y + ROW_LIFT)) - b.halfHeight);
      if (!best || d < best.d) best = { label: b.label, d };
    }
    return best?.label ?? null;
  }

  private setActiveSection(label: string | null) {
    if (label === this.activeSection) return;
    this.activeSection = label;
    this.events.section(label);
  }

  private announceFocus() {
    const item = this.focusId ? this.items.get(this.focusId) ?? null : null;
    this.events.focus(item, item ? this.order.indexOf(item.id) : -1, this.order.length);
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

  // ---------- pointer ----------

  private bindPointer() {
    const c = this.canvas;
    const down = new Map<number, { x: number; y: number }>();
    let press: { x: number; y: number } | null = null;
    let dragging = false;
    let pinch = 0;
    const spread = () => {
      const [a, b] = [...down.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    c.addEventListener('pointerdown', (e) => {
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.setPointerCapture(e.pointerId);
      if (down.size === 1) {
        press = { x: e.clientX, y: e.clientY };
        dragging = false;
      } else {
        press = null; // a second finger: this is a pinch, not a tap
        pinch = spread();
      }
    });
    c.addEventListener('pointermove', (e) => {
      // Hover is a mouse / pen affair; touch pointers only ever tap.
      if (e.pointerType !== 'touch') {
        this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
        this.pointerDirty = true;
      }
      const prev = down.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      down.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (down.size >= 2) {
        const s = spread();
        if (pinch > 0 && s > 0) this.zoomBy(pinch / s);
        pinch = s;
        return;
      }
      if (press && !dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX) {
        dragging = true;
        c.classList.add('is-dragging');
      }
      if (dragging) this.drag(dx, dy);
    });
    const lift = (e: PointerEvent) => {
      const wasDown = down.delete(e.pointerId);
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      if (wasDown && press && !dragging && e.type === 'pointerup') this.click(e.clientX, e.clientY);
      press = null;
      if (down.size === 0) {
        dragging = false;
        c.classList.remove('is-dragging');
      }
    };
    c.addEventListener('pointerup', lift);
    c.addEventListener('pointercancel', lift);
    c.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      // Moving onto the caption must not clear the hover it belongs to.
      const to = e.relatedTarget as Element | null;
      if (to?.closest?.('[data-keep-hover]')) return;
      this.pointer.set(2, 2);
      this.pointerDirty = true;
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY;
        if (this.focusId) this.zoomBy(Math.exp(dy * 0.0012));
        else if (e.ctrlKey) this.zoomBy(Math.exp(dy * 0.002)); // trackpad pinch arrives as ctrl+wheel
        else this.rail = this.clampRail(this.rail - dy * this.worldPerPixel());
      },
      { passive: false },
    );
  }

  /** A drag: around a focused item it orbits; on the shelf it scrolls, with a little lean sideways. */
  private drag(dx: number, dy: number) {
    if (this.focusId) {
      this.orbit.yaw = THREE.MathUtils.clamp(this.orbit.yaw - dx * 0.006, -ORBIT_YAW_MAX, ORBIT_YAW_MAX);
      this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + dy * 0.006, ORBIT_PITCH.min, ORBIT_PITCH.max);
      return;
    }
    this.lean = THREE.MathUtils.clamp(this.lean - dx * 0.0015, -LEAN_MAX, LEAN_MAX);
    this.rail = this.clampRail(this.rail + dy * this.worldPerPixel());
  }

  private zoomBy(factor: number) {
    if (this.focusId) {
      this.focusZoom = THREE.MathUtils.clamp(this.focusZoom * factor, FOCUS_ZOOM.min, FOCUS_ZOOM.max);
      return;
    }
    this.zoom = THREE.MathUtils.clamp(this.zoom * factor, BROWSE_ZOOM.min, BROWSE_ZOOM.max);
    this.rail = this.clampRail(this.rail); // pulling back can leave the rail past the new end
  }

  /** World units per screen pixel at the browsing distance, so scrolling tracks the finger 1:1. */
  private worldPerPixel(): number {
    return this.visibleHeight(this.browseDistance * this.zoom) / window.innerHeight;
  }

  /** A tap or click: on an item it focuses it; on the void it leaves focus. */
  private click(x: number, y: number) {
    const at = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    const node = this.pick(at);
    if (node) this.focusItem(node.item.id);
    else if (this.focusId) this.focusItem(null);
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

  /**
   * A white studio, not a moody one: product photos are shot under big neutral softboxes, so
   * the meshes get the same. Lighting is mostly the room environment (even, colourless, shows
   * steel as steel); a white key and a soft fill only add shape. Tinted lights are out — a warm
   * key and a blue rim were shifting every hue on the shelf. The void itself stays black: the
   * environment lights things, it is never drawn.
   */
  private addLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a2e, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(3, 6, 5);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-4, 2.5, 3);
    this.scene.add(key, fill);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 1.3;
    pmrem.dispose();
  }
}

/** Sparse, dim motes so moving the camera reads as moving through space rather than sliding a picture. */
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
