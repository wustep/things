/**
 * Clean up Meshy models on the shelf, locally (no API calls). See scripts/lib/refine.ts.
 *
 *   npm run refine                       # every item with a model that hasn't been refined yet
 *   npm run refine -- <id> [<id> ...]    # just these
 *   npm run refine -- --force <id>       # refine again on top of the current file
 *   npm run refine -- --from <git-rev> <id>   # start over from the model as it was at <rev>
 *
 * Per-item settings live in data/mesh-finish.json ({ "<id>": Finish }); anything not listed
 * there gets DEFAULT_FINISH. The settings applied are recorded in the GLB's asset extras.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import type { Item } from '../shared/types.ts';
import { refineDocument, type Finish } from './lib/refine.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const items = JSON.parse(readFileSync(path.join(ROOT, 'data/items.json'), 'utf8')) as Item[];
const finishPath = path.join(ROOT, 'data/mesh-finish.json');
const finishes = (existsSync(finishPath) ? JSON.parse(readFileSync(finishPath, 'utf8')) : {}) as Record<string, Finish>;

const args = process.argv.slice(2);
let force = false;
let from: string | undefined;
const ids: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--force') force = true;
  else if (args[i] === '--from') from = args[++i];
  else ids.push(args[i]);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const targets = items.filter((it) => it.asset.kind === 'glb' && (ids.length === 0 || ids.includes(it.id)));
for (const id of ids) if (!targets.some((t) => t.id === id)) console.warn(`skip  ${id}  not an item with a model`);

for (const item of targets) {
  if (item.asset.kind !== 'glb') continue;
  const rel = path.join('public', item.asset.url.replace(/^\//, ''));
  const file = path.join(ROOT, rel);
  const bytes = from ? execFileSync('git', ['show', `${from}:${rel}`], { cwd: ROOT, maxBuffer: 64 << 20 }) : readFileSync(file);
  const doc = await io.readBinary(new Uint8Array(bytes));
  const done = (doc.getRoot().getExtras() as { thingsFinish?: unknown }).thingsFinish;
  if (done && !force && !from) {
    console.log(`skip  ${item.id}  already refined (use --force or --from <rev>)`);
    continue;
  }
  const finish = finishes[item.id] ?? {};
  console.log(`refine ${item.id}  ${JSON.stringify(finish)}`);
  const t = Date.now();
  await refineDocument(doc, finish, (m) => console.log(`      ${m}`));
  const out = Buffer.from(await io.writeBinary(doc));
  await writeFile(file, out);
  console.log(`      ${Math.round(bytes.length / 1024)} KB -> ${Math.round(out.length / 1024)} KB in ${Date.now() - t} ms`);
}
