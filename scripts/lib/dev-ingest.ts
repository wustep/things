/**
 * Vite dev-server plugin for the local app:
 * - POST /__things/ingest {urls} runs `scripts/ingest.ts` as a child process and streams its log
 *   back (paste or drop a URL onto the page), then builds the new items' 2D images when the image
 *   tool is installed; the data/*.json changes reach the page via HMR.
 * - POST /__things/commentary {id, commentary} saves a note into data/items.json.
 * - /3d serves the archived three.js shelf (Vite would otherwise fall back to the 2D page).
 *
 * Dev only. None of this is part of a build, and it refuses cross-origin requests.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';
import type { Item } from '../../shared/types.ts';
import { writeFileAtomic } from './store.ts';

const MAX_URLS = 10;
const MAX_NOTE_CHARS = 20000;
const ITEM_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.glb': 'model/gltf-binary',
};

export function thingsDevIngest(): Plugin {
  return {
    name: 'things:dev-ingest',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root;
      const tsxCli = createRequire(path.join(root, 'package.json')).resolve('tsx/cli');
      const script = path.join(root, 'scripts', 'ingest.ts');
      const imagesTool = path.join(root, 'tools', 'images', 'build.ts');
      const dataFile = path.join(root, 'data', 'items.json');
      let running = false;

      // /3d → /3d/ so the archived 3D page's own index.html is served.
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        const base = server.config.base.replace(/\/$/, '');
        if (url === `${base}/3d` || url.startsWith(`${base}/3d?`)) {
          res.statusCode = 302;
          res.setHeader('location', url.replace(/\/3d/, '/3d/'));
          return res.end();
        }
        next();
      });

      server.middlewares.use('/__things/commentary', async (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, 'POST only');
        if (!sameOrigin(req)) return reply(res, 403, 'cross-origin requests are not allowed');
        if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return reply(res, 415, 'send application/json');
        if (running) return reply(res, 409, 'an ingest is writing the collection right now; try again in a moment');
        let id: unknown, commentary: unknown;
        try {
          ({ id, commentary } = JSON.parse(await readBody(req)) as { id?: unknown; commentary?: unknown });
        } catch {
          return reply(res, 400, 'invalid JSON body');
        }
        if (typeof id !== 'string' || typeof commentary !== 'string') return reply(res, 400, 'need {id, commentary} strings');
        if (commentary.length > MAX_NOTE_CHARS) return reply(res, 413, `notes are capped at ${MAX_NOTE_CHARS} characters`);
        try {
          const items = JSON.parse(await readFile(dataFile, 'utf8')) as Item[];
          const item = items.find((it) => it.id === id);
          if (!item) return reply(res, 404, 'that thing is no longer in data/items.json');
          const text = commentary.replace(/\r\n?/g, '\n').trim();
          if (text) item.commentary = text;
          else delete item.commentary;
          await writeFileAtomic(dataFile, JSON.stringify(items, null, 2) + '\n');
          server.config.logger.info(`[things] note ${text ? 'saved' : 'cleared'} for ${id}`);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ commentary: text }));
        } catch (err) {
          reply(res, 500, `could not write data/items.json (${(err as Error).message})`);
        }
      });

      // Serve public/items straight from disk. Vite's own public-file index is filled by its
      // watcher, which can miss files an ingest writes in a burst into a brand-new folder.
      const itemsDir = path.join(server.config.publicDir, 'items');
      server.middlewares.use('/items', async (req, res, next) => {
        try {
          const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
          const file = path.resolve(itemsDir, `.${rel}`);
          const type = ITEM_TYPES[path.extname(file).toLowerCase()];
          if (!type || !file.startsWith(itemsDir + path.sep)) return next();
          const info = await stat(file);
          if (!info.isFile()) return next();
          res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'cache-control': 'no-cache' });
          createReadStream(file).pipe(res);
        } catch {
          next();
        }
      });

      server.middlewares.use('/__things/ping', (_req, res) => {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('things');
      });

      server.middlewares.use('/__things/ingest', async (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, 'POST only');
        if (!sameOrigin(req)) return reply(res, 403, 'cross-origin requests are not allowed');
        if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return reply(res, 415, 'send application/json');

        let urls: string[];
        try {
          const body = JSON.parse(await readBody(req)) as { urls?: unknown };
          urls = Array.isArray(body.urls) ? body.urls.filter(isHttpUrl).slice(0, MAX_URLS) : [];
        } catch {
          return reply(res, 400, 'invalid JSON body');
        }
        if (urls.length === 0) return reply(res, 400, 'no http(s) urls in body');
        if (running) return reply(res, 409, 'an ingest is already running');

        running = true;
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        server.config.logger.info(`[things] ingest ${urls.join(' ')}`);
        // Paste-to-ingest never spends Meshy credits; models are opt-in from the CLI (--mesh).
        const child = spawn(process.execPath, [tsxCli, script, '--no-mesh', ...urls], {
          cwd: root,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (chunk: Buffer) => {
          res.write(chunk);
          process.stdout.write(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          res.write(chunk);
          process.stderr.write(chunk);
        });
        child.on('error', (err) => {
          running = false;
          res.end(`\n${err.message}\nexit 1\n`);
        });
        child.on('close', async (code) => {
          // New things get their 2D cut-out right away when the image tool is set up; until then
          // the shelf shows ingest's own keyed photo.
          const imagesReady = existsSync(path.join(root, 'tools', 'images', 'node_modules', '@huggingface'));
          if (code === 0 && imagesReady) {
            res.write('\nbuilding 2D images…\n');
            code = await new Promise<number | null>((resolve) => {
              const images = spawn(process.execPath, [tsxCli, imagesTool], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
              images.stdout.on('data', (chunk: Buffer) => res.write(chunk));
              images.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
              images.on('error', () => resolve(0));
              images.on('close', () => resolve(0)); // a failed cut-out still leaves a usable item
            });
          } else if (code === 0) {
            res.write('\nrun `npm run images` to give the new things their 2D cut-outs\n');
          }
          running = false;
          res.end(`\nexit ${code ?? 1}\n`);
        });
      });
    },
  };
}

function isHttpUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 2048) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (curl); fine for a local dev server
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) reject(new Error('body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, message: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(message);
}
