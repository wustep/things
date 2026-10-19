import assert from 'node:assert/strict';
import test from 'node:test';
import { containBox } from '../src/glide.ts';

test('containBox: the stand-in takes the same box the big picture will', () => {
  assert.deepEqual(containBox(800, 600, 2), { width: 800, height: 400 }); // wide: full width
  assert.deepEqual(containBox(800, 600, 0.5), { width: 300, height: 600 }); // tall: full height
  assert.deepEqual(containBox(800, 600, 1, 280), { width: 280, height: 280 }); // an app icon's cap
  assert.deepEqual(containBox(0, 600, 1), { width: 0, height: 0 });
  assert.deepEqual(containBox(800, 600, NaN), { width: 0, height: 0 });
});
