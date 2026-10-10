import { titleWithoutBrand } from '../shared/text.ts';
import type { Item } from '../shared/types.ts';
import { assetUrl } from './data.ts';
import { extractUrls, ingestAvailable, ingestUrls } from './ingest-client.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const textureOf = (item: Item) => assetUrl(item.asset.kind === 'glb' ? item.asset.fallback.texture : item.asset.texture);
const titleOf = (item: Item) => titleWithoutBrand(item.title, item.brand);
export type Change = { type: 'section'; id: string; section: string } | { type: 'move'; id: string; delta: number } | { type: 'remove'; id: string } | { type: 'restore'; item: Item; index: number };

export class Hud {
  private items: Item[] = [];
  private section: string | null = null;
  private page = 0;
  private view: 'shelf' | 'catalog' = 'shelf';
  private selected: Item | null = null;
  private timer?: number;
  private opener?: HTMLElement;
  private labels = new Map<string, HTMLElement>();
  private failed = false;
  private pageSize = this.getPageSize();
  onSceneChange?: (items: Item[], visible: boolean) => void;
  onReset?: () => void;
  onChange?: (change: Change) => Promise<void>;

  constructor() {
    $('sections').addEventListener('click', e => {
      const target = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-section]');
      if (!target) return;
      this.section = target.dataset.section || null;
      this.page = 0;
      this.refresh();
    });
    $('shelf-view').onclick = () => this.setView('shelf');
    $('catalog-view').onclick = () => this.setView('catalog');
    $('reset-camera').onclick = () => this.onReset?.();
    $('previous-page').onclick = () => { this.page--; this.refresh(); };
    $('next-page').onclick = () => { this.page++; this.refresh(); };
    $('search').oninput = () => this.renderCatalog();
    $('dismiss-status').onclick = () => { $('status').hidden = true; };
    window.addEventListener('resize', () => {
      const next = this.getPageSize();
      if (next !== this.pageSize) { this.pageSize = next; this.page = 0; this.refresh(); }
    });
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog')) {
      dialog.querySelector<HTMLButtonElement>('[data-close]')!.onclick = () => dialog.close();
      dialog.addEventListener('click', e => {
        if (e.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
      });
      dialog.addEventListener('close', () => { this.opener?.focus(); });
    }
    $('save-section').onclick = () => void this.changeSection();
    $('detail-section').onkeydown = e => { if (e.key === 'Enter') void this.changeSection(); };
    $('move-earlier').onclick = () => void this.move(-1);
    $('move-later').onclick = () => void this.move(1);
    $('remove-item').onclick = async () => {
      if (!this.selected) return;
      const item = this.selected;
      const index = this.items.findIndex(i => i.id === item.id);
      if (await this.change({ type: 'remove', id: item.id })) {
        $<HTMLDialogElement>('detail').close();
        this.say(`Removed ${titleOf(item)}`, { undo: async () => {
          if (await this.change({ type: 'restore', item, index })) this.say('Back on your shelf.');
        }});
      }
    };
  }

  private getPageSize() { return window.innerWidth <= 600 ? 4 : 8; }
  setItems(items: Item[]) {
    this.items = items;
    if (this.section && !items.some(i => (i.section || 'Unsorted') === this.section)) this.section = null;
    if (this.selected) {
      this.selected = items.find(i => i.id === this.selected?.id) ?? null;
      if (this.selected && $<HTMLDialogElement>('detail').open) this.fillDetails(this.selected);
    }
    this.refresh();
  }

  private filtered() { return this.section ? this.items.filter(i => (i.section || 'Unsorted') === this.section) : this.items; }
  private refresh() {
    const groups = new Map<string, number>();
    for (const item of this.items) groups.set(item.section || 'Unsorted', (groups.get(item.section || 'Unsorted') ?? 0) + 1);
    const focusedSection = (document.activeElement as HTMLElement | null)?.dataset.section;
    $('sections').replaceChildren(...[['', this.items.length] as const, ...groups].map(([label, n]) => {
      const b = document.createElement('button'); b.className = 'section'; b.dataset.section = label;
      b.setAttribute('aria-current', String((this.section ?? '') === label));
      const count = document.createElement('span'); count.className = 'section-count'; count.textContent = String(n);
      b.append(label || 'All things', count); return b;
    }));
    if (focusedSection !== undefined) ($('sections').querySelector(`[data-section="${CSS.escape(focusedSection)}"]`) as HTMLElement | null)?.focus();
    $('section-options').replaceChildren(...[...groups.keys()].filter(x => x !== 'Unsorted').map(label => { const o = document.createElement('option'); o.value = label; return o; }));
    const filtered = this.filtered();
    const pages = Math.max(1, Math.ceil(filtered.length / this.pageSize));
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    const visible = filtered.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize);
    $('scene-label').textContent = this.section || 'All things';
    $('scene-count').textContent = filtered.length ? `${String(this.page * this.pageSize + 1).padStart(2, '0')} — ${String(this.page * this.pageSize + visible.length).padStart(2, '0')}` : '';
    $('collection-total').textContent = `${filtered.length} ${filtered.length === 1 ? 'thing' : 'things'}${this.section ? ` in ${this.section}` : ' in your collection'}`;
    $('page-number').textContent = `${this.page + 1} / ${pages}`;
    $<HTMLButtonElement>('previous-page').disabled = this.page === 0;
    $<HTMLButtonElement>('next-page').disabled = this.page >= pages - 1;
    $('pagination').hidden = this.view !== 'shelf' || filtered.length === 0;
    $('empty').hidden = this.items.length > 0;
    $('reset-camera').hidden = !this.items.length;
    $('shelf-instructions').hidden = !this.items.length;
    $('hover-card').hidden = true;
    this.labels.clear();
    $('object-labels').replaceChildren(...visible.map((item, index) => {
      const button = document.createElement('button'); button.className = 'object-label'; button.style.visibility = 'hidden';
      button.setAttribute('aria-label', `Inspect ${titleOf(item)}`);
      const n = document.createElement('small'); n.textContent = String(this.page * this.pageSize + index + 1).padStart(2, '0');
      button.append(n, titleOf(item)); button.onclick = () => this.inspect(item);
      this.labels.set(item.id, button); return button;
    }));
    this.renderCatalog();
    this.onSceneChange?.(visible, this.view === 'shelf');
  }

  positionLabels(points: { id: string; x: number; y: number; visible: boolean }[]) {
    for (const point of points) {
      const el = this.labels.get(point.id); if (!el) continue;
      el.style.left = `${point.x}px`; el.style.top = `${point.y}px`;
      el.style.visibility = point.visible ? 'visible' : 'hidden';
    }
  }

  setView(view: 'shelf' | 'catalog') {
    this.view = this.failed ? 'catalog' : view;
    $('shelf-area').hidden = this.view !== 'shelf'; $('catalog').hidden = this.view !== 'catalog';
    $('shelf-view').setAttribute('aria-pressed', String(this.view === 'shelf'));
    $('catalog-view').setAttribute('aria-pressed', String(this.view === 'catalog'));
    this.refresh();
  }

  private renderCatalog() {
    const query = $<HTMLInputElement>('search').value.trim().toLowerCase();
    const items = this.filtered().filter(item => `${item.title} ${item.brand ?? ''} ${item.section ?? ''}`.toLowerCase().includes(query));
    $('search-empty').hidden = items.length > 0 || this.items.length === 0;
    $('catalog-grid').replaceChildren(...items.map(item => {
      const button = document.createElement('button'); button.className = 'product-tile'; button.setAttribute('aria-label', `Inspect ${titleOf(item)}`);
      const picture = document.createElement('span'); picture.className = 'tile-image';
      const img = document.createElement('img'); img.src = textureOf(item); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      img.onerror = () => { img.hidden = true; picture.dataset.failed = 'true'; };
      const section = document.createElement('span'); section.className = 'tile-section'; section.textContent = item.section || 'Unsorted';
      picture.append(img, section); button.append(picture);
      for (const [name, value] of [['brand', item.brand || item.domain], ['title', titleOf(item)], ['price', item.price || 'View details']]) {
        const span = document.createElement('span'); span.className = `tile-${name}`; span.textContent = value; button.append(span);
      }
      button.onclick = () => this.inspect(item); return button;
    }));
  }

  hover(item: Item | null) {
    $('hover-card').hidden = !item;
    if (!item) return;
    $('hover-brand').textContent = item.brand || item.domain;
    $('hover-title').textContent = titleOf(item);
    $('hover-price').textContent = item.price || '';
  }

  inspect(item: Item) {
    this.selected = item; this.opener = document.activeElement as HTMLElement;
    this.fillDetails(item);
    $<HTMLDialogElement>('detail').showModal();
  }

  private fillDetails(item: Item) {
    const img = $<HTMLImageElement>('detail-image'); img.hidden = false; img.src = textureOf(item); img.alt = titleOf(item);
    img.onerror = () => { img.hidden = true; };
    $('detail-number').textContent = `${item.section || 'Unsorted'} / ${String(this.items.indexOf(item) + 1).padStart(2, '0')}`;
    $('detail-brand').textContent = item.brand || item.domain;
    $('detail-title').textContent = titleOf(item);
    $('detail-price').textContent = item.price || '';
    $('detail-price').hidden = !item.price;
    $('detail-description').textContent = item.description || 'An object worth coming back to. Visit the shop for current details and availability.';
    $('detail-domain').textContent = `${item.domain} · Opens in a new tab`;
    $<HTMLAnchorElement>('detail-link').href = item.url;
    $<HTMLInputElement>('detail-section').value = item.section || '';
    const peers = this.items.filter(i => i.section === item.section);
    $<HTMLButtonElement>('move-earlier').disabled = peers[0]?.id === item.id;
    $<HTMLButtonElement>('move-later').disabled = peers.at(-1)?.id === item.id;
  }

  private async changeSection() {
    if (!this.selected) return;
    const section = $<HTMLInputElement>('detail-section').value.trim();
    if (await this.change({ type: 'section', id: this.selected.id, section })) this.say(`Moved to ${section || 'Unsorted'}.`);
  }
  private async move(delta: number) {
    if (!this.selected) return;
    if (await this.change({ type: 'move', id: this.selected.id, delta })) this.say(delta < 0 ? 'Moved earlier in this section.' : 'Moved later in this section.');
  }
  private async change(change: Change) {
    try { await this.onChange?.(change); return true; }
    catch (err) { this.say((err as Error).message, { error: true }); return false; }
  }

  loading(loaded: number, total: number, failed = 0) {
    $('scene-loading').hidden = loaded >= total || total === 0;
    $('scene-loading').textContent = `Arranging your shelf · ${loaded} / ${total}`;
    if (loaded >= total && failed) this.say(`${failed} ${failed === 1 ? 'object could' : 'objects could'} not load. Open Catalog to see their details.`, { error: true });
  }
  noWebGL() { this.failed = true; this.setView('catalog'); $<HTMLButtonElement>('shelf-view').disabled = true; this.say('3D is unavailable in this browser. Your collection is ready in Catalog.', { error: true }); }
  say(text: string, opts: { error?: boolean; undo?: () => void | Promise<void> } = {}) {
    clearTimeout(this.timer); $('status-text').textContent = text; $('status').hidden = false; $('status').classList.toggle('is-error', !!opts.error);
    $('undo-button').hidden = !opts.undo;
    $('undo-button').onclick = () => { $('status').hidden = true; void opts.undo?.(); };
    if (!opts.undo && !opts.error) this.timer = window.setTimeout(() => { $('status').hidden = true; }, 5500);
  }
}

