/** Item ids, shared by the ingest and the software script. */
import { createHash } from 'node:crypto';

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|ref$|ref_|tag$|th$|psc$|pd_rd|pf_rd|sr$|keywords$|qid$|sprefix$|crid$|linkCode$|_encoding$|smid$|dib)/i;

/** Stable id: hostname slug + short hash of the URL without tracking params. */
export function idFor(url: string): string {
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.hash = '';
  const host = u.hostname.replace(/^www\./, '').split('.').slice(0, -1).join('-') || u.hostname;
  // Amazon: collapse to the ASIN so /dp/ASIN and /Long-Title/dp/ASIN agree.
  const asin = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
  const canonical = asin ? `${u.hostname}/dp/${asin.toUpperCase()}` : u.toString();
  const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 8);
  return `${slug(host)}-${hash}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
