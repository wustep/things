/**
 * Optional higher-quality path: Meshy image-to-3D (https://docs.meshy.ai).
 * Only used when MESHY_API_KEY is set. Produces a GLB from the primary image.
 */

const BASE = 'https://api.meshy.ai/openapi/v1';

export function meshyAvailable(): boolean {
  return Boolean(process.env.MESHY_API_KEY);
}

export async function generateGlb(imagePng: Buffer, log: (msg: string) => void, timeoutMs = 8 * 60_000): Promise<Buffer> {
  const key = process.env.MESHY_API_KEY;
  if (!key) throw new Error('MESHY_API_KEY not set');
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  const create = await fetch(`${BASE}/image-to-3d`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      image_url: `data:image/png;base64,${imagePng.toString('base64')}`,
      enable_pbr: true,
      should_remesh: true,
      should_texture: true,
    }),
  });
  if (!create.ok) throw new Error(`Meshy create failed: HTTP ${create.status} ${await create.text()}`);
  const { result: taskId } = (await create.json()) as { result: string };
  log(`meshy task ${taskId} created`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    const res = await fetch(`${BASE}/image-to-3d/${taskId}`, { headers });
    if (!res.ok) throw new Error(`Meshy poll failed: HTTP ${res.status}`);
    const task = (await res.json()) as {
      status: string;
      progress?: number;
      model_urls?: { glb?: string };
      task_error?: { message?: string };
    };
    log(`meshy ${task.status.toLowerCase()} ${task.progress ?? 0}%`);
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