export async function setupUrlIntake(hud: Hud) {
  const live = await ingestAvailable();
  let busy = false;
  const dialog = $<HTMLDialogElement>('add-dialog');
  const input = $<HTMLTextAreaElement>('product-url');
  const feedback = $('ingest-feedback');
  const submitButton = $<HTMLButtonElement>('ingest-submit');
  const open = () => { if (!dialog.open) dialog.showModal(); };
  $('add-button').onclick = open; $('empty-add').onclick = open;
  if (!live) {
    $('add-intro').textContent = 'This is a published collection. Prepare a product link here to add from your local Things folder.';
    submitButton.textContent = 'Prepare import command';
    $('add-footnote').textContent = 'Collection edits are saved in this browser. Adding new products requires the local app.';
  }
  const submit = async (urls: string[]) => {
    open();
    if (!urls.length) { feedback.hidden = false; feedback.classList.add('is-error'); feedback.textContent = 'Enter a full product URL starting with https://.'; input.focus(); return; }
    if (busy) return;
    if (!live) {
      $('static-command').hidden = false;
      $('ingest-command').textContent = `npm run ingest -- --no-mesh ${urls.map(shellQuote).join(' ')}`;
      return;
    }
    busy = true; submitButton.disabled = true; input.disabled = true; feedback.hidden = false; feedback.classList.remove('is-error');
    feedback.textContent = `Adding ${urls.length === 1 ? 'your thing' : `${urls.length} things`}…`;
    const outcomes: string[] = [];
    let failed = false;
    try {
      const code = await ingestUrls(urls, line => {
        const s = line.trim();
        if (/^(done|skip|fail)\s/.test(s)) {
          failed ||= s.startsWith('fail');
          outcomes.push(s.replace(/^done\s+\S+\s+/, 'Added: ').replace(/^skip\s+\S+\s+/, '').replace(/^fail\s+\S+\s+/, 'Could not add: ').replace(/\s+refs=.*$/, ''));
          feedback.textContent = outcomes.join('\n');
        } else if (failed && /^\s{4,}\S/.test(line)) {
          outcomes.push(s); feedback.textContent = outcomes.join('\n');
        } else if (!outcomes.length) {
          if (s.startsWith('fetch ')) feedback.textContent = `Finding product details on ${new URL(s.split(/\s+/)[2]).hostname}…`;
          else if (s.startsWith('ref ')) feedback.textContent = 'Preparing product images…';
          else if (s.startsWith('primary cut-out')) feedback.textContent = 'Making a place on your shelf…';
        }
      });
      failed ||= code !== 0;
      feedback.classList.toggle('is-error', failed);
      feedback.textContent = outcomes.join('\n') || (failed ? 'Could not finish the import. Try again or check the local server log.' : 'Added to your collection.');
      if (failed) feedback.textContent += '\nBlocked shop? Try a direct product page, or supply an image URL in a batch file (see README).';
      else input.value = '';
    } catch (err) {
      feedback.classList.add('is-error'); feedback.textContent = `Could not add this thing: ${(err as Error).message}. Your collection is unchanged. You can retry.`;
    } finally { busy = false; submitButton.disabled = false; input.disabled = false; }
  };
  $('add-form').onsubmit = e => { e.preventDefault(); void submit(extractUrls(input.value)); };
  $('copy-command').onclick = async () => {
    try { await navigator.clipboard.writeText($('ingest-command').textContent || ''); $('copy-command').textContent = 'Copied'; }
    catch { hud.say('Select the command and copy it manually.', { error: true }); }
  };
  document.addEventListener('paste', e => {
    const target = e.target as HTMLElement;
    if (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
    const urls = extractUrls(e.clipboardData?.getData('text'));
    if (urls.length) { e.preventDefault(); input.value = urls.join('\n'); open(); input.focus(); }
  });
  let depth = 0;
  document.addEventListener('dragenter', e => { if (!e.dataTransfer?.types.some(t => t === 'text/plain' || t === 'text/uri-list')) return; e.preventDefault(); depth++; $('drop').hidden = false; });
  document.addEventListener('dragover', e => { e.preventDefault(); });
  document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('drop').hidden = true; } });
  document.addEventListener('drop', e => { e.preventDefault(); depth = 0; $('drop').hidden = true; const urls = extractUrls(e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain')); if (urls.length) { input.value = urls.join('\n'); open(); input.focus(); } });
}
export function shellQuote(value: string) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
