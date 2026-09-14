/**
 * Optional higher-quality path: Meshy multi-image-to-3D (https://docs.meshy.ai/en/api/multi-image-to-3d).
 * Only used when MESHY_API_KEY is set. Takes one to four photos of the same object, front view
 * first, and returns a textured GLB.
 */

const BASE = 'https://api.meshy.ai/openapi/v1';
const ENDPOINT = 'multi-image-to-3d';
/** The endpoint accepts at most this many reference images per task. */
export const MAX_MESH_IMAGES = 4;
const POLL_MS = 8000;
/** Wait this long when Meshy says every concurrent task slot is taken. */
const BUSY_RETRY_MS = 20000;
const MAX_POLL_FAILURES = 5;

export interface MeshImage {
  data: Buffer;
  mime: 'image/png' | 'image/jpeg';
}

export function meshyAvailable(): boolean {
  return Boolean(process.env.MESHY_API_KEY);
}

export async function generateGlb(images: MeshImage[], log: (msg: string) => void, timeoutMs = 15 * 60_000): Promise<Buffer> {
  const key = process.env.MESHY_API_KEY;
  if (!key) throw new Error('MESHY_API_KEY not set');
  if (images.length === 0) throw new Error('no reference images to send to Meshy');
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const deadline = Date.now() + timeoutMs;

  const noRemesh = process.env.MESHY_NO_REMESH === '1';
  const body = JSON.stringify({
    image_urls: images.slice(0, MAX_MESH_IMAGES).map((i) => `data:${i.mime};base64,${i.data.toString('base64')}`),
    ai_model: 'latest',
    // Docs: highest-quality raw mesh when should_remesh is false; otherwise target_polycount applies.
    should_remesh: !noRemesh,
    should_texture: true,
    enable_pbr: true,
    ...(noRemesh ? {} : { target_polycount: 60000 }),
    target_formats: ['glb'],
  });

  // Create. A 429 "NoMoreConcurrentTasks" just means the queue is full; wait and try again.
  let taskId: string | undefined;
  while (!taskId) {
    const create = await fetch(`${BASE}/${ENDPOINT}`, { method: 'POST', headers, body });
    if (create.ok) {
      taskId = ((await create.json()) as { result: string }).result;
      break;
    }
    const text = await create.text();
    if (create.status === 429 && Date.now() + BUSY_RETRY_MS < deadline) {
      log(`meshy busy (${summary(text)}); retrying in ${BUSY_RETRY_MS / 1000}s`);
      await sleep(BUSY_RETRY_MS);
      continue;
    }
    throw new Error(`Meshy create failed: HTTP ${create.status} ${summary(text)}`);
  }
  log(`meshy task ${taskId} created from ${Math.min(images.length, MAX_MESH_IMAGES)} image(s)`);

  let failures = 0;
  let lastStatus = '';
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let task: {
      status: string;
      progress?: number;
      model_urls?: { glb?: string };
      task_error?: { message?: string };
    };
    try {
      const res = await fetch(`${BASE}/${ENDPOINT}/${taskId}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      task = await res.json();
      failures = 0;
    } catch (err) {
      if (++failures >= MAX_POLL_FAILURES) throw new Error(`Meshy poll failed ${failures} times: ${(err as Error).message}`);
      continue;
    }
    const line = `meshy ${task.status.toLowerCase()} ${task.progress ?? 0}%`;
    if (line !== lastStatus) log(line);
    lastStatus = line;
    if (task.status === 'SUCCEEDED') {
      const glbUrl = task.model_urls?.glb;
      if (!glbUrl) throw new Error('Meshy succeeded without a GLB url');
      const glb = await fetch(glbUrl);
      if (!glb.ok) throw new Error(`GLB download failed: HTTP ${glb.status}`);
      return Buffer.from(await glb.arrayBuffer());
    }
    if (task.status === 'FAILED' || task.status === 'CANCELED') {
      throw new Error(`Meshy task ${task.status}: ${task.task_error?.message ?? 'unknown error'}`);
    }
  }
  throw new Error('Meshy task timed out');
}

/**
 * Fetch the GLB of a task that already finished (for instance one an interrupted ingest paid for
 * but never downloaded). Fails unless the task SUCCEEDED.
 */
export async function fetchTaskGlb(taskId: string, log: (msg: string) => void): Promise<Buffer> {
  const key = process.env.MESHY_API_KEY;
  if (!key) throw new Error('MESHY_API_KEY not set');
  const res = await fetch(`${BASE}/${ENDPOINT}/${taskId}`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Meshy task ${taskId}: HTTP ${res.status} ${summary(await res.text())}`);
  const task = (await res.json()) as { status: string; model_urls?: { glb?: string }; task_error?: { message?: string } };
  if (task.status !== 'SUCCEEDED') {
    throw new Error(`Meshy task ${taskId} is ${task.status}${task.task_error?.message ? `: ${task.task_error.message}` : ''}`);
  }
  const glbUrl = task.model_urls?.glb;
  if (!glbUrl) throw new Error(`Meshy task ${taskId} has no GLB url`);
  log(`meshy task ${taskId} already finished; downloading its GLB`);
  const glb = await fetch(glbUrl);
  if (!glb.ok) throw new Error(`GLB download failed: HTTP ${glb.status}`);
  return Buffer.from(await glb.arrayBuffer());
}

function summary(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (parsed.message) return parsed.message;
  } catch {
    /* not JSON */
  }
  return text.replace(/\s+/g, ' ').slice(0, 160);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
