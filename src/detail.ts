/**
 * One thing, up close: big images, what it is, where it's from, and Stephen's notes on it.
 * Notes are Markdown in data/items.json (`commentary`). While `npm run dev` is serving they can be
 * written here and are saved back to that file; the built site shows them read-only.
 */
import type { Item } from '../shared/types.ts';
import { titleWithoutBrand } from '../shared/text.ts';
import { renderMarkdown } from './markdown.ts';
import { galleryFor, heroFor, picture, type MediaImage } from './media.ts';
import { el } from './shelf.ts';
import { commentaryWritable, saveCommentary } from './commentary-client.ts';

export interface DetailHandlers {
  close(): void;
  step(delta: 1 | -1): void;
}

type Frame = { kind: 'hero'; img: ReturnType<typeof heroFor> } | { kind: 'photo'; img: MediaImage };

export class Detail {
  private item: Item | null = null;
  private frames: Frame[] = [];
  private frameIndex = 0;
  private editing = false;
  private draft = '';
  private writable = false;
  private position = { index: 0, total: 0 };

  constructor(private readonly root: HTMLElement, private readonly handlers: DetailHandlers) {
    root.addEventListener('keydown', (e) => this.onKey(e));
    void commentaryWritable().then((ok) => {
      this.writable = ok;
      if (this.item && !this.editing) this.renderNotes();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get openId(): string | null {
    return this.isOpen ? this.item?.id ?? null : null;
  }

  /** True while a note is being written: navigation away would lose it. */
  get busy(): boolean {
    return this.editing && this.draft !== (this.item?.commentary ?? '');
  }

  show(item: Item, position: { index: number; total: number }) {
    const same = this.item?.id === item.id;
    this.item = item;
    this.position = position;
    if (!same) {
      this.editing = false;
      this.frameIndex = 0;
    }
    this.frames = [{ kind: 'hero', img: heroFor(item) }, ...galleryFor(item).map((img) => ({ kind: 'photo' as const, img }))];
    this.frameIndex = Math.min(this.frameIndex, this.frames.length - 1);
    this.render();
    if (this.root.hidden) {
      this.root.hidden = false;
      document.documentElement.classList.add('is-detail');
    }
    document.title = `${titleWithoutBrand(item.title, item.brand)} · Things`;
  }

  /** Items on disk changed (HMR). Keep the open note's draft; refresh everything else. */
  refresh(item: Item, position: { index: number; total: number }) {
    if (this.editing) {
      this.item = { ...item };
      this.position = position;
      return;
    }
    this.show(item, position);
  }

  hide() {
    this.root.hidden = true;
    this.root.replaceChildren();
    this.item = null;
    this.editing = false;
    document.documentElement.classList.remove('is-detail');
    document.title = 'Things';
  }

  /** Focus lands on the title, so a screen reader starts with what this is; Tab goes on to the controls. */
  focusStart() {
    this.root.querySelector<HTMLElement>('#detail-title')?.focus({ preventScroll: true });
  }

  /** The element the shelf picture morphs into. */
  stageImage(): HTMLElement | null {
    return this.root.querySelector('.stage-pic');
  }

  // ---------- render ----------

  private render() {
    const item = this.item!;
    const name = titleWithoutBrand(item.title, item.brand);
    const sheet = el('article', 'sheet');

    const bar = el('header', 'sheet-bar');
    const back = button('bar-back', 'Shelf', 'Back to the shelf (Esc)');
    back.dataset.close = '';
    back.prepend(Object.assign(el('span', 'bar-arrow'), { textContent: '←', ariaHidden: 'true' }));
    back.addEventListener('click', () => this.handlers.close());
    const nav = el('nav', 'bar-nav');
    nav.setAttribute('aria-label', 'Other things');
    const prev = button('bar-step', '‹', 'Previous thing (←)');
    const next = button('bar-step', '›', 'Next thing (→)');
    prev.addEventListener('click', () => this.handlers.step(-1));
    next.addEventListener('click', () => this.handlers.step(1));
    const pos = Object.assign(el('span', 'bar-pos'), { textContent: `${this.position.index + 1} of ${this.position.total}` });
    nav.append(prev, pos, next);
    bar.append(back, nav);

    const body = el('div', 'sheet-body');

    // Images
    const visual = el('div', 'visual');
    const stage = el('figure', 'stage');
    stage.append(this.stagePicture());
    visual.append(stage);
    if (this.frames.length > 1) {
      const thumbs = el('div', 'thumbs');
      thumbs.setAttribute('role', 'group');
      thumbs.setAttribute('aria-label', 'Photos');
      for (const [i, f] of this.frames.entries()) {
        const t = button(`thumb is-${f.kind === 'hero' ? (f.img as ReturnType<typeof heroFor>).mode : 'photo'}`, '', i === 0 ? 'The thing on its own' : `Photo ${i} from the shop`);
        t.setAttribute('aria-pressed', String(i === this.frameIndex));
        t.append(picture(f.img, { alt: '', sizes: '72px' }));
        t.addEventListener('click', () => this.showFrame(i));
        thumbs.append(t);
      }
      visual.append(thumbs);
    }

    // Words
    const info = el('div', 'info');
    if (item.section) info.append(Object.assign(el('p', 'info-section'), { textContent: item.section }));
    if (item.brand) info.append(Object.assign(el('p', 'info-maker'), { textContent: item.brand }));
    const h1 = Object.assign(el('h1', 'info-title'), { id: 'detail-title', textContent: name, tabIndex: -1 });
    info.append(h1);

    const facts = el('p', 'info-facts');
    if (item.price) facts.append(Object.assign(el('span', 'info-price'), { textContent: item.price }));
    const shop = el('a', 'info-shop') as HTMLAnchorElement;
    shop.href = item.url;
    shop.target = '_blank';
    shop.rel = 'noopener noreferrer';
    shop.append(`View at ${item.domain}`, Object.assign(el('span', 'info-shop-arrow'), { textContent: '↗', ariaHidden: 'true' }));
    facts.append(shop);
    info.append(facts);

    info.append(el('section', 'notes'));

    if (item.description) {
      const d = el('section', 'from-shop');
      d.setAttribute('aria-labelledby', 'from-shop-label');
      const h = Object.assign(el('h2', 'info-label'), { id: 'from-shop-label', textContent: `What ${item.domain} says` });
      d.append(h, Object.assign(el('p'), { textContent: item.description }));
      info.append(d);
    }

    body.append(visual, info);
    sheet.append(bar, body);
    this.root.replaceChildren(sheet);
    this.renderNotes();
  }

  private stagePicture(): HTMLPictureElement {
    const f = this.frames[this.frameIndex];
    const name = titleWithoutBrand(this.item!.title, this.item!.brand);
    const pic = picture(f.img, {
      alt: f.kind === 'hero' ? name : `${name}, photo ${this.frameIndex} from ${this.item!.domain}`,
      sizes: '(max-width: 760px) 100vw, 58vw',
      eager: true,
    });
    pic.className = `stage-pic is-${f.kind === 'hero' ? (f.img as ReturnType<typeof heroFor>).mode : 'photo'}`;
    if (f.kind === 'hero') pic.style.setProperty('--tone', (f.img as ReturnType<typeof heroFor>).tone);
    const img = pic.querySelector('img')!;
    img.addEventListener('error', () => pic.classList.add('is-missing'), { once: true });
    return pic;
  }

  private showFrame(i: number) {
    if (i === this.frameIndex) return;
    this.frameIndex = i;
    this.root.querySelector('.stage')?.replaceChildren(this.stagePicture());
    this.root.querySelectorAll('.thumb').forEach((t, j) => t.setAttribute('aria-pressed', String(j === i)));
  }

  private renderNotes() {
    const notes = this.root.querySelector<HTMLElement>('.notes');
    if (!notes || !this.item) return;
    const text = this.item.commentary?.trim() ?? '';
    const label = Object.assign(el('h2', 'info-label'), { id: 'notes-label', textContent: 'Notes' });
    // No note: the built site shows no Notes section at all; the dev server offers one quiet way to add one.
    notes.hidden = !text && !this.writable && !this.editing;
    notes.classList.toggle('is-empty', !text && !this.editing);
    if (text || this.editing) notes.setAttribute('aria-labelledby', 'notes-label');
    else notes.removeAttribute('aria-labelledby');

    if (this.editing) {
      notes.replaceChildren(label, this.editor());
      return;
    }
    if (!text) {
      if (this.writable) notes.replaceChildren(this.editButton('notes-add', '+ Add a note'));
      else notes.replaceChildren();
      return;
    }
    const body = el('div', 'notes-body');
    body.innerHTML = renderMarkdown(text);
    const children: Node[] = [label, body];
    if (this.writable) children.push(this.editButton('notes-edit', 'Edit note'));
    notes.replaceChildren(...children);
  }

  private editButton(className: string, text: string): HTMLButtonElement {
    const edit = button(className, text);
    edit.addEventListener('click', () => {
      this.editing = true;
      this.draft = this.item?.commentary ?? '';
      this.renderNotes();
      this.root.querySelector<HTMLTextAreaElement>('.notes-input')?.focus();
    });
    return edit;
  }

  private editor(): HTMLElement {
    const form = el('form', 'notes-form');
    const ta = el('textarea', 'notes-input');
    ta.value = this.draft;
    ta.rows = 9;
    ta.setAttribute('aria-label', 'Note, in Markdown');
    ta.placeholder = 'What’s it like to own? Markdown works: **bold**, _italic_, [links](https://…), lists.';
    ta.addEventListener('input', () => {
      this.draft = ta.value;
      autosize(ta);
    });
    requestAnimationFrame(() => autosize(ta));

    const row = el('div', 'notes-actions');
    const save = Object.assign(button('notes-save', 'Save note'), { type: 'submit' });
    const cancel = button('notes-cancel', 'Cancel');
    const hint = Object.assign(el('span', 'notes-hint'), { textContent: '⌘↵ to save · Esc to cancel' });
    const err = el('p', 'notes-error');
    err.setAttribute('role', 'alert');
    row.append(save, cancel, hint);

    const cancelEdit = () => {
      this.editing = false;
      this.renderNotes();
      this.root.querySelector<HTMLElement>('.notes-edit, .notes-add')?.focus();
    };
    cancel.addEventListener('click', cancelEdit);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        form.requestSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!this.busy || confirm('Discard this note?')) cancelEdit();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const item = this.item;
      if (!item) return;
      save.disabled = true;
      save.textContent = 'Saving…';
      err.textContent = '';
      try {
        const saved = await saveCommentary(item.id, ta.value);
        item.commentary = saved || undefined;
        this.editing = false;
        this.renderNotes();
        this.root.querySelector<HTMLElement>('.notes-edit, .notes-add')?.focus();
        announce('Note saved');
      } catch (error) {
        save.disabled = false;
        save.textContent = 'Save note';
        err.textContent = `Couldn’t save the note: ${(error as Error).message}. Your text is still here.`;
      }
    });
    form.append(ta, row, err);
    return form;
  }

  // ---------- keys ----------

  private onKey(e: KeyboardEvent) {
    const typing = (e.target as HTMLElement).closest('textarea, input');
    if (e.key === 'Escape' && !typing) {
      e.preventDefault();
      this.handlers.close();
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !typing && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.handlers.step(e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'Tab') {
      trapFocus(this.root, e);
    }
  }
}

function button(className: string, text: string, label?: string): HTMLButtonElement {
  const b = el('button', className);
  b.type = 'button';
  b.textContent = text;
  if (label) {
    b.setAttribute('aria-label', label);
    b.title = label;
  }
  return b;
}

function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 2, window.innerHeight * 0.6)}px`;
}

function trapFocus(root: HTMLElement, e: KeyboardEvent) {
  const focusable = [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')].filter(
    (n) => n.offsetParent !== null,
  );
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export function announce(text: string, opts: { error?: boolean; sticky?: boolean } = {}) {
  const s = document.getElementById('status');
  if (!s) return;
  s.textContent = text;
  s.classList.toggle('is-error', !!opts.error);
  s.classList.add('is-on');
  clearTimeout((announce as { t?: number }).t);
  if (!opts.sticky) (announce as { t?: number }).t = window.setTimeout(() => s.classList.remove('is-on'), 3200);
}
