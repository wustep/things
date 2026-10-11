/**
 * The cabinet: one case per section, each a stack of shelves. Things stand on the shelf at a
 * believable relative size (see media.ts), bottoms on the shelf line, with a small tag on the edge
 * below each one. The packing into shelves depends on the width, so it is recomputed on resize.
 */
import type { Item } from '../shared/types.ts';
import { titleWithoutBrand } from '../shared/text.ts';
import { groupItems } from './sections.ts';
import { heroFor, picture, realSizeCm, REFERENCE_CM, SCALE_EXPONENT } from './media.ts';
import { itemPath } from './route.ts';
import { pack } from './pack.ts';

interface Metrics {
  /** On-screen size of the largest side of a REFERENCE_CM thing. */
  unit: number;
  /** Nothing is drawn smaller than this, however small it really is. */
  minObject: number;
  /** Narrowest slot, so the tag under a small thing still has room. */
  minSlot: number;
  /** Air between neighbours. */
  gap: number;
  /** Room above the tallest thing on a shelf. */
  headroom: number;
}

function metricsFor(width: number): Metrics {
  const phone = width < 560;
  return {
    unit: phone ? Math.max(84, width * 0.25) : Math.min(196, Math.max(130, width * 0.125)),
    minObject: phone ? 54 : 70,
    minSlot: phone ? 104 : 136,
    gap: phone ? 18 : 40,
    headroom: phone ? 22 : 34,
  };
}

export interface Placed {
  item: Item;
  slot: number;
  imgW: number;
  imgH: number;
  objW: number;
  objH: number;
  /** How far the image hangs below the shelf line (its padding under the object, where the shadow is). */
  drop: number;
  /** Horizontal shift so the object, not the padded image, is centred in its slot. */
  shift: number;
}

export function place(item: Item, m: Metrics): Placed {
  const hero = heroFor(item);
  const [sl, st, sw, sh] = hero.subject;
  const subjW = sw * hero.width;
  const subjH = sh * hero.height;
  const target = Math.max(m.minObject, m.unit * Math.pow(realSizeCm(item) / REFERENCE_CM, SCALE_EXPONENT));
  const scale = target / Math.max(subjW, subjH);
  const imgW = hero.width * scale;
  const imgH = hero.height * scale;
  const objW = subjW * scale;
  const objH = subjH * scale;
  return {
    item,
    slot: Math.max(m.minSlot, objW + m.gap),
    imgW,
    imgH,
    objW,
    objH,
    drop: (1 - st - sh) * imgH,
    shift: ((1 - sl - sw) - sl) * imgW / 2,
  };
}

export interface ShelfHandlers {
  open(item: Item, from: HTMLElement): void;
}

export class Shelf {
  private items: Item[] = [];
  private slugs = new Map<string, string>();
  private lastWidth = 0;
  /** The thing last focused or picked, where the arrows pick up when focus is elsewhere. */
  private lastId: string | null = null;
  private readonly observer: ResizeObserver;

  constructor(private readonly root: HTMLElement, private readonly handlers: ShelfHandlers) {
    this.observer = new ResizeObserver(() => {
      const w = this.innerWidth();
      if (Math.abs(w - this.lastWidth) >= 1) this.render();
    });
    this.observer.observe(root);
    root.addEventListener('click', (e) => this.onClick(e));
    // At the document, so the arrows still walk the shelf after a click on its background left
    // focus on <body>; they pick up from the thing last focused.
    document.addEventListener('keydown', (e) => this.onKey(e));
    root.addEventListener('focusin', (e) => {
      const link = (e.target as Element).closest<HTMLAnchorElement>('a.thing-link');
      if (link?.dataset.id) this.lastId = link.dataset.id;
    });
  }

  set(items: Item[], slugs: Map<string, string>) {
    this.items = items;
    this.slugs = slugs;
    this.render();
  }

  /** The link for an item, to hand focus back to after the detail view closes. */
  linkFor(id: string): HTMLAnchorElement | null {
    return this.root.querySelector<HTMLAnchorElement>(`a[data-id="${CSS.escape(id)}"]`);
  }

  private innerWidth(): number {
    const cs = getComputedStyle(this.root);
    return this.root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }

  private render() {
    const width = this.innerWidth();
    this.lastWidth = width;
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.id;
    const m = metricsFor(width);
    const frag = document.createDocumentFragment();
    let eager = 6; // the first shelf's worth loads right away; the rest as they scroll near

    if (this.items.length === 0) {
      frag.append(emptyCase());
    }
    for (const [gi, group] of groupItems(this.items).entries()) {
      const label = group.label ?? 'Everything else';
      const section = el('section', 'case');
      const headingId = `case-${gi}`;
      section.setAttribute('aria-labelledby', headingId);
      const h = el('h2', 'case-label');
      h.id = headingId;
      h.append(label, Object.assign(el('span', 'case-count'), { textContent: String(group.items.length) }));
      section.append(h);

      for (const row of pack(group.items.map((it) => place(it, m)), width)) {
        const stageH = Math.ceil(Math.max(...row.map((p) => p.objH)) + m.headroom);
        const tier = el('div', 'tier');
        tier.style.setProperty('--stage', `${stageH}px`);
        const list = el('ul', 'tier-things');
        list.setAttribute('role', 'list');
        // A shelf that isn't full gives its things a little more air (up to one more gap each), and
        // whatever is left stays as even margins at both ends rather than all on the right.
        const slack = width - row.reduce((sum, p) => sum + p.slot, 0);
        const air = Math.max(0, Math.min(slack / row.length, m.gap));
        for (const p of row) list.append(this.thing(p, stageH, eager-- > 0, air));
        tier.append(list);
        section.append(tier);
      }
      frag.append(section);
    }
    this.root.replaceChildren(frag);
    this.root.setAttribute('aria-busy', 'false');
    if (focusedId) this.linkFor(focusedId)?.focus({ preventScroll: true });
  }

