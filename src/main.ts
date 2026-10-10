import './style.css';
import { initialItems, normalizeItems } from './data.ts';
import { Stage } from './scene.ts';
import { Hud, setupUrlIntake } from './ui.ts';
import type { Item } from '../shared/types.ts';
import { applyChange, arrange, arrangement, type LocalArrangement } from '../shared/collection.ts';
import { ingestAvailable } from './ingest-client.ts';

const hud = new Hud();
let stage: Stage | undefined;
try {
  stage = new Stage(document.getElementById('stage') as HTMLCanvasElement, {
    hover: (node) => hud.hover(node?.item || null),
    select: (node) => hud.inspect(node.item),
    loading: (loaded, total, failed) => hud.loading(loaded, total, failed),
    labels: (points) => hud.positionLabels(points),
    unavailable: () => hud.noWebGL(),
  });
  stage.start();
} catch (error) {
  console.warn('[things] 3D unavailable', error);
  hud.noWebGL();
}
let visibleKey = '';
hud.onSceneChange = (items, visible) => {
  stage?.setVisible(visible);
  const key = JSON.stringify(items.map((i) => [i.id, i.addedAt, i.section]));
  if (visible && key !== visibleKey) {
    visibleKey = key;
    void stage?.setItems(items);
  }
};
hud.onReset = () => stage?.reset();
let source: Item[] = initialItems;
let items: Item[] = source;
const storageKey = `things:arrangement:v1:${import.meta.env.BASE_URL}`;
function readLocal() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const local = JSON.parse(raw) as LocalArrangement;
    if (
      !Array.isArray(local.order) ||
      !local.order.every((x) => typeof x === 'string') ||
      !Array.isArray(local.hidden) ||
      !local.hidden.every((x) => typeof x === 'string') ||
      !local.sections ||
      typeof local.sections !== 'object' ||
      !Object.values(local.sections).every((x) => typeof x === 'string')
    )
      throw new Error('Invalid saved arrangement');
    items = arrange(source, local);
  } catch {
    hud.say('Your saved arrangement could not be read. Showing the published collection.', { error: true });
  }
}
if (!import.meta.env.DEV) readLocal();
void ingestAvailable().then((live) => {
  document.getElementById('persistence-note')!.textContent = live
    ? 'Saved to your local collection.'
    : 'Edits are saved in this browser.';
  hud.onChange = async (change) => {
    if (live) {
      const response = await fetch(`${import.meta.env.BASE_URL}__things/collection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change),
      });
      if (!response.ok) throw new Error(await response.text());
      items = normalizeItems(await response.json());
      source = items;
    } else {
      const next = applyChange(items, change);
      try {
        localStorage.setItem(storageKey, JSON.stringify(arrangement(source, next)));
      } catch {
        throw new Error('Your browser could not save this change. Free some storage and try again.');
      }
      items = next;
    }
    hud.setItems(items);
  };
});
window.addEventListener('storage', (event) => {
  if (event.key === storageKey && !import.meta.env.DEV) {
    items = source;
    readLocal();
    hud.setItems(items);
  }
});
hud.setItems(items);
void setupUrlIntake(hud);
if (import.meta.hot) {
  import.meta.hot.accept('../data/items.json', (mod) => {
    if (mod) {
      items = normalizeItems(mod.default);
      source = items;
      hud.setItems(items);
    }
  });
}
