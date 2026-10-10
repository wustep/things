const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const headers = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' };

export async function fetchHtml(url: string, timeoutMs = 20000): Promise<{ html: string; finalUrl: string }> {
  const response = await download(
    url,
    { ...headers, accept: 'text/html,application/json,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    timeoutMs,
    6 * 1024 * 1024,
  );
  return { html: response.buffer.toString('utf8'), finalUrl: response.finalUrl };
}
export async function fetchBinary(
  url: string,
  referer?: string,
  timeoutMs = 20000,
): Promise<{ buffer: Buffer; contentType: string }> {
  return download(
    url,
    { ...headers, accept: 'image/jpeg,image/png,image/webp,image/avif,image/*;q=0.8', ...(referer ? { referer } : {}) },
    timeoutMs,
    24 * 1024 * 1024,
  );
}
/** Timeout covers the complete response body, including CDNs that send headers then stall. */
async function download(url: string, requestHeaders: Record<string, string>, timeoutMs: number, limit: number) {
  if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('Only http(s) URLs are supported');
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: requestHeaders, redirect: 'follow', signal: controller.signal });
      if (!res.ok) {
        await res.body?.cancel();
        if (attempt === 0 && [429, 502, 503, 504].includes(res.status)) {
          const delay = Math.min(2000, Math.max(300, Number(res.headers.get('retry-after') || 1) * 1000));
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`HTTP ${res.status} fetching ${url}`);
      }
      if (Number(res.headers.get('content-length')) > limit) {
        await res.body?.cancel();
        throw new Error('Response is too large');
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('Empty response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error('Response is too large');
        }
        chunks.push(value);
      }
      return {
        buffer: Buffer.concat(chunks),
        contentType: res.headers.get('content-type') || '',
        finalUrl: res.url || url,
      };
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s fetching ${url}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
