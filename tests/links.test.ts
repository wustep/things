import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { cleanLink, isTrackingParam } from '../shared/links.ts';

test('tracking goes, the variant stays', () => {
  assert.equal(
    cleanLink('https://ergonofis.com/products/sway-standing-desk?_pos=3&_psq=ergonifis&_ss=e&_v=1.0&variant=45146331512911&utm_source=x&gclid=1'),
    'https://ergonofis.com/products/sway-standing-desk?variant=45146331512911',
  );
  assert.equal(
    cleanLink('https://www.etsy.com/listing/574168262/leather-valet-tray-large-white-suede?ref=shop_home_active_4&sca=1&ga_order=most_relevant&click_key=abc'),
    'https://www.etsy.com/listing/574168262/leather-valet-tray-large-white-suede',
  );
  assert.equal(
    cleanLink('https://www.jossandmain.com/furniture/pdp/joss-main-bari-91-upholstered-sofa-j001334207.html?piid=830869401%2C841047075&device=c&network=g&targetid=pla-1&gad_source=1&gbraid=a&wbraid=b&msclkid=m&fbclid=f&srsltid=s'),
    'https://www.jossandmain.com/furniture/pdp/joss-main-bari-91-upholstered-sofa-j001334207.html?piid=830869401%2C841047075',
  );
  assert.equal(cleanLink('https://www.peakdesign.com/products/roller-pro?Color=Sage&mc_cid=1&mc_eid=2&igsh=3'), 'https://www.peakdesign.com/products/roller-pro?Color=Sage');
});

test('a clean link, an image URL and anything unparseable come back untouched', () => {
  for (const u of [
    'https://jamcorder.com/',
    'https://www.bludot.com/products/perch-outdoor-lounge-chair?variant=44723226771635',
    'https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/MJLY4?wid=4000&hei=4000&fmt=png-alpha',
    'https://rnb.scene7.com/is/image/roomandboard/ventura_284351_walnut?$prodzoom0$&size=2400,2400&scl=1',
    'not a url',
  ]) assert.equal(cleanLink(u), u);
});

test('Amazon links are left exactly as they are', () => {
  const u = 'https://www.amazon.com/dp/B0D4DY9GWG?tag=wustep09-20&ref=abc&utm_source=x';
  assert.equal(cleanLink(u), u);
});

test('no stored link carries a tracking param', () => {
  const files = [...globSync('data/*.json'), ...globSync('media/originals/*/sources.json'), ...globSync('samples/*.json')];
  for (const f of files) {
    for (const raw of readFileSync(f, 'utf8').match(/https?:\/\/[^"\s\\]+/g) ?? []) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        continue;
      }
      if (/amazon\.|amzn\./.test(u.hostname)) continue;
      u.searchParams.forEach((_, key) => assert.ok(!isTrackingParam(key), `${f}: ${raw} has ${key}`));
    }
  }
});
