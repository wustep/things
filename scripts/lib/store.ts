import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Item } from '../../shared/types.ts';

export async function loadCollection(file: string): Promise<Item[]> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Item[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export async function saveCollection(file: string, items: Item[]) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(items, null, 2) + '\n'); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
/** Shared by the CLI and local editor. A busy collection never silently overwrites edits. */
export async function withCollectionLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  try { await mkdir(lock); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('The collection is being updated. Wait for the current import to finish and retry.'); throw error; }
  try { return await work(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

/** A failed refresh must leave every old photo/model byte intact. */
export async function stageAssets<T>(destination: string, build: (staging: string) => Promise<T>): Promise<T> {
  const staging = `${destination}.staging-${randomUUID()}`;
  const backup = `${destination}.backup-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  let backedUp = false;
  try {
    const result = await build(staging);
    try { await rename(destination, backup); backedUp = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rename(staging, destination); }
    catch (error) { if (backedUp) await rename(backup, destination); throw error; }
    if (backedUp) await rm(backup, { recursive: true, force: true });
    return result;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
