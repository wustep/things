/**
 * Items come straight from data/items.json, which `npm run ingest` writes. Importing it
 * bundles the collection into the build (no fetch, works from any static host) and lets
 * Vite hot-swap the shelf in dev the moment an ingest finishes.
 */
import type { Item } from '../shared/types.ts';
import { normalizeItems } from '../shared/collection.ts';
export { normalizeItems } from '../shared/collection.ts';
import raw from '../data/items.json';

export const initialItems: Item[] = normalizeItems(raw);

/**
 * items.json stores root-relative public paths ("/items/<id>/primary.png"). Resolve them
 * against Vite's base so a build deployed under a sub-path still finds its files.
 */
export function assetUrl(p: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(p) || p.startsWith('data:') || p.startsWith('blob:')) return p;
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return base + (p.startsWith('/') ? p : `/${p}`);
}
