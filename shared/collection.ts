import type { Item } from './types.ts';

export type CollectionChange =
  | { type: 'section'; id: string; section: string }
  | { type: 'move'; id: string; delta: number }
  | { type: 'remove'; id: string }
  | { type: 'restore'; item: Item; index: number };

export function applyChange(items: Item[], change: CollectionChange): Item[] {
  const next = [...items];
  if (change.type === 'restore') {
    if (!isItem(change.item)) throw new Error('This item cannot be restored.');
    if (!next.some(i => i.id === change.item.id)) next.splice(Math.max(0, Math.min(change.index, next.length)), 0, change.item);
    return next;
  }
  const index = next.findIndex(i => i.id === change.id);
  if (index < 0) throw new Error('This item changed elsewhere. Reload the collection and try again.');
  if (change.type === 'remove') next.splice(index, 1);
  else if (change.type === 'section') {
    if (typeof change.section !== 'string' || change.section.trim().length > 60) throw new Error('Use a section name of 60 characters or fewer.');
    next[index] = { ...next[index], section: change.section.trim() || undefined };
  } else if (change.type === 'move') {
    if (change.delta !== -1 && change.delta !== 1) throw new Error('Choose an adjacent position.');
    const peers = next.map((item, i) => ({ item, i })).filter(({ item }) => item.section === next[index].section);
    const peerIndex = peers.findIndex(p => p.i === index);
    const target = peers[peerIndex + change.delta];
    if (target) [next[index], next[target.i]] = [next[target.i], next[index]];
  } else throw new Error('Unknown collection action.');
  return next;
}

function safeHttp(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}
function safeAsset(value: unknown): value is string {
  return typeof value === 'string' && (/^\/items\/[a-z0-9-]+\/[a-z0-9.-]+$/i.test(value) || safeHttp(value));
}
function procedural(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  return a.kind === 'procedural' && ['card', 'box', 'cylinder'].includes(String(a.shape)) && safeAsset(a.texture)
    && typeof a.aspect === 'number' && Number.isFinite(a.aspect) && a.aspect > 0
    && Array.isArray(a.palette) && a.palette.every(c => typeof c === 'string' && /^#[a-f\d]{6}$/i.test(c));
}
export function isItem(value: unknown): value is Item {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^[a-z0-9-]+$/i.test(r.id) || !safeHttp(r.url) || typeof r.title !== 'string' || typeof r.domain !== 'string' || typeof r.addedAt !== 'string') return false;
  if (!Array.isArray(r.images) || !r.images.every(safeAsset)) return false;
  for (const key of ['section', 'brand', 'price', 'description']) if (r[key] !== undefined && typeof r[key] !== 'string') return false;
  const a = r.asset as Record<string, unknown> | undefined;
  return procedural(a) || !!a && a.kind === 'glb' && safeAsset(a.url) && procedural(a.fallback);
}
export function normalizeItems(input: unknown): Item[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.filter((entry): entry is Item => {
    if (!isItem(entry) || seen.has(entry.id)) return false;
    seen.add(entry.id); return true;
  });
}

export interface LocalArrangement { order: string[]; hidden: string[]; sections: Record<string, string>; }
/** Browser edits overlay the published collection, so newly published items still arrive. */
export function arrange(source: Item[], local: LocalArrangement): Item[] {
  const ranks = new Map(local.order.map((id, index) => [id, index]));
  return source.filter(item => !local.hidden.includes(item.id)).map(item => Object.hasOwn(local.sections, item.id) ? { ...item, section: local.sections[item.id] || undefined } : item)
    .sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
}
export function arrangement(source: Item[], current: Item[]): LocalArrangement {
  return { order: current.map(i => i.id), hidden: source.filter(i => !current.some(n => n.id === i.id)).map(i => i.id), sections: Object.fromEntries(current.filter(i => i.section !== source.find(n => n.id === i.id)?.section).map(i => [i.id, i.section || ''])) };
}
