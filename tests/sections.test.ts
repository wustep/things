import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import items from '../data/items.json' with { type: 'json' };
import photos from '../data/photos.json' with { type: 'json' };
import sizes from '../data/sizes.json' with { type: 'json' };
import media from '../data/media.json' with { type: 'json' };
import { slugsFor } from '../shared/slug.ts';
import type { Item } from '../shared/types.ts';
import { groupItems } from '../src/sections.ts';

const shelf = items as unknown as Item[];

test('the cases, in order: Office, Home, Music, Carry', () => {
  assert.deepEqual(
    groupItems(shelf).map((g) => g.label),
    ['Office', 'Home', 'Music', 'Carry'],
  );
  assert.ok(!shelf.some((it) => it.section === 'Misc'));
});

test('the Satechi wallet stand travels in Carry', () => {
  const stand = shelf.find((it) => it.id === 'amazon-091b2237');
  assert.equal(stand?.section, 'Carry');
});

test('the Journey wallet and stand is gone, with its pictures', () => {
  const gone = 'journeyofficial-67ef95f6';
  assert.ok(!shelf.some((it) => it.id === gone));
  for (const table of [photos, sizes, media]) assert.ok(!(gone in table));
  assert.ok(!existsSync(new URL(`../public/items/${gone}`, import.meta.url)));
});

test('renaming the case keeps every /t/ link: slugs come from maker and name, not section', () => {
  const slugs = slugsFor(shelf);
  assert.equal(new Set(slugs.values()).size, shelf.length);
  assert.equal(slugs.get('amazon-091b2237'), 'satechi-magsafe-wallet-stand-black');
  assert.equal(slugs.get('peakdesign-8f476d14'), 'peak-design-roller-pro-carry-on');
  assert.equal(slugs.get('anker-2866be47'), 'anker-prime-power-bank-27-650mah');
});
