/** Stephen's Amazon Associates tag, carried by every Amazon link the shelf stores or renders. */
export const AMAZON_TAG = 'wustep09-20';

const AMAZON_HOST = /(^|\.)amazon\.com$/i;
const ASIN = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Z0-9]{10})(?=[/?#]|$)/i;

/** The ASIN of an amazon.com product URL, or undefined for anything else. */
export function amazonAsin(url: string): string | undefined {
  try {
    const u = new URL(url);
    return AMAZON_HOST.test(u.hostname) ? u.pathname.match(ASIN)?.[1]?.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The link to send people to: an amazon.com product becomes https://www.amazon.com/dp/<ASIN>?tag=…
 * (any other tag or tracking dropped); another amazon.com page keeps its path with the tag set.
 * Everything else, short links included (they need a network hop to resolve), is returned as is.
 */
export function affiliateUrl(url: string): string {
  const asin = amazonAsin(url);
  if (asin) return `https://www.amazon.com/dp/${asin}?tag=${AMAZON_TAG}`;
  try {
    const u = new URL(url);
    if (!AMAZON_HOST.test(u.hostname)) return url;
    u.searchParams.set('tag', AMAZON_TAG);
    return u.toString();
  } catch {
    return url;
  }
}
