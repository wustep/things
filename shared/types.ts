/** Shared between the ingest script (Node) and the viewer (browser). */

export type ProceduralShape = 'card' | 'box' | 'cylinder';

export interface ProceduralAsset {
  kind: 'procedural';
  shape: ProceduralShape;
  /** Public path to the background-removed primary image (PNG with alpha). */
  texture: string;
  /** width / height of the trimmed primary image. */
  aspect: number;
  /** Dominant colors, hex, most prominent first. */
  palette: string[];
}

/** Optional presentation tweak for a Meshy/CAD GLB that the auto upright/face heuristics miss. */
export interface ModelOrientation {
  /**
   * Tip the mesh so Y is up before fitting.
   * - `auto` (default): tip when Z clearly dominates (lying on its back)
   * - `keep`: leave the source axes alone
   * - `tip`: always rotateX(-90°)
   * - `tip-rev`: always rotateX(+90°) (legs were the other way)
   */
  upright?: 'auto' | 'keep' | 'tip' | 'tip-rev';
  /**
   * Yaw so a broader face looks toward the camera (+Z).
   * - `auto` (default): yaw 90° when depth > width
   * - `keep`: no auto yaw
   */
  face?: 'auto' | 'keep';
  /** Extra yaw in degrees applied after upright/face (positive = CCW looking down Y). */
  yawDeg?: number;
  /** Extra pitch (degrees) about X after upright/face. */
  pitchDeg?: number;
  /** Extra roll (degrees) about Z after upright/face. */
  rollDeg?: number;
  /**
   * Multiplier on the automatic fit (default 1). Above 1 lets a thin outlier the mesh grew (a
   * modelled cable, an antenna) overflow the footprint instead of shrinking the body to make
   * room for it.
   */
  scale?: number;
}

export interface ModelAsset {
  kind: 'glb';
  url: string;
  palette: string[];
  /** Public paths of the reference images the mesh was generated from, front view first. */
  refs?: string[];
  /** Per-item upright / facing overrides when auto heuristics get it wrong. */
  orientation?: ModelOrientation;
  /** Kept so the viewer can fall back if the GLB fails to load. */
  fallback: ProceduralAsset;
}

export type Asset = ProceduralAsset | ModelAsset;

export interface Item {
  id: string;
  url: string;
  domain: string;
  title: string;
  brand?: string;
  price?: string;
  description?: string;
  /** Shelf grouping, e.g. a Moonsift collection section ("Office", "Home"). */
  section?: string;
  /** Public paths to reference images, primary first. */
  images: string[];
  asset: Asset;
  addedAt: string;
}
