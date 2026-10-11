import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Build an item's asset folder somewhere else and swap it in only once everything succeeded.
 * A failed refresh (blocked shop, no usable images, a crash halfway through) must leave every
 * old photo and model byte intact, so `build` writes into a sibling staging folder and the
 * existing folder is moved aside, replaced, then deleted only after the swap.
 */
export async function stageAssets<T>(destination: string, build: (staging: string) => Promise<T>): Promise<T> {
  const staging = `${destination}.staging-${randomUUID()}`;
  const backup = `${destination}.backup-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  let backedUp = false;
  try {
    const result = await build(staging);
    try {
      await rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (backedUp) await rename(backup, destination);
      throw error;
    }
    if (backedUp) await rm(backup, { recursive: true, force: true });
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Write a file via a temp sibling and rename, so readers never see half of it. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
