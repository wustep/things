import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import sharp from 'sharp';
import { heroFile, itemCard, labelLayout, labelSvg, type Hero } from '../scripts/lib/og-card.ts';
import { titleWithoutBrand } from '../shared/text.ts';
import type { Item } from '../shared/types.ts';

const items = JSON.parse(readFileSync('data/items.json', 'utf8')) as Item[];
const media = JSON.parse(readFileSync('data/media.json', 'utf8')) as Record<string, { hero: Hero }>;
const label = (i: Item) => ({ brand: i.brand, name: titleWithoutBrand(i.title, i.brand) });

test("every thing's card label draws whole: its full name and maker, at a readable size", async () => {
  for (const item of items) {
    const l = await labelLayout(label(item));
    assert.equal(l.name.text, label(item).name, item.id);
    assert.ok(l.name.size >= 36, `${item.id} ${l.name.size}`);
    if (item.brand) assert.equal(l.brand?.text, item.brand.toUpperCase(), item.id);
    const svg = await labelSvg(label(item)); // throws on a glyph it can't draw
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/, item.id);
  }
});

test('a name too long even at the smallest size is cut with an ellipsis, not run off the card', async () => {
  const l = await labelLayout({ name: 'An Extraordinarily Long Name '.repeat(4).trim() });
  assert.equal(l.name.size, 36);
  assert.match(l.name.text, /…$/);
});

test('a card is a 1200×630 JPEG', async () => {
  const item = items.find((i) => i.id === 'ugmonk-5117191f')!;
  const hero = media[item.id].hero;
  const jpg = await itemCard(readFileSync(heroFile('public', hero)), hero, label(item));
  const m = await sharp(jpg).metadata();
  assert.deepEqual([m.format, m.width, m.height], ['jpeg', 1200, 630]);
});
