import { Vector3 } from 'three';

/** World-space slot for one item: its base point on the shelf and the yaw that faces the viewer. */
export interface Slot {
  position: Vector3;
  yaw: number;
}

export interface Extents {
  rows: number;
  perRow: number;
  halfWidth: number;
  halfHeight: number;
}

/** Spacing between item bases along the shelf and between shelves. */
export const SPACING = 2.0;
export const ROW_HEIGHT = 2.05;
/** The shelf bows gently around the viewer; larger = flatter. */
const RADIUS = 12;

/** Wide viewports get one long shelf; portrait ones stack shorter shelves instead. */
export function maxPerRow(viewportAspect: number): number {
  if (viewportAspect < 0.7) return 2;
  if (viewportAspect < 1.1) return 3;
  if (viewportAspect < 1.5) return 5;
  return 7;
}

export function extents(n: number, perRowMax: number): Extents {
  if (n === 0) return { rows: 0, perRow: 0, halfWidth: 0, halfHeight: 0 };
  const rows = Math.ceil(n / perRowMax);
  const perRow = Math.ceil(n / rows);
  return {
    rows,
    perRow,
    halfWidth: ((perRow - 1) / 2) * SPACING,
    halfHeight: ((rows - 1) / 2) * ROW_HEIGHT,
  };
}

/**
 * Items sit on one or more shelves, evenly spread along a shallow arc so the ends turn
 * slightly toward the camera. Order is preserved (oldest left, newest right).
 */
export function layoutSlots(n: number, perRowMax: number): Slot[] {
  const { rows, perRow } = extents(n, perRowMax);
  const slots: Slot[] = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const count = Math.min(perRow, n - i);
    const y = ((rows - 1) / 2 - r) * ROW_HEIGHT;
    for (let c = 0; c < count; c++, i++) {
      const along = (c - (count - 1) / 2) * SPACING;
      const theta = along / RADIUS;
      slots.push({
        position: new Vector3(Math.sin(theta) * RADIUS, y, (1 - Math.cos(theta)) * RADIUS),
        yaw: -theta,
      });
    }
  }
  return slots;
}