  private thing(p: Placed, stageH: number, eager: boolean, air = 0): HTMLLIElement {
    const { item } = p;
    const hero = heroFor(item);
    const name = titleWithoutBrand(item.title, item.brand);
    const li = el('li', 'thing');
    li.style.width = `${p.slot + air}px`;

    const a = el('a', 'thing-link') as HTMLAnchorElement;
    a.href = itemPath(this.slugs.get(item.id) ?? item.id);
    a.dataset.id = item.id;
    a.setAttribute('aria-label', [item.brand, name].filter(Boolean).join(', '));

    const stage = el('span', 'thing-stage');
    stage.style.height = `${stageH}px`;
    stage.style.setProperty('--tone', hero.tone);
    stage.style.setProperty('--obj-w', `${p.objW}px`);
    const pic = picture(hero, {
      alt: '',
      sizes: `${Math.ceil(p.imgW)}px`,
      eager,
      className: 'thing-img',
    });
    pic.className = `thing-pic is-${hero.mode}`;
    pic.style.width = `${p.imgW}px`;
    pic.style.height = `${p.imgH}px`;
    pic.style.setProperty('--drop', `${p.drop}px`);
    pic.style.setProperty('--shift', `${p.shift}px`);
    watchLoad(pic, stage);
    stage.append(pic);

    const tag = el('span', 'tag');
    if (item.brand) tag.append(Object.assign(el('span', 'tag-maker'), { textContent: item.brand }));
    tag.append(Object.assign(el('span', 'tag-name'), { textContent: name }));

    a.append(stage, tag);
    li.append(a);
    return li;
  }

  private onClick(e: MouseEvent) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.thing-link');
    const item = a && this.items.find((it) => it.id === a.dataset.id);
    if (!a || !item) return;
    e.preventDefault();
    this.lastId = item.id;
    this.handlers.open(item, a);
  }

  /** Arrow keys walk the shelf in reading order; Tab still works as usual. */
  private onKey(e: KeyboardEvent) {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    if (e.defaultPrevented || e.metaKey || e.altKey || e.ctrlKey || this.root.inert || this.root.hidden) return;
    const links = [...this.root.querySelectorAll<HTMLAnchorElement>('a.thing-link')];
    if (!links.length) return;
    let i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) {
      // Nothing on the shelf has focus. Left/Right (which never scroll the page) take it back to
      // where you were; Up/Down/Home/End are left to scroll the page as usual.
      const active = document.activeElement;
      const idle = !active || active === document.body || this.root.contains(active);
      if (!idle || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
      const last = this.lastId ? links.findIndex((l) => l.dataset.id === this.lastId) : -1;
      e.preventDefault();
      if (last < 0) {
        links[0].focus();
        return;
      }
      i = last;
    }
    let next = i;
    if (e.key === 'ArrowRight') next = i + 1;
    else if (e.key === 'ArrowLeft') next = i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = links.length - 1;
    else next = nearestInDirection(links, i, e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= links.length || next === i) {
      if (document.activeElement !== links[i]) links[i].focus();
      return;
    }
    e.preventDefault();
    links[next].focus();
    links[next].scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}

/** The thing on the shelf above/below whose centre is closest horizontally. */
function nearestInDirection(links: HTMLElement[], i: number, dir: 1 | -1): number {
  const here = links[i].getBoundingClientRect();
  const cx = here.left + here.width / 2;
  let best = -1, bestScore = Infinity;
  for (const [j, l] of links.entries()) {
    const r = l.getBoundingClientRect();
    const dy = (r.top - here.top) * dir;
    if (dy < 8) continue;
    const score = dy * 4 + Math.abs(r.left + r.width / 2 - cx);
    if (score < bestScore) {
      bestScore = score;
      best = j;
    }
  }
  return best;
}

/** Fade in when decoded; if the file is missing, the tag still stands on an outline of the space. */
function watchLoad(pic: HTMLPictureElement, stage: HTMLElement) {
  const img = pic.querySelector('img')!;
  const done = () => stage.classList.add('is-loaded');
  if (img.complete && img.naturalWidth) done();
  else {
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', () => stage.classList.add('is-missing'), { once: true });
  }
}

function emptyCase(): HTMLElement {
  const section = el('section', 'case case-empty');
  const tier = el('div', 'tier');
  tier.style.setProperty('--stage', '180px');
  const note = el('div', 'empty');
  note.innerHTML = import.meta.env.DEV
    ? '<p class="empty-title">Nothing on the shelf yet.</p><p class="empty-hint">Paste a product link anywhere on this page to put it here.</p>'
    : '<p class="empty-title">Nothing on the shelf yet.</p><p class="empty-hint">Add things with <code>npm run ingest -- &lt;url&gt;</code>, then <code>npm run images</code>.</p>';
  tier.append(note);
  section.append(tier);
  return section;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
