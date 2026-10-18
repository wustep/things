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

/**
 * A shop's own words about a thing, or undefined when what the page offered isn't a description.
 * Many pages put their SEO title in the description meta ("Amazon.com: Logitech MX Master 3S …
 * : Electronics", "Buy … FREE DELIVERY possible on eligible purchases", "Hart Colorways"); those are
 * dropped rather than shown as prose. Store boilerplate around a real description goes ("… Buy
 * now at apple.com."), and text the ingest cut off mid-sentence ends at its last full sentence.
 */
export function shopText(description: string | null | undefined): string | undefined {
  let t = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  if (/^(?:amazon\.com\b|buy\s)/i.test(t) || /(?:\s[-|]\s*amazon\.com|eligible purchases\.?|free returns\.?)$/i.test(t)) return undefined;
  t = t.replace(/(?:\s*(?:buy now(?: at [\w.]+)?|shop now|learn more|\d+% financing available)\.?)+\s*$/i, '').trim();
  t = t.replace(/^shipping estimate\s*[-–:]\s*[\w\s]+?weeks?\s*/i, '').trim();
  if (!/[.!?…"”)]$/.test(t)) {
    const end = Math.max(t.lastIndexOf('. '), t.lastIndexOf('! '), t.lastIndexOf('? '));
    t = end > 80 ? t.slice(0, end + 1) : `${t.replace(/[\s,;:–—-]+$/, '')}…`;
  }
  // A heading or a page title, not prose.
  if (t.length < 60 || !/\s\S+\s\S+\s\S+\s/.test(t)) return undefined;
  return t;
}

/**
 * Prices show in whole dollars: "$89.99" → "$90", "$1529.00" → "$1,529", "$1199" → "$1,199".
 * Rounds to the nearest dollar (half up) and groups thousands with commas. A plan's period stays
 * as written ("$49.99/yr" → "$50/yr", "$20/mo" as is). An app's plans, joined by " · ", round one
 * by one, each keeping its name and any trailing words ("Free · Plus $9.99/mo" → "Free · Plus
 * $10/mo", "$29 one-time"). Anything that isn't a symbol-prefixed amount (a range, words, a
 * missing price) comes back unchanged.
 */
export function wholeDollars(price: string): string;
export function wholeDollars(price: string | null | undefined): string | undefined;
export function wholeDollars(price: string | null | undefined): string | undefined {
  if (price == null) return undefined;
  return plans(price).map(wholePlan).join(PLAN_SEP);
}

const PLAN_SEP = ' · ';

/** An app's plans, as written: "Free · Pro $20/mo" → ["Free", "Pro $20/mo"]. A single price is one plan. */
export function plans(price: string): string[] {
  return price.trim().split(/\s+·\s+/);
}

function wholePlan(plan: string): string {
  const m = plan.match(/^((?:[A-Za-z][\w+.-]*\s+)*)([^\d\s.,/-]*)\s*(\d[\d,]*(?:\.\d+)?)(\s*\/\s*[a-z]+)?((?:\s+[a-z][a-z-]*)*)$/i);
  if (!m) return plan;
  const num = Number(m[3].replace(/,/g, ''));
  if (!Number.isFinite(num)) return plan;
  const whole = Math.round(num + 1e-9);
  return `${m[1]}${m[2]}${whole.toLocaleString('en-US')}${m[4] ?? ''}${m[5]}`;
}
