import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProduct, extractShopifyProduct } from '../scripts/lib/extract.ts';
import { idFor } from '../scripts/ingest.ts';
import { extractUrls } from '../src/ingest-client.ts';
const url = 'https://shop.example/products/lamp';
test('nested JSON-LD ProductGroup and ImageObject metadata', () => {
  const p = extractProduct(`<script type="application/ld+json">${JSON.stringify({ '@type': 'WebPage', mainEntity: { '@type': ['ProductGroup'], name: 'Desk Lamp', brand: { name: 'Studio' }, image: { contentUrl: '/lamp.png' }, offers: { price: 89.5, priceCurrency: 'EUR' } } })}</script>`, url);
  assert.equal(p.title, 'Desk Lamp'); assert.equal(p.brand, 'Studio'); assert.equal(p.price, '€89.50'); assert.deepEqual(p.images, ['https://shop.example/lamp.png']); assert.equal(p.declared, 1);
});
test('Open Graph fallback and product-scoped price ignore unrelated cart/shipping prices', () => {
  const p = extractProduct('<meta property="og:title" content="Recorder"><meta property="og:image" content="//cdn.example/front.webp"><body>Free shipping over $120<main><h1>Recorder</h1><img srcset="/small.jpg 200w, /large.jpg 1400w"></main></body>', url);
  assert.equal(p.price, undefined); assert.equal(p.title, 'Recorder'); assert.equal(p.images[0], 'https://cdn.example/front.webp'); assert.ok(p.images.includes('https://shop.example/large.jpg'));
});
test('Amazon gallery extraction and ASIN tracking deduplication', () => {
  const p = extractProduct('<span id="productTitle">Bottle</span><a id="bylineInfo">Visit the Owala Store</a><div class="priceToPay"><span class="a-offscreen">$29.99</span></div><img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/abc._AC_SX38_.jpg">', 'https://www.amazon.com/dp/B012345678');
  assert.equal(p.brand, 'Owala'); assert.equal(p.price, '$29.99'); assert.match(p.images[0], /abc.jpg$/);
  assert.equal(idFor('https://www.amazon.com/long-title/dp/B012345678?tag=test'), idFor('https://www.amazon.com/dp/B012345678'));
  assert.equal(idFor(`${url}?utm_source=test`), idFor(url));
});
test('Shopify image URLs and variants use cents only with a declared currency', () => {
  const data = { title: 'Lamp', vendor: 'Studio', images: ['//cdn.example/lamp.webp'], currency: 'GBP', variants: [{ id: 1, price: 9500 }, { id: 2, price: 11500 }] };
  assert.equal(extractShopifyProduct(data, `${url}?variant=2`).price, '£115');
  assert.equal(extractShopifyProduct({ ...data, currency: undefined }, url).price, undefined);
});
test('URL intake extracts distinct links without terminal punctuation', () => {
  assert.deepEqual(extractUrls(`Look: (${url}).\n${url}\nhttps://other.example/product`), [url, 'https://other.example/product']);
});
