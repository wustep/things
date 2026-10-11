import assert from 'node:assert/strict';
import test from 'node:test';
import { shopText } from '../shared/text.ts';

test('shopText: page titles posing as descriptions are dropped', () => {
  assert.equal(shopText('Amazon.com: Logitech MX Master 3S Bluetooth Wireless Mouse No Receiver, Quiet Clicks : Electronics'), undefined);
  assert.equal(shopText('Amazon.com - Waykar 80 Pints 5000 Sq. Ft 2025 Energy Star Dehumidifier for Home and Basements'), undefined);
  assert.equal(shopText("Buy Timex 'Weekender Fairfield' Quartz Brass and Nylon Casual Watch: Shop top fashion brands. FREE DELIVERY possible on eligible purchases"), undefined);
  assert.equal(shopText('eufy Security Video Smart Lock FamiLock S3 Max with Palm Vein Recognition, 16GB Built-in Storage - Amazon.com'), undefined);
  assert.equal(shopText('Hart Colorways'), undefined);
  assert.equal(shopText('RC-500: Loop Station - Dual-Track Powerhouse'), undefined);
  assert.equal(shopText(''), undefined);
  assert.equal(shopText(undefined), undefined);
});

test('shopText: real prose stays, store boilerplate goes', () => {
  const prose = 'Precision milled from solid aluminum, the Card Bar offers an elegant way to display your cards. The front doubles as a pen tray.';
  assert.equal(shopText(prose), prose);
  assert.equal(
    shopText('Studio Display. 27-inch 5K Retina display. 12MP Center Stage camera. Studio-quality mics and speakers. 0% financing available. Buy now at apple.com.'),
    'Studio Display. 27-inch 5K Retina display. 12MP Center Stage camera. Studio-quality mics and speakers.',
  );
  assert.equal(
    shopText('Shipping Estimate - 6 to 8 weeks This well-rounded white oak side table fits perfectly beside a sofa or a bed, and its drawer holds what you need.'),
    'This well-rounded white oak side table fits perfectly beside a sofa or a bed, and its drawer holds what you need.',
  );
});

test('shopText: text cut off mid-sentence ends at its last full sentence', () => {
  const cut = 'This well-rounded white oak side table fits perfectly beside a sofa or a bed. It works as a workspace, lounging space or sleeping space. Dock storage on top for';
  assert.equal(shopText(cut), 'This well-rounded white oak side table fits perfectly beside a sofa or a bed. It works as a workspace, lounging space or sleeping space.');
  assert.equal(shopText('One long run-on sentence about a lovely oak coat rack with six hooks that never quite ends and keeps going on'), 'One long run-on sentence about a lovely oak coat rack with six hooks that never quite ends and keeps going on…');
});
