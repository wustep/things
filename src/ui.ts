/**
 * The little chrome there is: wordmark count, section labels, empty state, the hover caption,
 * the detail panel for a focused item (photos, facts, previous / next), status line, drop overlay.
 */
import { sameText, titleWithoutBrand } from '../shared/text.ts';
import type { Item } from '../shared/types.ts';
import { assetUrl } from './data.ts';
import { extractUrls, ingestAvailable, ingestUrls } from './ingest-client.ts';
import type { ItemNode } from './items.ts';
import type { SectionGroup } from './sections.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** How long the caption stays after the pointer leaves an item, so it can be reached and clicked. */
const CARD_LINGER_MS = 800;

export class Hud {
  private readonly count = $('count');
  private readonly sections = $('sections');
  private readonly empty = $('empty');
  private readonly emptyHint = $('empty-hint');
  private readonly card = $<HTMLButtonElement>('card');
  private readonly cardThumb = $<HTMLImageElement>('card-thumb');
  private readonly cardBrand = $('card-brand');
  private readonly cardTitle = $('card-title');
  private readonly cardPrice = $('card-price');
  private readonly cardDomain = $('card-domain');
  private readonly detail = $('detail');
  private readonly photo = $<HTMLImageElement>('detail-photo');
  private readonly thumbs = $('detail-thumbs');
  private readonly detailSection = $('detail-section');
  private readonly detailIndex = $('detail-index');
  private readonly detailBrand = $('detail-brand');
  private readonly detailTitle = $('detail-title');
  private readonly detailPrice = $('detail-price');
  private readonly detailDomain = $('detail-domain');
  private readonly detailDesc = $('detail-desc');
  private readonly detailOpen = $<HTMLAnchorElement>('detail-open');
  private readonly prevTitle = $('detail-prev-title');
  private readonly nextTitle = $('detail-next-title');
  private readonly status = $('status');
  private readonly drop = $('drop');
  private statusTimer: number | undefined;
  private cardTimer: number | undefined;
  private captioned: Item | null = null;
  private shown: Item | null = null;
  private photos: string[] = [];
  private photoAt = 0;
  private inset = { right: 0, bottom: 0 };

  /** Called with a section label when one is clicked in the chrome. */
  onSectionPick: ((label: string) => void) | undefined;
  /** The hover caption was clicked: inspect that item. */
  onCaptionPick: ((item: Item) => void) | undefined;
  /** Previous (-1) / next (+1) from the detail panel. */
  onStep: ((step: 1 | -1) => void) | undefined;
  /** The detail panel's close button. */
  onClose: (() => void) | undefined;

