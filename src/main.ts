import './style.css';
import { initialItems, normalizeItems } from './data.ts';
import { Stage } from './scene.ts';
import { Hud, setupUrlIntake } from './ui.ts';

const hud = new Hud();
const stage = new Stage(document.getElementById('stage') as HTMLCanvasElement, {
  hover: (node) => hud.setCaption(node),
  select: (node) => window.open(node.item.url, '_blank', 'noopener,noreferrer'),
});

function show(items: typeof initialItems) {
  hud.setCount(items.length);
  void stage.setItems(items);
}

stage.start();
show(initialItems);
void setupUrlIntake(hud);

// Dev: when `npm run ingest` (or a pasted URL) rewrites data/items.json, Vite pushes the new
// list here and the shelf rebuilds in place. Production builds bake the list in at build time.
if (import.meta.hot) {
  import.meta.hot.accept('../data/items.json', (mod) => {
    if (mod) show(normalizeItems(mod.default));
  });
}
