import './style.css';
import { initialItems, normalizeItems } from './data.ts';
import { Stage } from './scene.ts';
import { groupItems } from './sections.ts';
import { Hud, setupUrlIntake } from './ui.ts';

const hud = new Hud();
let stage: Stage;
try {
  stage = new Stage(document.getElementById('stage') as HTMLCanvasElement, {
    hover: (node) => {
      hud.setCaption(node);
      hud.setHotSection(node?.item.section ?? null);
    },
    select: (node) => window.open(node.item.url, '_blank', 'noopener,noreferrer'),
    progress: (ready, total) => hud.setProgress(ready, total),
    lost: (lost) => (lost ? hud.say('The graphics card took a break; waiting for it to come back…', { error: true, sticky: true }) : hud.hush()),
  });
} catch (err) {
  console.error('[things] WebGL unavailable', err);
  hud.unavailable();
  throw err;
}
hud.onSectionPick = (label) => hud.setActiveSection(stage.focusSection(label));

function show(items: typeof initialItems) {
  hud.setCount(items.length);
  hud.setSections(groupItems(items));
  hud.setActiveSection(null);
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

// Dev handle for poking at the scene from the console (and for the screenshot script).
if (import.meta.env.DEV) (window as unknown as { __stage?: Stage }).__stage = stage;