  constructor() {
    // Crossing from an item to the caption takes a moment; hold it while the pointer is on it.
    this.card.addEventListener('pointerenter', () => window.clearTimeout(this.cardTimer));
    this.card.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch') this.scheduleCardHide();
    });
    this.card.addEventListener('click', () => {
      if (this.captioned) this.onCaptionPick?.(this.captioned);
    });
    this.sections.addEventListener('click', (e) => {
      const label = (e.target as HTMLElement).closest<HTMLElement>('[data-section]')?.dataset.section;
      if (label) this.onSectionPick?.(label);
    });
    $('detail-prev').addEventListener('click', () => this.onStep?.(-1));
    $('detail-next').addEventListener('click', () => this.onStep?.(1));
    $('detail-close').addEventListener('click', () => this.onClose?.());
    $('detail-photo-prev').addEventListener('click', () => this.showPhoto(this.photoAt - 1));
    $('detail-photo-next').addEventListener('click', () => this.showPhoto(this.photoAt + 1));
    this.photo.addEventListener('click', () => this.showPhoto(this.photoAt + 1));
    this.thumbs.addEventListener('click', (e) => {
      const at = (e.target as HTMLElement).closest<HTMLElement>('[data-photo]')?.dataset.photo;
      if (at !== undefined) this.showPhoto(Number(at));
    });
    window.addEventListener('resize', () => this.measure());
  }

  /** Show the detail panel for a focused item, with its neighbours in shelf order for the step buttons. */
  showDetail(item: Item, index: number, total: number, prev: Item | undefined, next: Item | undefined) {
    const changed = this.shown?.id !== item.id;
    this.shown = item;
    this.hideCaption();
    const { title, brand, price, domain, url, description, section } = item;
    const shownTitle = titleWithoutBrand(title, brand);
    const showBrand = !!brand && !sameText(brand, shownTitle);
    this.detailSection.textContent = section ?? '';
    this.detailIndex.textContent = total > 1 ? `${index + 1} / ${total}` : '';
    this.detailBrand.textContent = showBrand ? brand : '';
    this.detailBrand.hidden = !showBrand;
    this.detailTitle.textContent = shownTitle;
    this.detailPrice.textContent = price ?? '';
    this.detailPrice.hidden = !price;
    this.detailDomain.textContent = domain;
    this.detailDesc.textContent = description ?? '';
    this.detailDesc.hidden = !description;
    this.detailOpen.href = url;
    this.prevTitle.textContent = prev ? titleWithoutBrand(prev.title, prev.brand) : '';
    this.nextTitle.textContent = next ? titleWithoutBrand(next.title, next.brand) : '';
    $('detail-prev').hidden = !prev;
    $('detail-next').hidden = !next;

    if (changed) {
      // Reference photos, primary first; the keyed cut-out stands in when there are none.
      this.photos = item.images.length ? item.images : [textureOf(item)];
      this.thumbs.replaceChildren(
        ...this.photos.map((src, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'detail-thumb';
          b.dataset.photo = String(i);
          b.setAttribute('role', 'tab');
          b.setAttribute('aria-label', `Photo ${i + 1} of ${this.photos.length}`);
          const img = document.createElement('img');
          img.src = assetUrl(src);
          img.alt = '';
          img.decoding = 'async';
          img.loading = 'lazy';
          b.append(img);
          return b;
        }),
      );
      this.thumbs.hidden = this.photos.length < 2;
      this.showPhoto(0);
      this.detail.scrollTop = 0;
    }
    this.detail.classList.add('is-visible');
    this.detail.setAttribute('aria-hidden', 'false');
    this.measure();
  }

  hideDetail() {
    if (!this.shown) return;
    this.shown = null;
    this.detail.classList.remove('is-visible');
    this.detail.setAttribute('aria-hidden', 'true');
    this.measure();
  }

  /** Share of the viewport the detail panel covers on the right and at the bottom (0 while hidden). */
  insets(): { right: number; bottom: number } {
    return this.inset;
  }

  private measure() {
    if (!this.shown) {
      this.inset = { right: 0, bottom: 0 };
      return;
    }
    const r = this.detail.getBoundingClientRect();
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Docked right (desktop) or a bottom sheet (narrow screens): whichever edge it hugs.
    const docked = r.height >= h * 0.8 || r.width < w * 0.6;
    this.inset = docked ? { right: Math.max(0, (w - r.left) / w), bottom: 0 } : { right: 0, bottom: Math.max(0, (h - r.top) / h) };
  }

  private showPhoto(at: number) {
    const n = this.photos.length;
    if (n === 0) return;
    this.photoAt = ((at % n) + n) % n;
    const src = assetUrl(this.photos[this.photoAt]);
    if (this.photo.getAttribute('src') !== src) this.photo.src = src;
    for (const el of this.thumbs.children) {
      const on = (el as HTMLElement).dataset.photo === String(this.photoAt);
      el.classList.toggle('is-current', on);
      el.setAttribute('aria-selected', String(on));
    }
    this.thumbs.children[this.photoAt]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('detail-photo-prev').hidden = $('detail-photo-next').hidden = n < 2;
  }

  setCount(n: number) {
    this.count.textContent = n > 0 ? String(n) : '';
    this.empty.classList.toggle('is-visible', n === 0);
  }

  /** Section labels with live counts; hidden when nothing on the shelf has a section. */
  setSections(groups: SectionGroup[]) {
    const named = groups.filter((g): g is SectionGroup & { label: string } => !!g.label);
    this.sections.replaceChildren(
      ...named.map((g) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'section';
        button.dataset.section = g.label;
        button.append(g.label, ' ');
        const n = document.createElement('span');
        n.className = 'section-count';
        n.textContent = String(g.items.length);
        button.append(n);
        return button;
      }),
    );
    this.sections.hidden = named.length === 0;
  }

  /** Brighten the label of the section the pointer is on. */
  setHotSection(label: string | null) {
    for (const el of this.sections.children) el.classList.toggle('is-hot', (el as HTMLElement).dataset.section === label);
  }

  /** Mark the section the camera is framing. */
  setActiveSection(label: string | null) {
    for (const el of this.sections.children) el.classList.toggle('is-active', (el as HTMLElement).dataset.section === label);
  }

  /**
   * Show the hover caption for an item, or let it fade once the pointer has had time to reach
   * it. While an item is focused the detail panel says it all, so the caption stays away.
   */
  setCaption(node: ItemNode | null) {
    window.clearTimeout(this.cardTimer);
    if (!node || this.shown) {
      this.scheduleCardHide();
      return;
    }
    this.captioned = node.item;
    const { title, brand, price, domain } = node.item;
    const thumb = assetUrl(textureOf(node.item));
    if (this.cardThumb.getAttribute('src') !== thumb) this.cardThumb.src = thumb;
    // Brand once only: it has its own line, so it comes out of the title. When the brand *is*
    // the whole title (a shop page rather than a product), the title line alone carries it.
    const shownTitle = titleWithoutBrand(title, brand);
    const showBrand = !!brand && !sameText(brand, shownTitle);
    this.cardBrand.textContent = showBrand ? brand : '';
    this.cardBrand.hidden = !showBrand;
    this.cardTitle.textContent = shownTitle;
    this.cardPrice.textContent = price ?? '';
    this.cardPrice.hidden = !price;
    this.cardDomain.textContent = domain;
    this.card.classList.add('is-visible');
    this.card.setAttribute('aria-hidden', 'false');
  }

  private scheduleCardHide() {
    window.clearTimeout(this.cardTimer);
    this.cardTimer = window.setTimeout(() => this.hideCaption(), CARD_LINGER_MS);
  }

  private hideCaption() {
    window.clearTimeout(this.cardTimer);
    this.card.classList.remove('is-visible');
    this.card.setAttribute('aria-hidden', 'true');
  }

  say(text: string, opts: { error?: boolean; sticky?: boolean } = {}) {
    window.clearTimeout(this.statusTimer);
    this.status.textContent = text;
    this.status.classList.toggle('is-error', !!opts.error);
    this.status.classList.add('is-visible');
    if (!opts.sticky) this.statusTimer = window.setTimeout(() => this.status.classList.remove('is-visible'), 5000);
  }

  hush() {
    window.clearTimeout(this.statusTimer);
    this.status.classList.remove('is-visible');
  }

  showDropHint(on: boolean) {
    this.drop.classList.toggle('is-visible', on);
  }

  enablePasteHint(on: boolean) {
    this.emptyHint.hidden = !on;
  }
}

