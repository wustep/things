import assert from 'node:assert/strict';
import test from 'node:test';
import items from '../data/items.json' with { type: 'json' };
import { AMAZON_TAG, affiliateUrl, amazonAsin, isAmazonShortLink } from '../shared/amazon.ts';
import { cleanLink } from '../shared/links.ts';
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

test('official short links (link.amazon) are kept exactly as they are', () => {
  for (const url of ['https://link.amazon/B0j8VTyZx', 'https://link.amazon/B0gVSNrj3']) {
    assert.ok(isAmazonShortLink(url), url);
    assert.equal(affiliateUrl(cleanLink(url)), url);
  }
  for (const url of ['https://link.amazon/B0j8VTyZx?ref=x', 'http://link.amazon/B0j8VTyZx', 'https://amzn.to/4bAIa1U', 'https://www.amazon.com/dp/B0C4FM4MJK']) {
    assert.ok(!isAmazonShortLink(url), url);
  }
});

test('every Amazon link in data/items.json is an official short link, or canonical with the tag', () => {
  const amazon = items.filter((it) => /amazon\.|link\.amazon\/|amzn\.|a\.co\//.test(it.url));
  assert.ok(amazon.length > 0);
  assert.ok(amazon.some((it) => isAmazonShortLink(it.url)));
  for (const it of amazon) {
    if (isAmazonShortLink(it.url)) continue;
    assert.equal(it.url, affiliateUrl(it.url), it.id);
    assert.match(it.url, new RegExp(`^https://www\\.amazon\\.com/dp/[A-Z0-9]{10}\\?tag=${AMAZON_TAG}$`), it.id);
  }
  // The shop label reads from the domain, so every Amazon link says amazon.com.
  for (const it of amazon) assert.equal(it.domain, 'amazon.com', it.id);
});

test('Markdown notes link Amazon with the tag too', () => {
  assert.equal(
    renderMarkdown('[mouse](https://www.amazon.com/dp/B0FB21526X?th=1)'),
    `<p><a href="https://www.amazon.com/dp/B0FB21526X?tag=${AMAZON_TAG}" target="_blank" rel="noopener noreferrer">mouse</a></p>`,
  );
});
