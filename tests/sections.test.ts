import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import items from '../data/items.json' with { type: 'json' };
import photos from '../data/photos.json' with { type: 'json' };
import sizes from '../data/sizes.json' with { type: 'json' };
import media from '../data/media.json' with { type: 'json' };
import { slugsFor } from '../shared/slug.ts';
import type { Item } from '../shared/types.ts';
import { groupItems, isSoftware } from '../src/sections.ts';
import { wholeDollars } from '../shared/text.ts';

const shelf = items as unknown as Item[];

test('the cases, in order: Office, Home, Music, Carry, Software', () => {
  assert.deepEqual(
    groupItems(shelf).map((g) => g.label),
    ['Office', 'Home', 'Music', 'Carry', 'Software'],
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

test('every app says where it runs, and only apps do', () => {
  for (const it of shelf) {
    if (isSoftware(it)) assert.ok(it.platforms?.length && it.platforms.every((p) => p === 'macOS' || p === 'iOS'), `${it.id} platforms`);
    else assert.equal(it.platforms, undefined, `${it.id} is a thing, not an app`);
  }
  const runs = (title: string) => shelf.find((it) => it.title === title)?.platforms;
  assert.deepEqual(runs('Strong'), ['iOS']);
  assert.deepEqual(runs('Retro'), ['iOS']);
  assert.deepEqual(runs('Mimestream'), ['macOS']);
  for (const both of ['Notion', 'Notion Calendar', 'Claude', 'Grok Bot', 'Raycast', 'Arc', 'Strongbox', 'Wispr Flow']) {
    assert.deepEqual(runs(both), ['macOS', 'iOS'], both);
  }
});

test('apps go by their own names, with no maker line', () => {
  for (const app of shelf.filter(isSoftware)) assert.equal(app.brand, undefined, `${app.id} brand`);
});

test('apps stand as small icons with their own gallery, and never count as things', () => {
  const apps = shelf.filter(isSoftware);
  assert.ok(apps.length >= 15);
  const picks = photos as Record<string, { hero?: { icon?: boolean }; gallery?: unknown[] }>;
  for (const app of apps) {
    assert.equal(picks[app.id]?.hero?.icon, true, `${app.id} hero is its icon`);
    const shots = picks[app.id]?.gallery?.length ?? 0;
    assert.ok(shots >= 2 && shots <= 4, `${app.id} has ${shots} screenshots`);
    assert.ok((sizes as Record<string, unknown>)[app.id] === 8, `${app.id} stands at icon size`);
    if (app.price) assert.equal(app.price, wholeDollars(app.price));
  }
  // The header counts what's on the physical shelves; the apps keep to their own case.
  const things = shelf.filter((it) => !isSoftware(it));
  assert.equal(things.length + apps.length, shelf.length);
  assert.ok(things.every((it) => it.section !== 'Software'));
});
