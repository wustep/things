const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const BASE_HEADERS: Record<string, string> = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'upgrade-insecure-requests': '1',
  'cache-control': 'no-cache',
};

const PLAIN_HEADERS: Record<string, string> = { 'user-agent': UA, accept: '*/*' };

/** Largest product page (or product JSON) we will read. Real pages are well under this. */
export const MAX_PAGE_BYTES = 6 * 1024 * 1024;
/** Largest single image we will download. */
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20000;

export async function fetchHtml(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_PAGE_BYTES,
): Promise<{ html: string; finalUrl: string }> {
  let res;
  try {
    res = await download(url, BASE_HEADERS, timeoutMs, maxBytes);
  } catch (err) {
    // Some bot walls (DWR's, for one) score a full browser header set from a non-browser TLS
    // stack as a bot, yet let a plain request through. One quieter retry before giving up.
    if (!/^HTTP 403\b/.test((err as Error).message)) throw err;
    res = await download(url, PLAIN_HEADERS, timeoutMs, maxBytes);
  }
  return { html: res.buffer.toString('utf8'), finalUrl: res.finalUrl };
}

export async function fetchBinary(
  url: string,
  referer?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<{ buffer: Buffer; contentType: string }> {
  const headers: Record<string, string> = {
    'user-agent': UA,
    // Deliberately do not advertise webp/avif: content-negotiating CDNs would serve
    // them for .jpg/.png URLs, and the image pipeline (jimp) only decodes jpeg/png/gif/bmp.
    accept: 'image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5',
    'accept-language': 'en-US,en;q=0.9',
  };
  if (referer) headers.referer = referer;
  const { buffer, contentType } = await download(url, headers, timeoutMs, maxBytes);
  return { buffer, contentType };
}

/**
 * GET with a size cap and a timeout that covers the whole body, not just the headers: some
 * CDNs answer quickly and then stall mid-body, and some "images" are hundreds of megabytes.
 */
async function download(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error(`only http(s) URLs are supported: ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    const tooLarge = () => new Error(`response larger than ${Math.round(maxBytes / 1024)} KB: ${url}`);
    if (Number(res.headers.get('content-length')) > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(value);
      }
    }
    return {
      buffer: Buffer.concat(chunks),
      contentType: res.headers.get('content-type') ?? '',
      finalUrl: res.url || url,
    };
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`timed out after ${timeoutMs} ms fetching ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
