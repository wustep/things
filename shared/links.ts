/**
 * Shop links without the tracking: ad-click ids, campaign tags, email and social trackers, a shop's
 * own search-position and referral params. What picks the product (Shopify's ?variant=, a colour or
 * size option, Joss & Main's piid) stays, and so does anything else a page or image needs (sizes,
 * formats, crops, cache keys). Amazon links are left exactly as they are: affiliateUrl() owns them.
 */

const AMAZON = /(^|\.)(amazon\.[a-z.]+|amzn\.(to|com)|a\.co)$/i;

/** Query keys that only say how someone arrived, never what they see. */
const TRACKING_KEYS = new Set([
  // ad clicks
  'gclid', 'gclsrc', 'gbraid', 'wbraid', 'dclid', 'gad_source', 'gad_campaignid', 'msclkid', 'fbclid',
  'yclid', 'twclid', 'ttclid', 'li_fat_id', 'epik', 'irclickid', 'irgwc', 'clickid', 'click_id', 's_kwcid', 'ef_id',
  // ad networks' value-track fields and campaign ids
  'device', 'network', 'targetid', 'placement', 'matchtype', 'adgroupid', 'adid', 'ad_id', 'campaignid',
  'campaign_id', 'cmpid', 'ranmid', 'raneaid', 'ransiteid', 'mkevt', 'mkcid',
  // email, social, analytics
  'mc_cid', 'mc_eid', 'igsh', 'igshid', '_ga', '_gl', 'srsltid', 'sxsrf',
  // referrals
  'ref', 'ref_', 'refid', 'ref_src',
  // shop search and listing breadcrumbs (Shopify search, Etsy)
  '_pos', '_psq', '_ss', '_sid', '_v', 'sca', 'frs', 'pro', 'sts', 'plkey', 'logging_key', 'click_key',
  'click_sum', 'organic_search_click', 'content_source',
]);
const TRACKING_PREFIXES = ['utm_', 'ga_', 'hsa_', '_hs', 'mtm_', 'pk_', 'pf_rd', 'pd_rd'];

export function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return TRACKING_KEYS.has(k) || TRACKING_PREFIXES.some((p) => k.startsWith(p));
}

/** The link with its tracking params taken out; anything unparseable, and Amazon, as is. */
export function cleanLink(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (AMAZON.test(u.hostname)) return url;
  const keys = new Set<string>();
  u.searchParams.forEach((_, key) => keys.add(key));
  if (!Array.from(keys).some(isTrackingParam)) return url;
  for (const key of keys) if (isTrackingParam(key)) u.searchParams.delete(key);
  return u.toString();
}