/** The keyed cut-out, which every item has even when a GLB is on top. */
function textureOf(item: Item): string {
  return item.asset.kind === 'glb' ? item.asset.fallback.texture : item.asset.texture;
}

/**
 * Paste or drop product URLs anywhere on the page. With the dev server running they are
 * ingested on the spot; otherwise the user gets the terminal command to run.
 */
export async function setupUrlIntake(hud: Hud) {
  const live = await ingestAvailable();
  hud.enablePasteHint(live);
  let busy = false;

  const submit = async (urls: string[]) => {
    if (urls.length === 0) return;
    if (!live) {
      hud.say(`Add from a terminal:\nnpm run ingest -- ${urls.join(' ')}`, { sticky: true });
      window.setTimeout(() => hud.hush(), 12000);
      return;
    }
    if (busy) {
      hud.say('Still adding the last one…');
      return;
    }
    busy = true;
    hud.say(`Adding ${urls.length === 1 ? hostOf(urls[0]) : `${urls.length} things`}…`, { sticky: true });
    let lastFailed = false;
    let lastMessage = '';
    try {
      const code = await ingestUrls(urls, (line) => {
        const msg = humanize(line);
        if (msg) {
          lastFailed = msg.failed;
          lastMessage = msg.text;
          hud.say(msg.text, { sticky: true, error: msg.failed });
        } else if (lastFailed && /^\s{4,}\S/.test(line)) {
          // The ingest prints the failure reason on the indented line that follows.
          hud.say(`${lastMessage}: ${line.trim()}`, { sticky: true, error: true });
        }
      });
      if (code !== 0 && !lastFailed) hud.say('Ingest stopped early; see the dev server log.', { error: true });
      else hud.say(lastMessage || 'Done');
    } catch (err) {
      hud.say(`Couldn't reach the ingest endpoint: ${(err as Error).message}`, { error: true });
    } finally {
      busy = false;
    }
  };

  document.addEventListener('paste', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(input|textarea)$/i.test(target.tagName))) return;
    const urls = extractUrls(e.clipboardData?.getData('text'));
    if (urls.length) {
      e.preventDefault();
      void submit(urls);
    }
  });

  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (dragDepth++ === 0) hud.showDropHint(true);
  });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      hud.showDropHint(false);
    }
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    hud.showDropHint(false);
    const dt = e.dataTransfer;
    const text = dt?.getData('text/uri-list') || dt?.getData('text/plain') || dt?.getData('text');
    void submit(extractUrls(text));
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Map the ingest script's log lines to short status messages. */
function humanize(line: string): { text: string; failed: boolean } | null {
  const s = line.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^fetch\s+\S+\s+(\S+)/))) return { text: `Fetching ${hostOf(m[1])}…`, failed: false };
  if ((m = s.match(/^ref (\d+)\/(\d+)/))) return { text: `Pulling reference ${m[1]} of ${m[2]}…`, failed: false };
  if (s.startsWith('primary cut-out')) return { text: 'Cutting out the subject…', failed: false };
  if (s.startsWith('page fetch failed')) return { text: 'Page blocked the fetch; trying its images anyway…', failed: false };
  if (s.startsWith('meshy refs:')) return { text: 'Sending reference photos to Meshy…', failed: false };
  if (s.startsWith('meshy')) return { text: `Meshy ${s.slice(6)}`, failed: false };
  if (s.startsWith('model.glb')) return { text: 'Slimming the model for the web…', failed: false };
  if (s.startsWith('mesh generation failed')) return { text: 'Mesh generation failed; keeping the procedural shape', failed: false };
  if ((m = s.match(/^done\s+\S+\s+(.+?)(?:\s{2,}|$)/))) return { text: `Added ${m[1]}`, failed: false };
  if ((m = s.match(/^skip\s+\S+\s+already ingested: (.+)/))) return { text: `Already on the shelf: ${m[1]}`, failed: false };
  if ((m = s.match(/^fail\s+\S+\s+(\S+)/))) return { text: `Couldn't add ${hostOf(m[1])}`, failed: true };
  return null;
}
