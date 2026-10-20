/**
 * Helpers for the glide between a thing on the shelf and the stage (see transition() in main.ts).
 * Kept apart from the DOM wiring so the arithmetic can be tested.
 */

/** The box a picture of this aspect takes inside a box, contained (as max-width/max-height: 100% do). */
export function containBox(boxW: number, boxH: number, aspect: number, cap = Infinity): { width: number; height: number } {
  const w0 = Math.min(boxW, cap), h0 = Math.min(boxH, cap);
  if (!(aspect > 0) || !(w0 > 0) || !(h0 > 0)) return { width: 0, height: 0 };
  return w0 / h0 > aspect ? { width: h0 * aspect, height: h0 } : { width: w0, height: w0 / aspect };
}

/**
 * The stage's big picture isn't here yet (a slow network): until it is, the thing's shelf picture,
 * already loaded and decoded, stands in for it, drawn onto a canvas in the big one's exact box (a
 * canvas because drawing is immediate: a new img or a CSS background of the same file would load
 * and decode on their own time, and could miss the frame). The glide then always flies a picture
 * between the two boxes; the sharp one takes the canvas's place, and its name, once decoded.
 */
export function standIn(img: HTMLImageElement, thumb: HTMLImageElement): HTMLCanvasElement | null {
  const box = img.parentElement?.getBoundingClientRect();
  // The intrinsic size from its attributes: img.width is its laid-out width, 0 while it's empty.
  const w = Number(img.getAttribute('width')), h = Number(img.getAttribute('height'));
  if (!box || !(w > 0) || !(h > 0) || !thumb.complete || !thumb.naturalWidth) return null;
  // An app's icon is held to 280px up close (style.css, .stage-pic.is-icon img).
  const cap = img.closest('.is-icon') ? 280 : Infinity;
  const { width, height } = containBox(box.width, box.height, w / h, cap);
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'stand-in';
  canvas.width = thumb.naturalWidth;
  canvas.height = thumb.naturalHeight;
  try {
    canvas.getContext('2d')?.drawImage(thumb, 0, 0);
  } catch {
    return null;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.viewTransitionName = img.style.viewTransitionName;
  img.style.viewTransitionName = '';
  img.style.display = 'none';
  img.before(canvas);
  const done = () => {
    // Mid-glide it takes over the name, so the flight carries on with the sharp picture.
    img.style.viewTransitionName = canvas.style.viewTransitionName;
    img.style.display = '';
    canvas.remove();
  };
  img.decode().then(done, done);
  return canvas;
}

/** True once the image is decoded, false if that takes longer than `ms` or fails. */
export function decoded(img: HTMLImageElement, ms: number): Promise<boolean> {
  // decode() even when complete: an async-decoded image can be loaded and still not paintable.
  return Promise.race([
    img.decode().then(() => true, () => false),
    new Promise<boolean>((done) => setTimeout(() => done(false), ms)),
  ]);
}
