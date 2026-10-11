import assert from 'node:assert/strict';
import test from 'node:test';
import items from '../data/items.json' with { type: 'json' };
import { resolveKey, slugsFor } from '../shared/slug.ts';
import type { Item } from '../shared/types.ts';

const shelf = items as unknown as Item[];
const slugs = slugsFor(shelf);

const renamed: [id: string, before: string, after: string][] = [
  ['jossandmain-cc12a72d', 'joss-and-main-alix-78-recessed-arm-chesterfield-sofa', 'joss-and-main-bari-91-upholstered-sofa'],
  ['jamescookartworkshop-b0e89a91', 'james-cook-bestsellers-collection', 'james-cook-typewriter-artwork'],
  ['etsy-55c9006b', 'bendingpixelsshop-interstellar-whole-movie-poster-details', 'bendingpixelsshop-movie-frames-poster'],
];

for (const [id, before, after] of renamed) {
  test(`a renamed thing keeps its old link: /t/${before} → /t/${after}`, () => {
    assert.equal(slugs.get(id), after);
    assert.equal(resolveKey(shelf, slugs, before)?.id, id);
    assert.equal(resolveKey(shelf, slugs, after)?.id, id);
    assert.equal(resolveKey(shelf, slugs, id)?.id, id);
  });
}

test('an alias never shadows another thing’s current slug or id', () => {
  const current = new Set([...slugs.values(), ...shelf.map((it) => it.id)]);
  for (const it of shelf) for (const a of it.aliases ?? []) assert.ok(!current.has(a), `${it.id}: alias ${a} is taken`);
});

test('a current slug wins over an alias that happens to match it', () => {
  const a = { id: 'a-1', aliases: ['b'] };
  const b = { id: 'b-2' };
  assert.equal(resolveKey([a, b], new Map([['a-1', 'a'], ['b-2', 'b']]), 'b')?.id, 'b-2');
  assert.equal(resolveKey([a, b], new Map(), 'nothing'), undefined);
});

test('a thing named for its maker says the name once', () => {
  assert.equal(slugs.get('jamcorder-2240bbb5'), 'jamcorder');
});
