import './style.css';
import { initialItems, normalizeItems } from './data.ts';
import { Stage } from './scene.ts';
import { groupItems } from './sections.ts';
import { Hud, setupUrlIntake } from './ui.ts';

let items = initialItems;
/** Ids in shelf order (grouped by section), for the previous / next titles in the detail panel. */
let order: string[] = [];

const hud = new Hud();
const stage = new Stage(document.getElementById('stage') as HTMLCanvasElement, {
  hover: (node) => {
    hud.setCaption(node);
    hud.setHotSection(node?.item.section ?? null);
  },
  focus: (item, index, total) => {
    if (!item) {
      hud.hideDetail();
      setHash(null);
      return;
    }
    const at = (step: number) => byId(order[(index + step + total) % total]);
    hud.showDetail(item, index, total, total > 1 ? at(-1) : undefined, total > 1 ? at(1) : undefined);
    hud.setActiveSection(item.section ?? null);
    setHash(item.id);
  },
  section: (label) => {
    if (!stage.focused) hud.setActiveSection(label);
  },
  insets: () => hud.insets(),
});
hud.onSectionPick = (label) => stage.focusSection(label);
hud.onCaptionPick = (item) => stage.focusItem(item.id);
hud.onStep = (step) => stage.focusNeighbor(step);
hud.onClose = () => stage.focusItem(null);

function byId(id: string | undefined) {
  return id === undefined ? undefined : items.find((i) => i.id === id);
}

function show(next: typeof initialItems) {
  items = next;
  order = groupItems(items).flatMap((g) => g.items.map((i) => i.id));
  hud.setCount(items.length);
  hud.setSections(groupItems(items));
  void stage.setItems(items);
}

/** The focused item lives in the URL hash, so a thing can be linked to and survives a reload. */
function setHash(id: string | null) {
  const next = id ? `#${id}` : '';
  if (location.hash === next) return;
  history.replaceState(null, '', next || location.pathname + location.search);
}

// ←/→ walk the shelf (from nothing focused they start at an end), Esc steps out, ↑/↓ and
// PageUp/PageDown ride the rail while browsing. Nothing fires while typing somewhere.
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
  if (e.key === ' ' && t && /^(button|a)$/i.test(t.tagName)) return; // Space presses the control instead
  switch (e.key) {
    case 'ArrowRight':
      stage.focusNeighbor(1);
      break;
    case 'ArrowLeft':
      stage.focusNeighbor(-1);
      break;
    case 'Escape':
      if (!stage.focused) return;
      stage.focusItem(null);
      break;
    case 'ArrowDown':
      stage.scrollBy(0.5);
      break;
    case 'ArrowUp':
      stage.scrollBy(-0.5);
      break;
    case 'PageDown':
    case ' ':
      stage.scrollBy(e.shiftKey ? -1.5 : 1.5);
      break;
    case 'PageUp':
      stage.scrollBy(-1.5);
      break;
    default:
      return;
  }
  e.preventDefault();
});

stage.start();
show(initialItems);
const linked = location.hash.slice(1);
if (linked && items.some((i) => i.id === linked)) stage.focusItem(linked);
void setupUrlIntake(hud);

// Dev: when `npm run ingest` (or a pasted URL) rewrites data/items.json, Vite pushes the new
// list here and the shelf rebuilds in place. Production builds bake the list in at build time.
if (import.meta.hot) {
  import.meta.hot.accept('../data/items.json', (mod) => {
    if (mod) show(normalizeItems(mod.default));
  });
}
