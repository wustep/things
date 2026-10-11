import assert from 'node:assert/strict';
import test from 'node:test';
import items from '../data/items.json' with { type: 'json' };
import { AMAZON_TAG, affiliateUrl, amazonAsin } from '../shared/amazon.ts';
import { renderMarkdown } from '../src/markdown.ts';

test('affiliateUrl: Amazon product links become /dp/<ASIN> with our tag, whatever they carried', () => {
  const want = `https://www.amazon.com/dp/B0C4FM4MJK?tag=${AMAZON_TAG}`;
  assert.equal(affiliateUrl('https://www.amazon.com/Nord-88-Key-Digital-Pianos-Stage-STAGE4-88/dp/B0C4FM4MJK'), want);
  assert.equal(affiliateUrl('https://amazon.com/dp/b0c4fm4mjk?th=1&psc=1'), want);
  assert.equal(affiliateUrl('https://www.amazon.com/gp/product/B0C4FM4MJK/ref=ox_sc?tag=someone-else-20&linkCode=sl1'), want);
  assert.equal(affiliateUrl(want), want);
});

test('affiliateUrl: other Amazon pages keep their path with the tag set; other shops are untouched', () => {
  assert.equal(affiliateUrl('https://www.amazon.com/s?k=kalimba&tag=x-20'), `https://www.amazon.com/s?k=kalimba&tag=${AMAZON_TAG}`);
  for (const url of ['https://www.ikea.com/us/en/p/kyrre-stool-birch-60416925/', 'https://notamazon.com/dp/B0C4FM4MJK', 'https://amzn.to/4bAIa1U', 'not a url']) {
    assert.equal(affiliateUrl(url), url);
  }
  assert.equal(amazonAsin('https://www.amazon.co.uk/dp/B0C4FM4MJK'), undefined);
});

test('every Amazon link in data/items.json is stored canonical with the tag', () => {
  const amazon = items.filter((it) => /amazon\.|amzn\.|a\.co\//.test(it.url));
  assert.ok(amazon.length > 0);
  for (const it of amazon) assert.equal(it.url, affiliateUrl(it.url), it.id);
  for (const it of amazon) assert.match(it.url, new RegExp(`^https://www\\.amazon\\.com/dp/[A-Z0-9]{10}\\?tag=${AMAZON_TAG}$`), it.id);
});

test('Markdown notes link Amazon with the tag too', () => {
  assert.equal(
    renderMarkdown('[mouse](https://www.amazon.com/dp/B0FB21526X?th=1)'),
    `<p><a href="https://www.amazon.com/dp/B0FB21526X?tag=${AMAZON_TAG}" target="_blank" rel="noopener noreferrer">mouse</a></p>`,
  );
});
