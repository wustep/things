import './fonts.ts';
import './style.css';
import type { Item } from '../shared/types.ts';
import { initialItems, normalizeItems } from './data.ts';
import { announce, Detail } from './detail.ts';
import { extractUrls, ingestAvailable, ingestUrls } from './ingest-client.ts';
import { setMedia } from './media.ts';
import { groupItems, isSoftware } from './sections.ts';
import { currentKey, homePath, itemPath, resolveKey, slugsFor } from './route.ts';
import { Shelf } from './shelf.ts';
import { decoded, standIn } from './glide.ts';

let items: Item[] = initialItems;
let slugs = slugsFor(items);
/** Things in the order the shelf shows them (case by case), which is the order ← and → walk. */
let walk: Item[] = shelfOrder(items);
/** Set when the detail view was opened from the shelf, so closing can just go back in history. */
let openedFromShelf = false;

const shelfEl = document.getElementById('shelf') as HTMLElement;
const detailEl = document.getElementById('detail') as HTMLElement;
const countEl = document.getElementById('count') as HTMLElement;
const creditEl = document.getElementById('credit') as HTMLElement;
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
  creditEl.inert = true;
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
      creditEl.inert = false;
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
 *
 * On a slow network the big picture may not be here when the new frame is taken: the shelf's own
 * picture then stands in for it on the stage (standIn), so the glide is the same every time, and
 * the sharp one replaces it once decoded. Closing first makes sure the shelf picture it lands on
 * has loaded (it may never have, lazy and off screen), so nothing blinks on arrival.
 */
let closeQueued = false;
function transition(dir: 'open' | 'close', update: () => void, shelfImg: HTMLImageElement | null) {
  const doc = document as Document & { startViewTransition?: (cb: () => Promise<void>) => ViewTransitionLike };
  if (!doc.startViewTransition || reduceMotion.matches || !shelfImg) {
    update();
    return;
  }
  // Esc while the picture is still flying in: starting the close now would cut the open short and
  // lose the picture it flies back from, so the view would just blink shut. The open is hurried to
  // its landing instead, and the picture glides back from there.
  if (dir === 'close' && flight?.dir === 'open') {
    if (closeQueued) return;
    closeQueued = true;
    hurry();
    void flight.done.then(() => {
      closeQueued = false;
      if (detail.isOpen) transition(dir, update, shelfImg);
    });
    return;
  }
  if (dir === 'close') {
    if (closeQueued) return;
    // What flies back is the thing's own picture, as it sits on the shelf: not a shop photo picked
    // from the strip, nor a closer look.
    const swapped = detail.homeFrame();
    const stage = detail.stageImage();
    if (swapped || !(shelfImg.complete && shelfImg.naturalWidth)) {
      closeQueued = true;
      shelfImg.loading = 'eager';
      // A short wait, with the view still open; past it, it closes anyway.
      void Promise.all([decoded(shelfImg, 200), stage && swapped ? decoded(stage, 200) : true]).then(() => {
        closeQueued = false;
        if (detail.isOpen) glide(doc, dir, update, shelfImg);
      });
      return;
    }
  }
  glide(doc, dir, update, shelfImg);
}

function glide(
  doc: Document & { startViewTransition?: (cb: () => Promise<void>) => ViewTransitionLike },
  dir: 'open' | 'close',
  update: () => void,
  shelfImg: HTMLImageElement,
) {
  if (!doc.startViewTransition) return update();
  const html = document.documentElement;
  const run = ++transitions;
  const from = dir === 'open' ? shelfImg : detail.stageImage();
  // One picture carries the name at a time: a name left behind by a glide that was cut short
  // would leave two, and the browser skips a transition with a name twice over.
  unname();
  if (from) name(from);
  html.classList.remove(...MOTION_CLASSES);
  html.classList.add(dir === 'open' ? 'is-opening' : 'is-closing');
  opening = dir === 'open';
  let to: HTMLImageElement | null = null;
  let stand: HTMLElement | null = null;
  const t = doc.startViewTransition(async () => {
    if (from) from.style.viewTransitionName = '';
    // Only now, with the old frame captured as it was (a tapped thing half-lifted, say).
    html.classList.add('is-morphing');
    update();
    opening = false;
    to = dir === 'open' ? detail.stageImage() : shelfImg;
    if (!to) return;
    name(to);
    if (dir === 'open') to.dataset.arrived = '';
    // The new frame is captured once this resolves, so the picture it lands on is decoded first
    // (usually at once: hovering or touching a thing started loading it). The page holds still
    // meanwhile, so the wait is short; past it, the shelf picture stands in for the big one.
    if (dir === 'close') to.loading = 'eager';
    if (!(await decoded(to, 150)) && dir === 'open') stand = standIn(to, shelfImg);
  });
  t.ready.catch(() => {}); // skipped by the next one: nothing to do
  const done = t.finished.then(() => {}, () => {});
  flight = { dir, run, done };
  void t.updateCallbackDone.then(() => {
    if (!escWhileOpening) return;
    escWhileOpening = false;
    closeDetail();
  });
  void done.then(() => {
    // A glide cut short by the next transition leaves the names and classes to that one: clearing
    // them now would take the name off the picture the next one is about to fly.
    if (flight?.run === run) flight = null;
    if (run !== transitions) return;
    if (to) to.style.viewTransitionName = '';
    if (stand) stand.style.viewTransitionName = '';
    html.classList.remove(...MOTION_CLASSES);
  });
}

/** The glide in the air, if any: which way it's going, and when it lands. */
let flight: { dir: 'open' | 'close'; run: number; done: Promise<void> } | null = null;

/** Brings a glide in the air to its landing quickly (Esc while it flies in). */
function hurry() {
  for (const a of document.getAnimations()) {
    if ((a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition')) a.updatePlaybackRate(4);
  }
}

const NAME = 'thing-hero';
/** Whatever carries the glide's name right now (the picture, or the stand-in drawn for it). */
function name(node: HTMLElement) {
  node.style.viewTransitionName = NAME;
}
function unname() {
  document.querySelectorAll<HTMLElement>('.thing-pic img, .stage-pic img, .stage-pic .stand-in').forEach((n) => {
    if (n.style.viewTransitionName === NAME) n.style.viewTransitionName = '';
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
const MOTION_CLASSES = ['is-morphing', 'is-opening', 'is-closing', 'is-stepping'];

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


function show(next: Item[]) {
  items = next;
  slugs = slugsFor(items);
  walk = shelfOrder(items);
  // Things you can hold; the apps have their own count on the Software case.
  const things = items.filter((it) => !isSoftware(it)).length;
  countEl.textContent = things ? String(things) : '';
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
