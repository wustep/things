/** Text helpers shared by the ingest (Node) and the viewer (browser). */

/**
 * Product titles often repeat the brand ("Simplehuman 60L Trash Can", "Perch Chair / Blu Dot").
 * When the brand is shown on its own line, drop it from the title so it reads once. Matching is
 * case-insensitive and ignores punctuation and spacing ("BluDot" matches "Blu Dot", "&" matches
 * "and"); it only fires at the very start of the title, or at the end after a separator (slash,
 * dash, pipe, "by"). The title comes back untouched when there is no brand or nothing else would
 * remain.
 */
export function titleWithoutBrand(title: string, brand?: string | null): string {
  const t = title.trim();
  const key = fold(brand ?? '');
  if (!t || !key) return t;

  let out = t;
  const lead = foldedMatchAt(out, key, 'start');
  if (lead !== undefined) out = out.slice(lead).replace(LEADING_SEPARATOR, '');
  const trail = foldedMatchAt(out, key, 'end');
  if (trail !== undefined) {
    const head = out.slice(0, trail);
    const sep = head.match(TRAILING_SEPARATOR);
    if (sep) out = head.slice(0, head.length - sep[0].length);
  }
  out = out.trim();
  return out.length >= 2 ? out : t;
}

/** True when two labels read the same once case, punctuation and spacing are ignored. */
export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = fold(a ?? '');
  return x.length > 0 && x === fold(b ?? '');
}

/** What may follow a leading brand: "Brand: Foo", "Brand - Foo", "Brand | Foo", "Brand's Foo", "Brand® Foo". */
const LEADING_SEPARATOR = /^(?:['’]s)?[\s\-–—:|·•,®™©]*/;
/** What must precede a trailing brand: "Foo / Brand", "Foo — Brand", "Foo - Brand", "Foo | Brand", "Foo by Brand". */
const TRAILING_SEPARATOR = /(?:\s+(?:by|from)\s+|\s*[/—–|·•,]\s*|\s+-\s+)$/i;

/** Lower-case alphanumerics only, with "&" read as "and", so spelling variants compare equal. */
function fold(s: string): string {
  return s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[a-z0-9]/i.test(c);
}

/**
 * If the folded brand sits at the start (or end) of the title on a word boundary, return the
 * index in the original string just past it (or where it begins).
 */
function foldedMatchAt(title: string, key: string, where: 'start' | 'end'): number | undefined {
  const n = title.length;
  let acc = '';
  if (where === 'start') {
    for (let i = 0; i < n; i++) {
      acc += fold(title[i]);
      if (!key.startsWith(acc)) return undefined;
      if (acc.length === key.length) return isWordChar(title[i + 1]) ? undefined : i + 1;
    }
    return undefined;
  }
  for (let i = n - 1; i >= 0; i--) {
    acc = fold(title[i]) + acc;
    if (!key.endsWith(acc)) return undefined;
    if (acc.length === key.length) return isWordChar(title[i - 1]) ? undefined : i;
  }
  return undefined;
}
