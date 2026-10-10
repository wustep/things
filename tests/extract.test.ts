import assert from 'node:assert/strict';
import test from 'node:test';
import { extractShopifyProduct, shopifyProductEndpoints } from '../scripts/lib/extract.ts';

const url = 'https://shop.example/products/lamp';

test('Shopify .js product: image URLs, variants, and cents only with a declared currency', () => {
  const data = {
    title: 'Lamp',
    vendor: 'Studio',
    description: '<p>A <b>desk</b> lamp.</p>',
    images: ['//cdn.example/lamp.webp', '//cdn.example/lamp.webp', '//cdn.example/logo.png'],
    currency: 'GBP',
    variants: [
      { id: 1, price: 9500 },
      { id: 2, price: 11500 },
    ],
  };
  const p = extractShopifyProduct(data, `${url}?variant=2`);
  assert.equal(p.title, 'Lamp');
  assert.equal(p.brand, 'Studio');
  assert.equal(p.description, 'A desk lamp.');
  assert.equal(p.price, '£115');
  assert.deepEqual(p.images, ['https://cdn.example/lamp.webp']);
  assert.equal(p.declared, 1);
  assert.equal(extractShopifyProduct(data, url).price, '£95');
  assert.equal(extractShopifyProduct({ ...data, currency: undefined }, url).price, undefined);
});

test('Shopify .json product: {product} wrapper, {src} images, no guessed currency', () => {
  const p = extractShopifyProduct(
    {
      product: {
        title: 'Lamp',
        vendor: 'Studio',
        body_html: '<p>Bright.</p>',
        images: [{ src: 'https://cdn.example/a.jpg' }, { src: '/b.jpg' }],
        variants: [{ id: 1, price: '95.00' }],
      },
    },
    url,
  );
  assert.equal(p.title, 'Lamp');
  assert.equal(p.description, 'Bright.');
  assert.deepEqual(p.images, ['https://cdn.example/a.jpg', 'https://shop.example/b.jpg']);
  assert.equal(p.price, undefined);
});

test('Shopify extraction rejects non-product JSON', () => {
  assert.throws(() => extractShopifyProduct({ hello: 'world' }, url), /not a Shopify product/);
  assert.throws(() => extractShopifyProduct(null, url), /not a product response/);
});

test('Shopify endpoints only for /products/<handle> URLs, keeping the variant', () => {
  assert.deepEqual(shopifyProductEndpoints(`${url}/?variant=2&utm_source=x#top`), [
    `${url}.js?variant=2`,
    `${url}.json?variant=2`,
  ]);
  assert.deepEqual(shopifyProductEndpoints('https://shop.example/collections/all'), []);
  assert.deepEqual(shopifyProductEndpoints('https://shop.example/products/lamp/reviews'), []);
});
