import type { Item } from '../shared/types.ts';

export interface SectionGroup {
  /** Undefined for the trailing group of items that have no section. */
  label?: string;
  items: Item[];
}

/**
 * Items grouped by section in order of first appearance (the ingest keeps the batch order, so
 * a Moonsift collection's sections come out in Moonsift's order). Items without a section trail
 * as one unlabeled group. Both the shelf layout and the chrome counts come from this, so they
 * always agree.
 */
export function groupItems(items: Item[]): SectionGroup[] {
  const named = new Map<string, Item[]>();
  const loose: Item[] = [];
  for (const item of items) {
    const label = item.section?.trim();
    if (!label) {
      loose.push(item);
      continue;
    }
    let list = named.get(label);
    if (!list) named.set(label, (list = []));
    list.push(item);
  }
  const groups: SectionGroup[] = [...named].map(([label, items]) => ({ label, items }));
  if (loose.length) groups.push({ items: loose });
  return groups;
}
