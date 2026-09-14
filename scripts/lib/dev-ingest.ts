/**
 * Vite dev-server plugin: lets the viewer ingest product URLs that are pasted or dropped onto
 * the page. POST /__things/ingest {urls} runs `scripts/ingest.ts` as a child process and
 * streams its log back; the resulting data/items.json change reaches the page via HMR.
 *
 * Dev only. The endpoint is never part of a build, and it refuses cross-origin requests.
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

const MAX_URLS = 10;
const ITEM_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
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
      let running = false;

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
        const child = spawn(process.execPath, [tsxCli, script, ...urls], {
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
        child.on('close', (code) => {
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
