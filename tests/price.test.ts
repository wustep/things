import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { wholeDollars } from '../shared/text.ts';

test('wholeDollars rounds to the nearest dollar and groups thousands', () => {
  assert.equal(wholeDollars('$89.99'), '$90');
  assert.equal(wholeDollars('$25.99'), '$26');
  assert.equal(wholeDollars('$659.99'), '$660');
  assert.equal(wholeDollars('$78.48'), '$78');
  assert.equal(wholeDollars('$0.50'), '$1');
  assert.equal(wholeDollars('$1529.00'), '$1,529');
  assert.equal(wholeDollars('$1,529.00'), '$1,529');
  assert.equal(wholeDollars('$1199'), '$1,199');
  assert.equal(wholeDollars('$5,999.00'), '$5,999');
  assert.equal(wholeDollars('$999.50'), '$1,000');
  assert.equal(wholeDollars('$175'), '$175');
  assert.equal(wholeDollars('€12.40'), '€12');
});

test('wholeDollars keeps a plan period and rounds only the amount', () => {
  assert.equal(wholeDollars('$20/mo'), '$20/mo');
  assert.equal(wholeDollars('$8/mo'), '$8/mo');
  assert.equal(wholeDollars('$49.99/yr'), '$50/yr');
  assert.equal(wholeDollars('$4.99 / mo'), '$5 / mo');
  assert.equal(wholeDollars('$1,199.50/year'), '$1,200/year');
  assert.equal(wholeDollars('$20/mo – $200/mo'), '$20/mo – $200/mo');
});

test('wholeDollars leaves non-prices alone', () => {
  assert.equal(wholeDollars(undefined), undefined);
  assert.equal(wholeDollars(null), undefined);
  assert.equal(wholeDollars('$10 – $20'), '$10 – $20');
  assert.equal(wholeDollars('Free'), 'Free');
});

test('every price in data/items.json is already whole dollars', () => {
  const data = JSON.parse(fs.readFileSync(new URL('../data/items.json', import.meta.url), 'utf8'));
  const items: { id: string; price?: string }[] = Array.isArray(data) ? data : data.items;
  for (const { id, price } of items) {
    if (price) assert.equal(price, wholeDollars(price), `${id} price ${price}`);
  }
});
