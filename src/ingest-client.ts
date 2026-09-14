/**
 * Talks to the dev-server ingest endpoint (see scripts/lib/dev-ingest.ts). Only exists while
 * `npm run dev` is serving; a static build has no server, so callers fall back to a hint.
 */
const BASE = import.meta.env.BASE_URL;

export async function ingestAvailable(): Promise<boolean> {
  if (!import.meta.env.DEV) return false;
  try {
    const res = await fetch(`${BASE}__things/ping`, { cache: 'no-store' });
    return res.ok && (await res.text()).trim() === 'things';
  } catch {
    return false;
  }
}

/** Streams ingest output line by line; resolves with the process exit code. */
export async function ingestUrls(urls: string[], onLine: (line: string) => void): Promise<number> {
  const res = await fetch(`${BASE}__things/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  if (!res.ok || !res.body) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let code = 1;
  const handle = (line: string) => {
    const m = line.match(/^exit (\d+)\s*$/);
    if (m) code = Number(m[1]);
    else if (line.trim()) onLine(line);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) handle(buffer);
  return code;
}

export function extractUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  const cleaned = found.map((u) => u.replace(/[)\].,;:!?]+$/, ''));
  return [...new Set(cleaned)].slice(0, 10);
}
