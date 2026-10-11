/**
 * Every thing's address slug (`/t/<slug>`), from its maker and name. Shared by the viewer (routing)
 * and the build (one page per thing, so a shared link unfurls with its name and picture).
 */
import type { Item } from './types.ts';
import { titleWithoutBrand } from './text.ts';

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72)
    .replace(/-$/, '');
}

/** id → slug, unique across the shelf (a clash keeps the id's hash on the second one). */
export function slugsFor(items: Pick<Item, 'id' | 'title' | 'brand'>[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const it of items) {
    const name = [it.brand, titleWithoutBrand(it.title, it.brand)].filter(Boolean).join(' ');
    let slug = slugify(name) || it.id;
    if (taken.has(slug)) slug = `${slug}-${it.id.split('-').pop()}`;
    taken.add(slug);
    out.set(it.id, slug);
  }
  return out;
}
