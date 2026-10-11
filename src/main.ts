import './fonts.ts';
import './style.css';
import type { Item } from '../shared/types.ts';
import { initialItems, normalizeItems } from './data.ts';
import { announce, Detail } from './detail.ts';
import { extractUrls, ingestAvailable, ingestUrls } from './ingest-client.ts';
import { setMedia } from './media.ts';
import { groupItems } from './sections.ts';
import { currentKey, homePath, itemPath, resolveKey, slugsFor } from './route.ts';
import { Shelf } from './shelf.ts';

let items: Item[] = initialItems;
let slugs = slugsFor(items);
/** Things in the order the shelf shows them (case by case), which is the order ← and → walk. */
let walk: Item[] = shelfOrder(items);
/** Set when the detail view was opened from the shelf, so closing can just go back in history. */
let openedFromShelf = false;

const shelfEl = document.getElementById('shelf') as HTMLElement;
const detailEl = document.getElementById('detail') as HTMLElement;
const countEl = document.getElementById('count') as HTMLElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const shelf = new Shelf(shelfEl, {
  open(item, from) {
    openedFromShelf = true;
    history.pushState({ thing: item.id }, '', itemPath(slugs.get(item.id) ?? item.id));
    transition(() => openItem(item), from.querySelector('.thing-pic'));
  },
  intent(item) {
    if (!saveData()) detail.prefetchOne(item);
  },
});

const detail = new Detail(detailEl, {
  close: () => closeDetail(),
  step(delta) {
    if (!detail.openId || detail.busy) return;
    const i = walk.findIndex((it) => it.id === detail.openId);
    const next = walk[(i + delta + walk.length) % walk.length];
    // Stepping replaces the entry, so Back still returns to the shelf in one go.
    history.replaceState({ thing: next.id }, '', itemPath(slugs.get(next.id) ?? next.id));
    openItem(next);
  },
});

document.addEventListener('click', (e) => {
  const home = (e.target as HTMLElement).closest('a[data-home]');
  if (home && detail.isOpen && e.button === 0 && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    closeDetail();
  }
});

function openItem(item: Item) {
  const i = walk.indexOf(item);
  detail.show(item, { index: i, total: walk.length });
  shelfEl.inert = true;
  detail.focusStart();
  // Once this thing's own picture has had its turn, warm the ones on either side of it, unless
  // the visitor has asked to save data.
  if (saveData()) return;
  const neighbours = [walk[(i + 1) % walk.length], walk[(i - 1 + walk.length) % walk.length]];
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 300));
  idle(() => {
    if (detail.openId === item.id) detail.prefetch(neighbours.filter((n) => n && n.id !== item.id));
  });
}

function closeDetail() {
  if (!detail.isOpen) return;
  if (detail.busy && !confirm('Discard this note?')) return;
  if (openedFromShelf && history.state?.thing) {
    history.back(); // popstate does the closing
    return;
  }
  history.replaceState(null, '', homePath());
  applyRoute(true);
}

function findByKey(key: string): Item | undefined {
  return resolveKey(items, slugs, key);
}

/** Show whatever the URL says: a thing's detail view, or just the shelf. */
function applyRoute(animate: boolean) {
  const key = currentKey();
  const item = key ? findByKey(key) : undefined;
  if (key && !item) {
    history.replaceState(null, '', homePath());
    announce('That thing isn’t on the shelf anymore.');
  }
  if (item) {
    // An earlier slug (a renamed thing) moves on to the current one, keeping the history entry.
    const slug = slugs.get(item.id);
    if (slug && key !== slug && key !== item.id) history.replaceState(history.state, '', itemPath(slug));
    if (detail.openId !== item.id) openItem(item);
    return;
  }
  if (!detail.isOpen) return;
  const id = detail.openId!;
  const link = shelf.linkFor(id);
  transition(
    () => {
      detail.hide();
      shelfEl.inert = false;
      openedFromShelf = false;
      // Back where you were: focus returns to the thing you had open (it must be un-inert first).
      link?.focus({ preventScroll: true });
      link?.scrollIntoView({ block: 'nearest' });
    },
    null,
    animate ? link?.querySelector<HTMLElement>('.thing-pic') ?? null : null,
  );
}

window.addEventListener('popstate', () => applyRoute(true));

/**
 * Picking a thing off the shelf: with the View Transitions API, its picture glides from the shelf
 * to the stage (and back on close). Without it, or with reduced motion, the view just swaps.
 */
function transition(update: () => void, fromShelf: HTMLElement | null, toShelf: HTMLElement | null = null) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (!doc.startViewTransition || reduceMotion.matches) {
    update();
    return;
  }
  const name = 'thing-hero';
  if (fromShelf) fromShelf.style.viewTransitionName = name;
  else detail.stageImage()?.style.setProperty('view-transition-name', name);
  doc.startViewTransition(() => {
    if (fromShelf) fromShelf.style.viewTransitionName = '';
    update();
    if (fromShelf) detail.stageImage()?.style.setProperty('view-transition-name', name);
    if (toShelf) toShelf.style.viewTransitionName = name;
  });
  // Names must be unique per frame: clear them once the snapshot has been taken.
  setTimeout(() => {
    detail.stageImage()?.style.removeProperty('view-transition-name');
    if (toShelf) toShelf.style.viewTransitionName = '';
  }, 700);
}

function show(next: Item[]) {
  items = next;
  slugs = slugsFor(items);
  walk = shelfOrder(items);
  countEl.textContent = items.length ? String(items.length) : '';
  shelf.set(items, slugs, { eager: !detail.isOpen && !currentKey() });
  const id = detail.openId;
  if (id) {
    const item = items.find((it) => it.id === id);
    if (item) detail.refresh(item, { index: walk.indexOf(item), total: walk.length });
    else closeDetail();
  }
}

show(items);
applyRoute(false);

// ---------- dev: paste or drop a product URL to add it ----------

void (async () => {
  if (!(await ingestAvailable())) return;
  let busy = false;
  const run = async (urls: string[]) => {
    if (busy || urls.length === 0) return;
    busy = true;
    announce(`Adding ${urls.length === 1 ? new URL(urls[0]).hostname.replace(/^www\./, '') : `${urls.length} things`}…`, { sticky: true });
    try {
      const code = await ingestUrls(urls, (line) => {
        const t = line.trim();
        if (/^(fetch|done|fail|building|      title)/.test(t) || t.startsWith('done')) announce(t.replace(/\s+/g, ' ').slice(0, 120), { sticky: true });
      });
      announce(code === 0 ? 'Added to the shelf.' : 'Couldn’t add that page; the dev server log says why.', { error: code !== 0 });
    } catch (err) {
      announce(`Couldn’t add that page: ${(err as Error).message}`, { error: true });
    } finally {
      busy = false;
    }
  };
  document.addEventListener('paste', (e) => {
    if ((e.target as HTMLElement).closest('textarea, input')) return;
    void run(extractUrls(e.clipboardData?.getData('text')));
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    void run(extractUrls(e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text')));
  });
})();

// Dev: ingest, `npm run images` and saved notes rewrite data/*.json; Vite pushes them here.
if (import.meta.hot) {
  import.meta.hot.accept(['../data/items.json', '../data/media.json'], ([itemsMod, mediaMod]) => {
    if (mediaMod) setMedia(mediaMod.default);
    show(itemsMod ? normalizeItems(itemsMod.default) : items);
  });
}

function saveData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !!connection?.saveData || matchMedia('(prefers-reduced-data: reduce)').matches;
}

function shelfOrder(list: Item[]): Item[] {
  return groupItems(list).flatMap((g) => g.items);
}
