/**
 * Saving notes goes through the dev server (scripts/lib/dev-ingest.ts), which writes them into
 * data/items.json. A static build has no server, so notes are read-only there.
 */
import { ingestAvailable } from './ingest-client.ts';

const BASE = import.meta.env.BASE_URL;

export function commentaryWritable(): Promise<boolean> {
  return import.meta.env.DEV ? ingestAvailable() : Promise.resolve(false);
}

/** Resolves with the note as stored (trimmed; empty when cleared). */
export async function saveCommentary(id: string, commentary: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BASE}__things/commentary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, commentary }),
    });
  } catch {
    throw new Error('the dev server isn’t answering (is npm run dev still running?)');
  }
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
  const body = (await res.json()) as { commentary?: string };
  return body.commentary ?? '';
}
