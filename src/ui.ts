/** The little chrome there is: wordmark count, empty state, caption, status line, drop overlay. */
import type { ItemNode } from './items.ts';
import { extractUrls, ingestAvailable, ingestUrls } from './ingest-client.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  private readonly count = $('count');
  private readonly empty = $('empty');
  private readonly emptyHint = $('empty-hint');
  private readonly caption = $('caption');
  private readonly captionTitle = $('caption-title');
  private readonly captionMeta = $('caption-meta');
  private readonly status = $('status');
  private readonly drop = $('drop');
  private statusTimer: number | undefined;

  setCount(n: number) {
    this.count.textContent = n > 0 ? String(n) : '';
    this.empty.classList.toggle('is-visible', n === 0);
  }

  setCaption(node: ItemNode | null) {
    if (!node) {
      this.caption.classList.remove('is-visible');
      return;
    }
    const { title, brand, price, domain } = node.item;
    this.captionTitle.textContent = title;
    this.captionMeta.textContent = [brand, price, domain].filter(Boolean).join('  ·  ');
    this.caption.classList.add('is-visible');
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
  if (s.startsWith('meshy')) return { text: `Meshy ${s.slice(6)}`, failed: false };
  if (s.startsWith('mesh generation failed')) return { text: 'Mesh generation failed; keeping the procedural shape', failed: false };
  if ((m = s.match(/^done\s+\S+\s+(.+?)(?:\s{2,}|$)/))) return { text: `Added ${m[1]}`, failed: false };
  if ((m = s.match(/^skip\s+\S+\s+already ingested: (.+)/))) return { text: `Already on the shelf: ${m[1]}`, failed: false };
  if ((m = s.match(/^fail\s+\S+\s+(\S+)/))) return { text: `Couldn't add ${hostOf(m[1])}`, failed: true };
  return null;
}
