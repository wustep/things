/**
 * Horizontal swipes on a touch screen, for stepping between things in the detail view. The page
 * keeps vertical scrolling (`touch-action: pan-y pinch-zoom` on the whole sheet, photo included), so
 * a gesture that starts mostly vertical is the browser's and never moves the view sideways. A
 * horizontal one is followed under the finger and, on release, either commits (far enough, or
 * flicked fast enough) or springs back.
 *
 * Touch events carry the gesture where the browser has them: they keep coming after the browser
 * takes a pan for itself (where a pointer gets pointercancel and goes quiet), and once a gesture is
 * locked sideways its touchmoves are cancelled, so nothing underneath can claim it. Pointer events
 * carry it where there are no touch events. A pinch (a second finger) or a page
 * that is already pinch-zoomed is left to the browser, which pans the zoomed page instead.
 *
 * iOS keeps the first ~20px from either screen edge for its own back/forward gesture; a swipe that
 * starts there may be taken by Safari before the page sees it. That is the platform's, not ours.
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
  /** Whether a swipe may start here (not in a text field...). */
  allow?(target: Element): boolean;
  /**
   * Whether something under the finger scrolls this way itself (a photo strip with more to show
   * in that direction), checked once the gesture is known to be sideways: it keeps the gesture.
   * At its end, the same swipe steps instead.
   */
  scrollsItself?(target: Element, dx: number): boolean;
}

/** Whether the page is pinch-zoomed in: then a sideways drag pans the zoomed page instead. */
function zoomedIn(): boolean {
  return (window.visualViewport?.scale ?? 1) > 1.01;
}

/** Watches one element for horizontal touch swipes. Mouse and pen are left alone. */
export function watchSwipe(root: HTMLElement, handlers: SwipeHandlers): () => void {
  let active = false;
  let from: Element | null = null;
  let x0 = 0, y0 = 0, axis: Axis = null, dx = 0;
  let samples: { x: number; t: number }[] = [];

  const begin = (target: EventTarget | null, x: number, y: number, t: number): boolean => {
    const el = target instanceof Element ? target : null;
    if (!el || zoomedIn() || (handlers.allow && !handlers.allow(el))) return false;
    active = true;
    from = el;
    axis = null;
    dx = 0;
    x0 = x;
    y0 = y;
    samples = [{ x, t }];
    return true;
  };

  /** Follows the finger; returns whether this gesture is now a sideways swipe. */
  const track = (x: number, y: number, t: number): boolean => {
    if (!active) return false;
    if (!axis) {
      axis = lockAxis(x - x0, y - y0);
      if (axis === 'y') {
        active = false; // a scroll: the browser's
        return false;
      }
      if (!axis) return false;
      if (from && handlers.scrollsItself?.(from, x - x0)) {
        active = false; // the strip under the finger scrolls this way: its gesture
        axis = null;
        return false;
      }
    }
    dx = x - x0;
    samples.push({ x, t });
    while (samples.length > 2 && t - samples[0].t > 90) samples.shift();
    handlers.move(follow(dx, root.clientWidth));
    return true;
  };

  /** Lets go: commit or spring back (`cancelled` always springs back). */
  const finish = (cancelled: boolean) => {
    if (active && axis === 'x') {
      const first = samples[0], last = samples[samples.length - 1];
      const speed = last && first && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      handlers.end(cancelled ? 0 : swipeOutcome(dx, speed, root.clientWidth), follow(dx, root.clientWidth));
    }
    active = false;
    from = null;
    axis = null;
    samples = [];
  };

  const off: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
    root.addEventListener(type, fn, opts);
    off.push(() => root.removeEventListener(type, fn, opts));
  };

  // Both are heard. A touch screen sends pointer events first and touch events right after, so a
  // gesture a pointer started is taken over by its touch sequence, and from then on the pointer's
  // pointercancel (the browser panning) means nothing. Pointer events alone still work.
  let source: 'touch' | 'pointer' | null = null;
  let touchId: number | null = null, pointerId: number | null = null;
  const find = (list: TouchList) => Array.from(list).find((t) => t.identifier === touchId);
  const done = (cancelled: boolean) => {
    source = null;
    touchId = pointerId = null;
    finish(cancelled);
  };

  on('touchstart', (e) => {
    // A second finger is a pinch: whatever was moving goes back home and the browser has it.
    if (e.touches.length > 1) {
      if (source) done(true);
      return;
    }
    const t = e.changedTouches[0];
    if (begin(e.target, t.clientX, t.clientY, e.timeStamp)) {
      source = 'touch';
      touchId = t.identifier;
    } else if (source) done(true);
  }, { passive: true });
  // Not passive: once a gesture is ours (locked sideways), its moves are cancelled so the browser and
  // anything underneath leave it alone. Until then, and for scrolls, nothing is cancelled.
  on('touchmove', (e) => {
    const t = source === 'touch' ? find(e.changedTouches) : undefined;
    if (t && track(t.clientX, t.clientY, e.timeStamp) && e.cancelable) e.preventDefault();
  }, { passive: false });
  const touchUp = (e: TouchEvent) => {
    if (source === 'touch' && find(e.changedTouches)) done(e.type === 'touchcancel');
  };
  on('touchend', touchUp);
  on('touchcancel', touchUp);

  on('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || source || !e.isPrimary) return;
    if (begin(e.target, e.clientX, e.clientY, e.timeStamp)) {
      source = 'pointer';
      pointerId = e.pointerId;
    }
  });
  on('pointermove', (e) => {
    if (source !== 'pointer' || e.pointerId !== pointerId) return;
    const locked = axis === 'x';
    if (track(e.clientX, e.clientY, e.timeStamp) && !locked) root.setPointerCapture?.(e.pointerId);
  });
  const pointerUp = (e: PointerEvent) => {
    if (source === 'pointer' && e.pointerId === pointerId) done(e.type === 'pointercancel');
  };
  on('pointerup', pointerUp);
  on('pointercancel', pointerUp);
  return () => off.forEach((f) => f());
}
