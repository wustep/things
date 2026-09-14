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

export interface ModelAsset {
  kind: 'glb';
  url: string;
  palette: string[];
  /** Public paths of the reference images the mesh was generated from, front view first. */
  refs?: string[];
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
