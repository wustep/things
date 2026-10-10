import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Jimp } from 'jimp';
import { fetchBinary, fetchHtml } from '../scripts/lib/fetch.ts';
import { decode, hasMeaningfulAlpha, processPrimary } from '../scripts/lib/images.ts';
import { stageAssets } from '../scripts/lib/store.ts';

const temp = () => mkdtemp(path.join(os.tmpdir(), 'things-test-'));

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

test('a failed asset replacement preserves old photos and models byte for byte', async () => {
  const root = await temp();
  const dir = path.join(root, 'item');
  await mkdir(dir);
  await writeFile(path.join(dir, 'model.glb'), 'original-model');
  try {
    await assert.rejects(
      stageAssets(dir, async (staging) => {
        await writeFile(path.join(staging, 'primary.png'), 'partial');
        throw new Error('blocked shop');
      }),
      /blocked shop/,
    );
    assert.equal(await readFile(path.join(dir, 'model.glb'), 'utf8'), 'original-model');
    await stageAssets(dir, async (staging) => {
      await writeFile(path.join(staging, 'primary.png'), 'replacement');
    });
    assert.equal(await readFile(path.join(dir, 'primary.png'), 'utf8'), 'replacement');
    assert.deepEqual(await readdir(root), ['item'], 'no staging or backup folders left behind');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existing alpha is kept, so interior white highlights survive the cut-out', async () => {
  const image = new Jimp({ width: 300, height: 300, color: 0x00000000 });
  for (let y = 70; y < 230; y++) for (let x = 90; x < 210; x++) image.setPixelColor(0xffffffff, x, y);
  const p = await processPrimary(await image.getBuffer('image/png'));
  const out = await decode(p.png);
  const { width, height } = out.bitmap;
  assert.equal(out.getPixelColor(Math.floor(width / 2), Math.floor(height / 2)), 0xffffffff);
  assert.equal(out.bitmap.data[3], 0);
  assert.ok(p.removedFraction > 0.5);
});

test('an opaque image with an alpha channel is still keyed as before', async () => {
  const image = new Jimp({ width: 300, height: 300, color: 0xffffffff });
  for (let y = 70; y < 230; y++) for (let x = 90; x < 210; x++) image.setPixelColor(0x204080ff, x, y);
  assert.equal(hasMeaningfulAlpha(image.bitmap.data), false);
  const p = await processPrimary(await image.getBuffer('image/png'));
  assert.ok(p.removedFraction > 0.5, 'white background keyed out');
});

test('request timeout covers a stalled body, not just response headers', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(200);
    res.write('partial');
  });
  try {
    await assert.rejects(fetchHtml(server.base, 80), /timed out/);
  } finally {
    server.close();
  }
});

test('downloads over the size limit are refused, with or without content-length', async () => {
  const body = Buffer.alloc(64 * 1024, 1);
  const server = await serve((req, res) => {
    if (req.url === '/declared') res.writeHead(200, { 'content-length': body.length });
    else res.writeHead(200); // chunked: only the streaming check can catch it
    res.end(body);
  });
  try {
    await assert.rejects(fetchHtml(`${server.base}/declared`, 5000, 16 * 1024), /larger than 16 KB/);
    await assert.rejects(fetchBinary(`${server.base}/streamed`, undefined, 5000, 16 * 1024), /larger than 16 KB/);
    assert.equal((await fetchBinary(`${server.base}/streamed`, undefined, 5000, 128 * 1024)).buffer.length, body.length);
  } finally {
    server.close();
  }
});

test('CLI: ingest, skip, failed --force keeps old files, Shopify fallback, never calls Meshy', async () => {
  const root = await temp();
  const image = new Jimp({ width: 350, height: 350, color: 0xffffffff });
  for (let y = 60; y < 300; y++) for (let x = 80; x < 260; x++) image.setPixelColor(0x567045ff, x, y);
  const png = await image.getBuffer('image/png');
  let blocked = false;
  const server = await serve((req, res) => {
    if (req.url?.startsWith('/photo')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    } else if (blocked || req.url?.startsWith('/blocked')) {
      res.writeHead(403);
      res.end('blocked');
    } else if (req.url === '/products/lamp.js') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ title: 'Shop Lamp', vendor: 'Studio', images: ['/photo-lamp.png'] }));
    } else if (req.url?.startsWith('/products/')) {
      res.end('<html><body>Loading...</body></html>'); // client-rendered theme: nothing to scrape
    } else {
      res.end(
        `<script type="application/ld+json">{"@type":"Product","name":"Test object","image":"/photo.png","offers":{"price":42,"priceCurrency":"USD"}}</script>`,
      );
    }
  });
  const run = (args: string[]) =>
    new Promise<{ code: number | null; log: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--import', './tests/helpers/no-paid-network.ts', 'scripts/ingest.ts', '--max-refs', '1', ...args],
        // A key is set on purpose: without --mesh it must not be used.
        { cwd: process.cwd(), env: { ...process.env, THINGS_ROOT: root, MESHY_API_KEY: 'test-key-never-used' } },
      );
      let log = '';
      child.stdout.on('data', (b) => (log += b));
      child.stderr.on('data', (b) => (log += b));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, log }));
    });
  try {
    const first = await run([`${server.base}/thing`]);
    assert.equal(first.code, 0, first.log);
    assert.doesNotMatch(first.log, /PAID SERVICE CALLED|meshy/i);
    const file = path.join(root, 'data/items.json');
    const before = await readFile(file, 'utf8');
    const items = JSON.parse(before);
    assert.equal(items[0].asset.kind, 'procedural');
    const texture = path.join(root, 'public', items[0].asset.texture);
    const photo = await readFile(texture);

    assert.match((await run([`${server.base}/thing?utm_source=again`])).log, /1 skipped/);

    blocked = true;
    const failed = await run(['--force', `${server.base}/thing`]);
    assert.equal(failed.code, 1);
    assert.match(failed.log, /HTTP 403/);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual(await readFile(texture), photo);
    assert.deepEqual(
      (await readdir(path.join(root, 'public/items'))).filter((f) => /staging|backup/.test(f)),
      [],
    );
    blocked = false;

    const shop = await run(['--no-mesh', `${server.base}/products/lamp`]);
    assert.equal(shop.code, 0, shop.log);
    assert.match(shop.log, /shopify product JSON/);
    const lamp = JSON.parse(await readFile(file, 'utf8')).find((it: { title: string }) => it.title === 'Shop Lamp');
    assert.ok(lamp, 'Shopify title used');
    assert.equal(lamp.brand, 'Studio');

    // Opt-in path reaches Meshy (blocked by the preload, so nothing leaves the machine) and
    // falls back to the image-based asset. This also proves the guard above is live.
    const meshed = await run(['--mesh', `${server.base}/other`]);
    assert.equal(meshed.code, 0, meshed.log);
    assert.match(meshed.log, /PAID SERVICE CALLED: api\.meshy\.ai/);
    assert.match(meshed.log, /mesh generation failed, keeping procedural asset/);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
