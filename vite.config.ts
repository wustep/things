import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { thingsDevIngest } from './scripts/lib/dev-ingest.ts';

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Deploying under a sub-path (e.g. GitHub Pages)? BASE_PATH=/things/ npm run build
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [thingsDevIngest()],
  build: {
    target: 'es2022',
    // Two pages: the 2D collection at / and the archived three.js shelf at /3d. They share no
    // entry code, so the 2D page never downloads three.js.
    rollupOptions: {
      input: { main: page('index.html'), archive3d: page('3d/index.html') },
      // What both pages share is the collection itself; name the chunk for what it is.
      output: { manualChunks: (id) => (/\/(data|shared)\/|\/src\/(data|sections|ingest-client)\.ts$/.test(id) ? 'collection' : undefined) },
    },
    chunkSizeWarningLimit: 1200,
  },
});
