const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const BASE_HEADERS: Record<string, string> = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'upgrade-insecure-requests': '1',
  'cache-control': 'no-cache',
};

export async function fetchHtml(url: string, timeoutMs = 20000): Promise<{ html: string; finalUrl: string }> {
  const res = await fetchWithTimeout(url, { headers: BASE_HEADERS, redirect: 'follow' }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();
  return { html, finalUrl: res.url || url };
}

export async function fetchBinary(
  url: string,
  referer?: string,
  timeoutMs = 20000,
): Promise<{ buffer: Buffer; contentType: string }> {
  const headers: Record<string, string> = {
    'user-agent': UA,
    // Deliberately do not advertise webp/avif: content-negotiating CDNs would serve
    // them for .jpg/.png URLs, and the image pipeline (jimp) only decodes jpeg/png/gif/bmp.
    accept: 'image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5',
    'accept-language': 'en-US,en;q=0.9',
  };
  if (referer) headers.referer = referer;
  const res = await fetchWithTimeout(url, { headers, redirect: 'follow' }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const contentType = res.headers.get('content-type') ?? '';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
