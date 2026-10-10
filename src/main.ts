import './style.css';
import { initialItems, normalizeItems } from './data.ts';
import { Stage } from './scene.ts';
import { Hud, setupUrlIntake } from './ui.ts';
import type { Item } from '../shared/types.ts';

const hud = new Hud();
let stage: Stage | undefined;
try {
  stage = new Stage(document.getElementById('stage') as HTMLCanvasElement, {
    hover: node => hud.hover(node?.item || null),
    select: node => hud.inspect(node.item),
    loading: (loaded, total, failed) => hud.loading(loaded, total, failed),
    labels: points => hud.positionLabels(points),
    unavailable: () => hud.noWebGL(),
  });
  stage.start();
} catch (error) { console.warn('[things] 3D unavailable', error); hud.noWebGL(); }
let visibleKey = '';
hud.onSceneChange = (items, visible) => {
  stage?.setVisible(visible);
  const key = JSON.stringify(items.map(i => [i.id, i.addedAt, i.section]));
  if (key !== visibleKey) { visibleKey = key; void stage?.setItems(items); }
};
hud.onReset = () => stage?.reset();
let items: Item[] = initialItems;
hud.setItems(items);
void setupUrlIntake(hud);
if (import.meta.hot) {
  import.meta.hot.accept('../data/items.json', mod => { if (mod) { items = normalizeItems(mod.default); hud.setItems(items); } });
}
