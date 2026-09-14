/**
 * Items come straight from data/items.json, which `npm run ingest` writes. Importing it
 * bundles the collection into the build (no fetch, works from any static host) and lets
 * Vite hot-swap the shelf in dev the moment an ingest finishes.
 */
import type { Item } from '../shared/types.ts';
import raw from '../data/items.json';

export const initialItems: Item[] = normalizeItems(raw);

/** Keep only entries that look like items so a hand-edited JSON can't crash the viewer. */
export function normalizeItems(input: unknown): Item[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const entry of input) {
    if (!isItem(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function isItem(x: unknown): x is Item {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.url !== 'string' || typeof r.title !== 'string') return false;
  const asset = r.asset as Record<string, unknown> | undefined;
  if (!asset || typeof asset !== 'object') return false;
  if (asset.kind === 'procedural') return typeof asset.texture === 'string' && typeof asset.aspect === 'number';
  if (asset.kind === 'glb') return typeof asset.url === 'string' && !!asset.fallback;
  return false;
}

/**
 * items.json stores root-relative public paths ("/items/<id>/primary.png"). Resolve them
 * against Vite's base so a build deployed under a sub-path still finds its files.
 */
export function assetUrl(p: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(p) || p.startsWith('data:') || p.startsWith('blob:')) return p;
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return base + (p.startsWith('/') ? p : `/${p}`);
}
