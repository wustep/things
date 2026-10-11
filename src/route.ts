/**
 * Every thing has its own address: /t/<slug>, e.g. /t/ugmonk-analog-complete-kit. The slug comes
 * from the maker and name, so it reads well when shared; the item id (/t/ugmonk-5117191f) always
 * works too, so a renamed thing's old id links still resolve.
 */
import type { Item } from '../shared/types.ts';
import { titleWithoutBrand } from '../shared/text.ts';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

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
export function slugsFor(items: Item[]): Map<string, string> {
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

export function itemPath(slug: string): string {
  return `${BASE}/t/${encodeURIComponent(slug)}`;
}

export function homePath(): string {
  return `${BASE}/`;
}

/** The slug (or id) in the current URL, if it points at a thing. */
export function currentKey(): string | null {
  const path = location.pathname.slice(BASE.length);
  const m = path.match(/^\/t\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}
