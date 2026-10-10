import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Jimp } from 'jimp';
import { stageAssets, saveCollection, withCollectionLock } from '../scripts/lib/store.ts';
import { processPrimary, decode } from '../scripts/lib/images.ts';
import { chooseShape } from '../scripts/lib/asset.ts';
import { fetchHtml } from '../scripts/lib/fetch.ts';

const temp = () => mkdtemp(path.join(os.tmpdir(), 'things-test-'));
test('failed asset replacement preserves old photos and models byte for byte', async () => {
  const root = await temp(); const dir = path.join(root, 'item'); await mkdir(dir); await writeFile(path.join(dir, 'model.glb'), 'original-model');
  try {
    await assert.rejects(stageAssets(dir, async staging => { await writeFile(path.join(staging, 'primary.png'), 'partial'); throw new Error('blocked shop'); }), /blocked shop/);
    assert.equal(await readFile(path.join(dir, 'model.glb'), 'utf8'), 'original-model');
    await stageAssets(dir, async staging => { await writeFile(path.join(staging, 'primary.png'), 'replacement'); });
    assert.equal(await readFile(path.join(dir, 'primary.png'), 'utf8'), 'replacement');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('collection locks reject overlapping writes and release after failure', async () => {
  const root = await temp(), file = path.join(root, 'items.json');
  try {
    await withCollectionLock(file, async () => { await assert.rejects(withCollectionLock(file, async () => {}), /being updated/); await saveCollection(file, []); });
    await assert.rejects(withCollectionLock(file, async () => { throw new Error('failed'); }));
    await withCollectionLock(file, async () => assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), []));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('existing alpha and interior white highlights survive cutout processing', async () => {
  const image = new Jimp({ width: 300, height: 300, color: 0x00000000 });
  for (let y = 70; y < 230; y++) for (let x = 90; x < 210; x++) image.setPixelColor(0xffffffff, x, y);
  const p = await processPrimary(await image.getBuffer('image/png'));
  const out = await decode(p.png); const { width, height } = out.bitmap;
  assert.equal(out.getPixelColor(Math.floor(width / 2), Math.floor(height / 2)), 0xffffffff);
  assert.equal(out.bitmap.data[3], 0); assert.ok(p.removedFraction > .5);
  assert.equal(chooseShape('White bottle', .5, p.removedFraction), 'card');
});
test('a nearly white photograph never becomes an empty cutout', async () => {
  const image = new Jimp({ width: 300, height: 300, color: 0xffffffff });
  const p = await processPrimary(await image.getBuffer('image/png'));
  assert.equal(p.removedFraction, 0);
});
test('request timeout covers a stalled body, not just response headers', async () => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write('partial'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(fetchHtml(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 80), /Timed out/); }
  finally { server.closeAllConnections(); server.close(); }
});
test('CLI ingest, duplicate skip, force failure rollback, partial batch failure and lock cleanup', async () => {
  const root = await temp();
  const image = new Jimp({ width: 350, height: 350, color: 0xffffffff });
  for (let y = 60; y < 300; y++) for (let x = 80; x < 260; x++) image.setPixelColor(0x567045ff, x, y);
  const png = await image.getBuffer('image/png');
  let blocked = false;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/photo')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); }
    else if (blocked || req.url?.startsWith('/blocked')) { res.writeHead(403); res.end('blocked'); }
    else { res.end(`<script type="application/ld+json">{"@type":"Product","name":"Test object","image":"/photo.png","offers":{"price":42,"priceCurrency":"USD"}}</script>`); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const run = (args: string[]) => new Promise<{ code: number | null; log: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/ingest.ts', '--no-mesh', '--max-refs', '1', ...args], { cwd: process.cwd(), env: { ...process.env, THINGS_ROOT: root } });
    let log = ''; child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; }); child.on('error', reject); child.on('close', code => resolve({ code, log }));
  });
  try {
    assert.equal((await run([`${base}/thing`])).code, 0);
    const file = path.join(root, 'data/items.json'); const before = await readFile(file, 'utf8'); const items = JSON.parse(before);
    const asset = path.join(root, 'public', items[0].asset.texture); const photo = await readFile(asset);
    assert.match((await run([`${base}/thing?utm_source=again`])).log, /1 skipped/);
    blocked = true;
    const failed = await run(['--force', `${base}/thing`]); assert.equal(failed.code, 1); assert.match(failed.log, /HTTP 403/);
    assert.equal(await readFile(file, 'utf8'), before); assert.deepEqual(await readFile(asset), photo);
    blocked = false;
    const partial = await run([`${base}/another`, `${base}/blocked`]); assert.equal(partial.code, 1); assert.match(partial.log, /1 ingested, 0 skipped, 1 failed/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 2);
    assert.equal((await run(['--list'])).code, 0);
  } finally { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); }
});

test('local editor persists changes, keeps assets, rejects other origins and supports undo', async () => {
  const { createServer: createVite } = await import('vite');
  const { thingsDevIngest } = await import('../scripts/lib/dev-ingest.ts');
  const { symlink } = await import('node:fs/promises');
  const root = await temp();
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'));
  const item = { id: 'fixture', title: 'Fixture', domain: 'example.com', url: 'https://example.com/product', images: ['/items/fixture/primary.png'], addedAt: '2026-10-10', asset: { kind: 'procedural' as const, shape: 'card' as const, texture: '/items/fixture/primary.png', aspect: 1, palette: ['#ffffff'] } };
  const file = path.join(root, 'data/items.json'); await saveCollection(file, [item]);
  await mkdir(path.join(root, 'public/items/fixture'), { recursive: true }); await writeFile(path.join(root, 'public/items/fixture/primary.png'), 'kept');
  const vite = await createVite({ configFile: false, root, plugins: [thingsDevIngest()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  try {
    await vite.listen();
    const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
    const edit = (body: unknown, origin = base) => fetch(`${base}/__things/collection`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await edit({ type: 'remove', id: 'fixture' }, 'https://evil.example')).status, 403);
    assert.equal((await edit({ type: 'section', id: 'fixture', section: 'Studio' })).status, 200);
    assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].section, 'Studio');
    assert.equal((await edit({ type: 'remove', id: 'fixture' })).status, 200);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), []);
    assert.equal(await readFile(path.join(root, 'public/items/fixture/primary.png'), 'utf8'), 'kept');
    assert.equal((await edit({ type: 'restore', item, index: 0 })).status, 200);
    assert.equal((await edit({ type: 'restore', item: { ...item, url: 'javascript:alert(1)' }, index: 0 })).status, 409);
  } finally { await vite.close(); await rm(root, { recursive: true, force: true }); }
});
