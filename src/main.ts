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
    transition('open', () => openItem(item), from.querySelector<HTMLImageElement>('.thing-pic img'));
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
    // A swipe slides the sheets itself; the arrows and the bar's buttons cross-fade to the next one.
    if (detail.sliding) openItem(next);
    else crossfade(() => openItem(next));
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
    'close',
    () => {
      detail.hide();
      shelfEl.inert = false;
      openedFromShelf = false;
      // Back where you were: focus returns to the thing you had open (it must be un-inert first).
      link?.focus({ preventScroll: true });
      link?.scrollIntoView({ block: 'nearest' });
    },
    animate ? link?.querySelector<HTMLImageElement>('.thing-pic img') ?? null : null,
  );
}

window.addEventListener('popstate', () => applyRoute(true));

/**
 * Picking a thing off the shelf: with the View Transitions API, its picture glides from its place
 * on the shelf to the stage, and back to wherever it now stands on close (the shelf may have
 * scrolled, or the open thing changed with the arrows or a swipe). The two pictures are the same
 * image file, so the morph runs between their exact boxes, and only the sharper of the two (the
 * stage's) is drawn on the way: no cross-fade ghost, no small picture blown up. Without the API,
 * or with reduced motion, the view just swaps.
 */
function transition(dir: 'open' | 'close', update: () => void, shelfImg: HTMLImageElement | null) {
  const doc = document as Document & { startViewTransition?: (cb: () => Promise<void>) => ViewTransitionLike };
  if (!doc.startViewTransition || reduceMotion.matches || !shelfImg) {
    update();
    return;
  }
  const html = document.documentElement;
  const NAME = 'thing-hero';
  const run = ++transitions;
  const from = dir === 'open' ? shelfImg : detail.stageImage();
  if (from) from.style.viewTransitionName = NAME;
  html.classList.remove(...MOTION_CLASSES);
  html.classList.add(dir === 'open' ? 'is-opening' : 'is-closing');
  opening = dir === 'open';
  let to: HTMLImageElement | null = null;
  const t = doc.startViewTransition(async () => {
    if (from) from.style.viewTransitionName = '';
    // Only now, with the old frame captured as it was (a tapped thing half-lifted, say).
    html.classList.add('is-morphing');
    update();
    opening = false;
    to = dir === 'open' ? detail.stageImage() : shelfImg;
    if (!to) return;
    to.style.viewTransitionName = NAME;
    if (dir === 'open') to.dataset.arrived = '';
    // The new frame is captured once this resolves, so the picture it lands on is decoded first
    // (usually at once: hovering or touching a thing started loading it). The page holds still
    // meanwhile, so the wait is short; past it, the two pictures cross-fade as before.
    if (dir === 'close') to.loading = 'eager';
    if (!(await decoded(to, 150)) && dir === 'open') {
      html.classList.add('is-unready');
      delete to.dataset.arrived; // it fades in on its own once it's here
    }
  });
  t.ready.catch(() => {}); // skipped by the next one: nothing to do
  void t.updateCallbackDone.then(() => {
    if (!escWhileOpening) return;
    escWhileOpening = false;
    closeDetail();
  });
  void t.finished.finally(() => {
    if (to) to.style.viewTransitionName = '';
    // A transition cut short by the next one (Esc mid-flight) leaves the classes to that one.
    if (run === transitions) html.classList.remove(...MOTION_CLASSES);
  });
}

interface ViewTransitionLike {
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  finished: Promise<void>;
}

/**
 * Between a click and the moment the detail view exists (the old frame is being captured), Esc
 * would find nothing open and the view would open anyway. Esc always closes: it's held until the
 * view is there, then closes it.
 */
let opening = false;
let escWhileOpening = false;
document.addEventListener('keydown', (e) => {
  if (opening && e.key === 'Escape') {
    e.preventDefault();
    escWhileOpening = true;
  }
});

/** Bumped by each transition, so only the latest one tidies up after itself. */
let transitions = 0;
const MOTION_CLASSES = ['is-morphing', 'is-opening', 'is-closing', 'is-unready', 'is-stepping'];

/**
 * Stepping to the next thing with the arrows: the sheet cross-fades, the new picture already
 * decoded, so the stage never goes dark between the two.
 */
function crossfade(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => Promise<void>) => ViewTransitionLike };
  if (!doc.startViewTransition || reduceMotion.matches) {
    update();
    return;
  }
  const html = document.documentElement;
  const run = ++transitions;
  html.classList.remove(...MOTION_CLASSES);
  html.classList.add('is-stepping');
  const t = doc.startViewTransition(async () => {
    update();
    const img = detail.stageImage();
    if (!img) return;
    img.dataset.arrived = '';
    // Not here in time (a slow network): it fades in on its own once it is.
    if (!(await decoded(img, 160))) delete img.dataset.arrived;
  });
  t.ready.catch(() => {});
  void t.finished.finally(() => {
    if (run === transitions) html.classList.remove(...MOTION_CLASSES);
  });
}

/** True once the image is decoded, false if that takes longer than `ms` or fails. */
function decoded(img: HTMLImageElement, ms: number): Promise<boolean> {
  // decode() even when complete: an async-decoded image can be loaded and still not paintable.
  return Promise.race([
    img.decode().then(() => true, () => false),
    new Promise<boolean>((done) => setTimeout(() => done(false), ms)),
  ]);
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
