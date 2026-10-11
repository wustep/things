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
    const rest = titleWithoutBrand(it.title, it.brand);
    // A thing named for its maker (the Jamcorder) says the name once.
    const name = it.brand && slugify(rest) === slugify(it.brand) ? it.brand : [it.brand, rest].filter(Boolean).join(' ');
    let slug = slugify(name) || it.id;
    if (taken.has(slug)) slug = `${slug}-${it.id.split('-').pop()}`;
    taken.add(slug);
    out.set(it.id, slug);
  }
  return out;
}

/** The thing a /t/<key> address means: its current slug, its id, or one of its earlier slugs. */
export function resolveKey<T extends Pick<Item, 'id' | 'aliases'>>(items: T[], slugs: Map<string, string>, key: string): T | undefined {
  return (
    items.find((it) => slugs.get(it.id) === key) ??
    items.find((it) => it.id === key) ??
    items.find((it) => it.aliases?.includes(key))
  );
}
