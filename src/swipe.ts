/**
 * Horizontal swipes on a touch screen, for stepping between things in the detail view. The page
 * keeps vertical scrolling (`touch-action: pan-y`), so a gesture that starts mostly vertical is the
 * browser's and never moves the view sideways. A horizontal one is followed under the finger and,
 * on release, either commits (far enough, or flicked fast enough) or springs back.
 */

/** Movement before a gesture picks an axis. */
export const LOCK_PX = 10;
/** A swipe commits past this fraction of the width... */
export const COMMIT_FRACTION = 0.22;
/** ...or when flicked faster than this (px/ms), as long as it travelled a little. */
export const FLICK_SPEED = 0.45;
const FLICK_MIN_PX = 30;

export type Axis = 'x' | 'y' | null;

/** Which way a gesture is going, once it has moved far enough to tell; null until then. */
export function lockAxis(dx: number, dy: number): Axis {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < LOCK_PX) return null;
  return ax > ay * 1.2 ? 'x' : 'y';
}

/**
 * What a finished horizontal swipe means: 1 for the next thing (finger moved left), -1 for the
 * previous one, 0 to spring back. `speed` is px/ms over the last moments of the gesture, signed
 * like dx.
 */
export function swipeOutcome(dx: number, speed: number, width: number): -1 | 0 | 1 {
  const far = Math.abs(dx) >= width * COMMIT_FRACTION;
  const flick = Math.abs(speed) >= FLICK_SPEED && Math.abs(dx) >= FLICK_MIN_PX && Math.sign(speed) === Math.sign(dx);
  if (!far && !flick) return 0;
  return dx < 0 ? 1 : -1;
}

/** How far the view follows the finger: one to one, easing off as it nears the edge. */
export function follow(dx: number, width: number): number {
  const limit = width * 0.6;
  return limit * Math.tanh(dx / limit);
}

export interface SwipeHandlers {
  /** The finger moved; `dx` is how far the view should sit from home (0 = back home). */
  move(dx: number): void;
  /** Released: commit to a step, or 0 to spring back. */
  end(delta: -1 | 0 | 1, dx: number): void;
  /** Whether a swipe may start here (not in a text field, a scrolling strip...). */
  allow?(target: Element): boolean;
}

/** Watches one element for horizontal touch swipes. Mouse and pen are left alone. */
export function watchSwipe(root: HTMLElement, handlers: SwipeHandlers): () => void {
  let id: number | null = null;
  let x0 = 0, y0 = 0, axis: Axis = null, dx = 0;
  let samples: { x: number; t: number }[] = [];

  const reset = () => {
    id = null;
    axis = null;
    dx = 0;
    samples = [];
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || id !== null || !e.isPrimary) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || (handlers.allow && !handlers.allow(target))) return;
    id = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
    samples = [{ x: e.clientX, t: e.timeStamp }];
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    const ddx = e.clientX - x0, ddy = e.clientY - y0;
    if (!axis) {
      axis = lockAxis(ddx, ddy);
      if (axis === 'y') return; // the browser scrolls; it will cancel this pointer
      if (axis === 'x') root.setPointerCapture?.(e.pointerId);
    }
    if (axis !== 'x') return;
    dx = ddx;
    samples.push({ x: e.clientX, t: e.timeStamp });
    while (samples.length > 2 && e.timeStamp - samples[0].t > 90) samples.shift();
    handlers.move(follow(dx, root.clientWidth));
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    if (axis === 'x') {
      const first = samples[0], last = samples[samples.length - 1];
      const speed = last && first && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      handlers.end(e.type === 'pointerup' ? swipeOutcome(dx, speed, root.clientWidth) : 0, follow(dx, root.clientWidth));
    }
    reset();
  };

  root.addEventListener('pointerdown', down);
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  return () => {
    root.removeEventListener('pointerdown', down);
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerup', up);
    root.removeEventListener('pointercancel', up);
  };
}
