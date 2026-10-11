import assert from 'node:assert/strict';
import test from 'node:test';
import { pack } from '../src/pack.ts';

const sizes = (rows: { slot: number }[][]) => rows.map((r) => r.length);
const things = (...slots: number[]) => slots.map((slot) => ({ slot }));

test('fits on one shelf: one shelf', () => {
  assert.deepEqual(sizes(pack(things(100, 100, 100), 400)), [3]);
});

test('no thing is left alone on the last shelf', () => {
  // Greedy would give [4, 1]: the last one stands alone.
  assert.deepEqual(sizes(pack(things(100, 100, 100, 100, 100), 400)), [3, 2]);
});

test('a wide thing early on does not orphan the last one (the Home case)', () => {
  const home = things(320, 300, 140, 190, 300, 140, 140, 150, 150, 140, 140, 140, 136);
  const rows = pack(home, 1520);
  assert.ok(rows.every((r) => r.length > 1), `rows ${sizes(rows)}`);
  assert.ok(rows.every((r) => r.reduce((s, p) => s + p.slot, 0) <= 1520));
  assert.equal(rows.flat().length, home.length);
});

test('keeps collection order', () => {
  const list = things(90, 120, 80, 200, 60, 110, 70);
  assert.deepEqual(pack(list, 300).flat(), list);
});

test('a thing wider than the shelf still gets one', () => {
  assert.deepEqual(sizes(pack(things(500, 100, 100), 400)), [1, 2]);
});

test('evens the shelves out rather than fill the first', () => {
  assert.deepEqual(sizes(pack(things(130, 130, 130, 130), 400)), [2, 2]);
});
