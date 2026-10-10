import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Item } from '../shared/types.ts';
import { buildItemNode, setMaxAnisotropy, type ItemNode } from './items.ts';
import { layoutShelf, type Slot } from './layout.ts';

export interface StageEvents {
  hover(node: ItemNode | null): void;
  select(node: ItemNode): void;
  loading(loaded: number, total: number, failed: number): void;
  labels(points: { id: string; x: number; y: number; visible: boolean }[]): void;
  unavailable(): void;
}

/** A small, demand-rendered display case. Objects stay planted; the viewer supplies the motion. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(36, 1, .1, 100);
  readonly controls: OrbitControls;
  private readonly objects = new THREE.Group();
  private readonly shelves = new THREE.Group();
  private readonly nodes = new Map<string, ItemNode>();
  private readonly slots = new Map<string, Slot>();
  private readonly raycaster = new THREE.Raycaster();
  private hovered: ItemNode | null = null;
  private items: Item[] = [];
  private revision = 0;
  private visible = true;
  private frame = 0;
  private activeUntil = 0;
  private lastTime = 0;
  private autoFrame = true;
  private readonly targetCamera = new THREE.Vector3();
  private readonly targetLook = new THREE.Vector3();
  private width = 1;
  private height = 1;
  private keyIndex = -1;
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(readonly canvas: HTMLCanvasElement, private readonly events: StageEvents) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setClearColor(0x101110, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());
    this.camera.position.set(.2, 2, 11);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = !this.reduced.matches;
    this.controls.dampingFactor = .12;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = .45;
    this.controls.zoomSpeed = .55;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 20;
    this.controls.minPolarAngle = Math.PI * .29;
    this.controls.maxPolarAngle = Math.PI * .53;
    this.controls.minAzimuthAngle = -.65;
    this.controls.maxAzimuthAngle = .65;
    this.controls.addEventListener('start', () => { this.autoFrame = false; canvas.classList.add('is-dragging'); this.setHovered(null); this.invalidate(); });
    this.controls.addEventListener('end', () => { canvas.classList.remove('is-dragging'); this.invalidate(); });
    this.controls.addEventListener('change', () => this.invalidate(120));
    this.reduced.addEventListener('change', () => { this.controls.enableDamping = !this.reduced.matches; this.invalidate(); });
    this.scene.add(this.objects, this.shelves);
    this.addLights();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelAnimationFrame(this.frame); this.frame = 0; }
      else this.invalidate();
    });
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.events.unavailable(); });
    this.resize();
  }

  start() { this.invalidate(); }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) { cancelAnimationFrame(this.frame); this.frame = 0; }
    else { this.resize(); this.invalidate(); }
  }
  async setItems(items: Item[]) {
    const revision = ++this.revision;
    this.items = items;
    this.keyIndex = -1;
    this.setHovered(null);
    for (const [id, node] of this.nodes) {
      const next = items.find(i => i.id === id);
      if (!next || next.addedAt !== node.item.addedAt) {
        this.objects.remove(node.root); node.dispose(); this.nodes.delete(id);
      } else node.item = next;
    }
    this.relayout(); this.reset();
    const pending = items.filter(item => !this.nodes.has(item.id));
    let loaded = items.length - pending.length, failed = 0, cursor = 0;
    this.events.loading(loaded, items.length, 0);
    // Bounded concurrency keeps model parsing and texture uploads from monopolizing a phone.
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (cursor < pending.length && revision === this.revision) {
        const item = pending[cursor++];
        try {
          const node = await buildItemNode(item);
          if (revision !== this.revision) { node.dispose(); return; }
          const slot = this.slots.get(item.id)!;
          node.root.position.copy(slot.position); node.root.rotation.y = slot.yaw;
          this.nodes.set(item.id, node); this.objects.add(node.root);
        } catch (error) {
          if (revision !== this.revision) return;
          failed++; console.warn(`[things] Unable to display ${item.title}`, error);
        }
        loaded++;
        this.events.loading(loaded, items.length, failed);
        this.invalidate();
      }
    }));
    this.invalidate();
  }
  reset() {
    this.autoFrame = true;
    if (this.reduced.matches) { this.camera.position.copy(this.targetCamera); this.controls.target.copy(this.targetLook); }
    this.invalidate(1800);
  }
  private relayout() {
    const layout = layoutShelf([{ count: this.items.length }], this.width < 600 ? 2 : 4);
    this.slots.clear();
    this.items.forEach((item, index) => this.slots.set(item.id, layout.slots[index]));
    for (const node of this.nodes.values()) {
      const slot = this.slots.get(node.item.id); if (slot) { node.root.position.copy(slot.position); node.root.rotation.y = slot.yaw; }
    }
    for (const object of [...this.shelves.children]) {
      this.shelves.remove(object);
      if (object instanceof THREE.Mesh) { object.geometry.dispose(); for (const m of Array.isArray(object.material) ? object.material : [object.material]) m.dispose(); }
    }
    const rows = new Map<number, Slot[]>();
    for (const slot of layout.slots) rows.set(slot.position.y, [...(rows.get(slot.position.y) || []), slot]);
    for (const [y, slots] of rows) {
      const width = Math.max(...slots.map(s => s.position.x)) - Math.min(...slots.map(s => s.position.x)) + 1.65;
      const board = new THREE.Mesh(new RoundedBoxGeometry(width, .105, 1.48, 3, .035), new THREE.MeshStandardMaterial({ color: 0x353d33, roughness: .52, metalness: .48 }));
      board.position.set(0, y - .1, .08);
      const lip = new THREE.Mesh(new THREE.BoxGeometry(width - .09, .012, .014), new THREE.MeshStandardMaterial({ color: 0x939d87, roughness: .4, metalness: .65 }));
      lip.position.set(0, y - .075, .823);
      this.shelves.add(board, lip);
    }
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = Math.max((layout.halfWidth + 1.15) / (Math.tan(verticalFov / 2) * this.camera.aspect), (layout.halfHeight + 1.2) / Math.tan(verticalFov / 2)) * 1.17;
    this.targetLook.set(0, .46, .1);
    this.targetCamera.set(.16, .46 + distance * .13, distance);
    this.controls.maxDistance = Math.max(20, distance * 1.6);
    this.invalidate();
  }
  private resize() {
    const rect = this.canvas.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return;
    this.width = rect.width; this.height = rect.height;
    this.camera.aspect = this.width / this.height;
    this.camera.fov = this.width < 600 ? 40 : 36;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.relayout(); this.reset();
  }
  private invalidate(duration = 700) {
    this.activeUntil = Math.max(this.activeUntil, performance.now() + duration);
    if (!this.frame && this.visible && !document.hidden) this.frame = requestAnimationFrame(this.tick);
  }
  private tick = (now: number) => {
    this.frame = 0;
    const dt = Math.min((now - this.lastTime) / 1000, .05); this.lastTime = now;
    const k = this.reduced.matches ? 1 : 1 - Math.exp(-dt * 8);
    if (this.autoFrame) {
      this.camera.position.lerp(this.targetCamera, k); this.controls.target.lerp(this.targetLook, k);
      if (this.camera.position.distanceTo(this.targetCamera) > .002) this.activeUntil = Math.max(this.activeUntil, now + 100);
    }
    for (const node of this.nodes.values()) {
      node.hoverAmount += ((node === this.hovered ? 1 : 0) - node.hoverAmount) * k;
      node.pivot.position.y = node.hoverAmount * .055;
      node.pivot.scale.setScalar(1 + node.hoverAmount * .045);
      node.glow.material.opacity = .17 + node.hoverAmount * .12;
      const age = this.reduced.matches ? 1 : Math.min(1, (now - node.born) / 400);
      node.root.scale.setScalar(.94 + .06 * (1 - (1 - age) ** 3));
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    const projected = new THREE.Vector3();
    this.events.labels(this.items.map(item => {
      const slot = this.slots.get(item.id)!;
      projected.copy(slot.position).add(new THREE.Vector3(0, -.2, .95)).project(this.camera);
      const x = (projected.x + 1) * this.width / 2, y = (1 - projected.y) * this.height / 2;
      return { id: item.id, x, y, visible: x > 45 && x < this.width - 45 && y > 55 && y < this.height - 60 && projected.z < 1 };
    }));
    if (now < this.activeUntil && this.visible && !document.hidden && !this.frame) this.frame = requestAnimationFrame(this.tick);
  };
  private at(x: number, y: number) {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1);
  }
  private pick(at: THREE.Vector2) {
    this.raycaster.setFromCamera(at, this.camera);
    const hit = this.raycaster.intersectObjects([...this.nodes.values()].map(n => n.pivot), true)[0];
    let object: THREE.Object3D | null = hit?.object || null;
    while (object && !object.userData.itemId) object = object.parent;
    return object ? this.nodes.get(object.userData.itemId as string) ?? null : null;
  }
  private setHovered(node: ItemNode | null) {
    if (this.hovered === node) return;
    this.hovered = node; this.canvas.classList.toggle('is-pointing', !!node); this.events.hover(node); this.invalidate();
  }
  private bindPointer() {
    let pressed: { x: number; y: number; id: number } | null = null;
    let dragged = false;
    const pointers = new Set<number>();
    this.canvas.addEventListener('pointerdown', e => { pointers.add(e.pointerId); if (pointers.size > 1) dragged = true; else { pressed = { x: e.clientX, y: e.clientY, id: e.pointerId }; dragged = false; } });
    this.canvas.addEventListener('pointermove', e => {
      if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 6) dragged = true;
      if (e.pointerType !== 'touch' && !pointers.size) this.setHovered(this.pick(this.at(e.clientX, e.clientY)));
    });
    this.canvas.addEventListener('pointerup', e => {
      pointers.delete(e.pointerId);
      if (pressed?.id === e.pointerId && !dragged) { const node = this.pick(this.at(e.clientX, e.clientY)); if (node) this.events.select(node); }
      if (!pointers.size) pressed = null;
    });
    this.canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); pressed = null; dragged = true; });
    this.canvas.addEventListener('pointerleave', () => this.setHovered(null));
    this.canvas.addEventListener('keydown', e => {
      if (e.key.toLowerCase() === 'r') { e.preventDefault(); this.reset(); }
      if (e.key === 'Escape') this.setHovered(null);
      if (e.key === 'Enter' && this.hovered) { e.preventDefault(); this.events.select(this.hovered); }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && this.items.length) {
        e.preventDefault(); const direction = ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1;
        this.keyIndex = (this.keyIndex + direction + this.items.length) % this.items.length;
        this.setHovered(this.nodes.get(this.items[this.keyIndex].id) || null);
      }
    });
  }
  private addLights() {
    this.scene.add(new THREE.HemisphereLight(0xf5f6ed, 0x172013, 1.3));
    const key = new THREE.DirectionalLight(0xfff2db, 2.6); key.position.set(-3, 7, 6);
    const fill = new THREE.DirectionalLight(0xdde5ee, 1.4); fill.position.set(5, 2, 4);
    const rim = new THREE.DirectionalLight(0xd9e7c9, 2); rim.position.set(0, 4, -3);
    this.scene.add(key, fill, rim);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, .06).texture;
    this.scene.environmentIntensity = .65;
    room.dispose(); pmrem.dispose();
  }
}
