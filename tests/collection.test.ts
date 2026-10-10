import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChange, arrange, arrangement, normalizeItems } from '../shared/collection.ts';
import type { Item } from '../shared/types.ts';
const item = (id: string, section = 'Office'): Item => ({ id, title: id, section, url: `https://shop.com/${id}`, domain: 'shop.com', images: [`/items/${id}/primary.png`], asset: { kind: 'procedural', shape: 'card', texture: `/items/${id}/primary.png`, aspect: 1, palette: ['#ffffff'] }, addedAt: '2026-10-10' });

test('moving preserves other sections and does not mutate the source', () => {
  const source = [item('a'), item('b', 'Home'), item('c')];
  assert.deepEqual(applyChange(source, { type: 'move', id: 'a', delta: 1 }).map(i => i.id), ['c', 'b', 'a']);
  assert.deepEqual(source.map(i => i.id), ['a', 'b', 'c']);
  assert.deepEqual(applyChange(source, { type: 'move', id: 'a', delta: -1 }), source);
});
test('section edit, removal and undo survive browser arrangement reload', () => {
  const source = [item('a'), item('b'), item('c')];
  let current = applyChange(source, { type: 'section', id: 'a', section: '  Studio  ' });
  current = applyChange(current, { type: 'remove', id: 'b' });
  assert.deepEqual(arrange(source, arrangement(source, current)), current);
  assert.equal(arrange([...source, item('new')], arrangement(source, current)).at(-1)?.id, 'new');
  current = applyChange(current, { type: 'restore', item: source[1], index: 1 });
  assert.deepEqual(current.map(i => i.id), ['a', 'b', 'c']);
  assert.equal(current[0].section, 'Studio');
  assert.equal(applyChange(current, { type: 'restore', item: source[1], index: 1 }).length, 3);
});
test('invalid data cannot break rendering or create unsafe links', () => {
  const good = item('safe');
  assert.deepEqual(normalizeItems([good, good, { ...good, id: 'bad', url: 'javascript:alert(1)' }, { ...good, id: 'broken', asset: { kind: 'glb', fallback: {} } }]), [good]);
  assert.throws(() => applyChange([good], { type: 'section', id: 'safe', section: 'x'.repeat(61) }));
  assert.throws(() => applyChange([good], { type: 'remove', id: 'missing' }));
});
