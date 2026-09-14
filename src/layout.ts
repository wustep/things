import { Vector3 } from 'three';

/** World-space slot for one item: its base point on the shelf and the yaw that faces the viewer. */
export interface Slot {
  position: Vector3;
  yaw: number;
}

/** What the layout needs to know about a section. */
export interface Group {
  label?: string;
  count: number;
}

/** One section's block of shelves, for framing the camera on it. */
export interface Band {
  label?: string;
  rows: number;
  /** Vertical centre of the block's rows. */
  y: number;
  halfWidth: number;
  halfHeight: number;
}

export interface Shelf {
  /** One per item, in the order the groups were given. */
  slots: Slot[];
  bands: Band[];
  rows: number;
  halfWidth: number;
  halfHeight: number;
}

/** Spacing between item bases along the shelf and between shelves. */
export const SPACING = 2.0;
export const ROW_HEIGHT = 2.05;
/** Extra room between one section's last shelf and the next section's first. */
export const SECTION_GAP = 0.9;
/** The shelf bows gently around the viewer; larger = flatter. */
const RADIUS = 12;

/** Wide viewports get long shelves; portrait ones stack shorter shelves instead. */
export function maxPerRow(viewportAspect: number): number {
  if (viewportAspect < 0.7) return 2;
  if (viewportAspect < 1.1) return 3;
  if (viewportAspect < 1.5) return 5;
  return 7;
}

/**
 * Items sit on shelves, evenly spread along a shallow arc so the ends turn slightly toward the
 * camera. Each section is its own block of shelves; blocks stack top to bottom in section order
 * with a little extra room between them, and within a block order is preserved (first left,
 * last right). The whole arrangement is centred on y = 0.
 */
export function layoutShelf(groups: Group[], perRowMax: number): Shelf {
  const blocks = groups
    .filter((g) => g.count > 0)
    .map((g) => {
      const rows = Math.ceil(g.count / perRowMax);
      return { ...g, rows, perRow: Math.ceil(g.count / rows) };
    });
  const rows = blocks.reduce((n, b) => n + b.rows, 0);
  if (rows === 0) return { slots: [], bands: [], rows: 0, halfWidth: 0, halfHeight: 0 };

  // Distance from the first shelf's centre line to the last one's.
  const span = (rows - 1) * ROW_HEIGHT + (blocks.length - 1) * SECTION_GAP;
  const top = span / 2;
  const slots: Slot[] = [];
  const bands: Band[] = [];
  let cursor = 0;
  for (const block of blocks) {
    let placed = 0;
    const firstY = top - cursor;
    for (let r = 0; r < block.rows; r++) {
      const count = Math.min(block.perRow, block.count - placed);
      const y = top - cursor;
      for (let c = 0; c < count; c++, placed++) {
        const along = (c - (count - 1) / 2) * SPACING;
        const theta = along / RADIUS;
        slots.push({
          position: new Vector3(Math.sin(theta) * RADIUS, y, (1 - Math.cos(theta)) * RADIUS),
          yaw: -theta,
        });
      }
      cursor += ROW_HEIGHT;
    }
    const lastY = top - (cursor - ROW_HEIGHT);
    bands.push({
      label: block.label,
      rows: block.rows,
      y: (firstY + lastY) / 2,
      halfWidth: ((block.perRow - 1) / 2) * SPACING,
      halfHeight: (firstY - lastY) / 2,
    });
    cursor += SECTION_GAP;
  }
  return {
    slots,
    bands,
    rows,
    halfWidth: Math.max(...bands.map((b) => b.halfWidth)),
    halfHeight: span / 2,
  };
}
