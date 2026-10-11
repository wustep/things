/**
 * A closer look at the big picture in the detail view, for a mouse and keyboard (touch screens
 * pinch instead). A click zooms toward that spot and the zoom follows the pointer; Z zooms in on
 * the middle, and while zoomed the arrow keys look around. A click or Z again zooms out, as does
 * leaving the picture. Esc isn't handled here: Esc always closes the whole view.
 */

/** How far in a closer look goes. */
export const ZOOM = 2.4;
/** How far one arrow key moves the closer look, as a fraction of the picture. */
const PAN_STEP = 0.12;

/** Whether a closer look is offered at all (a mouse or trackpad; not touch screens). */
export const canZoom = matchMedia('(hover: hover) and (pointer: fine)');

/** Where the zoom centres, as fractions of the picture, from a pointer position. */
export function aimFrom(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }): [number, number] {
  return [clamp((clientX - box.left) / box.width), clamp((clientY - box.top) / box.height)];
}

export function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export class Loupe {
  private on = false;
  private x = 0.5;
  private y = 0.5;

  constructor(private readonly stage: HTMLElement) {
    stage.style.setProperty('--zoom', String(ZOOM));
    stage.addEventListener('click', (e) => {
      if (!canZoom.matches) return;
      if (this.on) this.set(false);
      else if ((e.target as Element).closest('.stage-pic img')) {
        this.aim(e.clientX, e.clientY);
        this.set(true);
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (this.on && e.pointerType !== 'touch') this.aim(e.clientX, e.clientY);
    });
    stage.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch') this.set(false);
    });
  }

  get zoomed(): boolean {
    return this.on;
  }

  /** Z: in on the middle, or back out. */
  toggle() {
    if (!canZoom.matches) return;
    if (!this.on) {
      this.x = this.y = 0.5;
      this.apply();
    }
    this.set(!this.on);
  }

  /** Arrow keys while zoomed: look a little further that way. */
  pan(dx: number, dy: number) {
    this.x = clamp(this.x + dx * PAN_STEP);
    this.y = clamp(this.y + dy * PAN_STEP);
    this.apply();
  }

  set(on: boolean) {
    if (this.on === on) return;
    this.on = on;
    this.stage.classList.toggle('is-zoomed', on);
    if (on) {
      // Ask the srcset for a file as sharp as the zoomed picture (it tops out at the original's size).
      const img = this.img();
      const width = Math.round((img?.offsetWidth ?? this.stage.clientWidth) * ZOOM);
      this.stage.querySelectorAll('source').forEach((src) => (src.sizes = `${width}px`));
    }
  }

  /** The spot under the pointer stays under it. */
  private aim(clientX: number, clientY: number) {
    const img = this.img();
    const pic = img?.parentElement;
    if (!img || !pic) return;
    const box = pic.getBoundingClientRect();
    [this.x, this.y] = aimFrom(clientX, clientY, {
      left: box.left + img.offsetLeft,
      top: box.top + img.offsetTop,
      width: img.offsetWidth,
      height: img.offsetHeight,
    });
    this.apply();
  }

  private apply() {
    const img = this.img();
    if (img) img.style.transformOrigin = `${this.x * 100}% ${this.y * 100}%`;
  }

  private img(): HTMLImageElement | null {
    return this.stage.querySelector('.stage-pic img');
  }
}
