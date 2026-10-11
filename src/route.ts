/**
 * Every thing has its own address: /t/<slug>, e.g. /t/ugmonk-analog-complete-kit. The slug comes
 * from the maker and name, so it reads well when shared; the item id (/t/ugmonk-5117191f) always
 * works too, so a renamed thing's old id links still resolve.
 */
export { slugify, slugsFor } from '../shared/slug.ts';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

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
