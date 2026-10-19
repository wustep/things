import assert from 'node:assert/strict';
import test from 'node:test';
import { clip, homeCard, metaFor, plain, sharePage, shelfTags } from '../scripts/lib/share-pages.ts';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Item } from '../shared/types.ts';

const template = `<!doctype html><html><head>
    <meta name="description" content="Things: a quiet shelf of objects, and notes on them." />
    <title>Things</title>
  </head><body></body></html>`;

const desk = {
  id: 'ergonofis-aba25b63',
  title: 'Sway Standing Desk',
  brand: 'ergonofis',
  price: '$2,595',
  domain: 'ergonofis.com',
  url: 'https://ergonofis.com/sway',
  description: 'Crafted from premium solid wood, the Sway Standing Desk offers lasting durability and a distinctive, timeless design.',
} as unknown as Item;

test('a thing’s preview: its name, then maker, price and shop, then the shop’s words', () => {
  const m = metaFor(desk, { url: 'https://things.wustep.me/t/ergonofis-sway-standing-desk' });
  assert.equal(m.title, 'Sway Standing Desk');
  assert.match(m.description, /^ergonofis · \$2,595 at ergonofis\.com\. Crafted from premium solid wood/);
});

test('an app’s preview says where it runs, and keeps its plan’s period', () => {
  const app = { ...desk, title: 'Mimestream', brand: undefined, price: '$50/yr', domain: 'mimestream.com', platforms: ['macOS'] } as unknown as Item;
  assert.match(metaFor(app, { url: 'u' }).description, /^macOS · \$50\/yr at mimestream\.com\. /);
  const phone = { ...app, title: 'Strong', price: undefined, domain: 'strong.app', platforms: ['iOS'] } as unknown as Item;
  assert.match(metaFor(phone, { url: 'u' }).description, /^iOS · strong\.app\. /);
  const both = { ...app, title: 'Notion', price: 'Free · Plus $9.99/mo', domain: 'notion.com', platforms: ['macOS', 'iOS'] } as unknown as Item;
  assert.match(metaFor(both, { url: 'u' }).description, /^macOS and iOS · Free, Plus \$10\/mo at notion\.com\. /);
});

test('a note, when there is one, speaks instead of the shop', () => {
  const m = metaFor({ ...desk, commentary: 'I **stand** at it most mornings. [More](https://x.y)' } as Item, { url: 'u' });
  assert.match(m.description, /ergonofis\.com\. I stand at it most mornings\. More$/);
});

test('the page keeps the app and swaps the head', () => {
  const html = sharePage(template, {
    title: 'Sway "Standing" Desk & co',
    description: 'A desk <b>.',
    url: 'https://things.wustep.me/t/x',
    image: { url: 'https://things.wustep.me/items/x/share.1.jpg', width: 1200, height: 630, alt: 'ergonofis desk' },
  });
  assert.match(html, /<title>Sway &quot;Standing&quot; Desk &amp; co · Things<\/title>/);
  assert.match(html, /<meta name="description" content="A desk &lt;b&gt;\." \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/things\.wustep\.me\/items\/x\/share\.1\.jpg" \/>/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
  assert.equal(html.match(/<title>/g)?.length, 1);
  assert.ok(html.indexOf('og:title') < html.indexOf('</head>'));
});

test('no card yet: a plain summary preview', () => {
  const html = sharePage(template, { title: 'X', description: 'Y', url: 'u' });
  assert.doesNotMatch(html, /og:image/);
  assert.match(html, /twitter:card" content="summary"/);
});

test('long text is cut at a word, never mid-word', () => {
  const out = clip('word '.repeat(80), 60);
  assert.ok(out.length <= 60);
  assert.match(out, /word…$/);
  assert.equal(clip('short and sweet'), 'short and sweet');
});

test('markdown is flattened to one line', () => {
  assert.equal(plain('# Head\n\n- one\n- _two_\n\n> quote `code`'), 'Head one two quote code');
});

test('the shelf unfurls with its own card: absolute og:image, 1200x630, a large Twitter card', () => {
  const tags = shelfTags('https://things.wustep.me', 'Things: a dark shelf of objects, and notes on them.', '/og/home.abc12345.jpg').join('\n');
  assert.match(tags, /<meta property="og:image" content="https:\/\/things\.wustep\.me\/og\/home\.abc12345\.jpg" \/>/);
  assert.match(tags, /og:image:width" content="1200"/);
  assert.match(tags, /og:image:height" content="630"/);
  assert.match(tags, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(tags, /og:url" content="https:\/\/things\.wustep\.me\/"/);
  const bare = shelfTags('https://things.wustep.me', 'x', null).join('\n');
  assert.doesNotMatch(bare, /og:image/);
  assert.match(bare, /twitter:card" content="summary"/);
});

test('the repo has a hashed home card for the build to use', () => {
  const card = homeCard(path.resolve('public'));
  assert.ok(card && /^\/og\/home\.[0-9a-f]{8}\.jpg$/.test(card), String(card));
  assert.ok(existsSync(path.join('public', card!)));
});
