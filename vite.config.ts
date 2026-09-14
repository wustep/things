import { defineConfig } from 'vite';
import { thingsDevIngest } from './scripts/lib/dev-ingest.ts';

// Deploying under a sub-path (e.g. GitHub Pages)? BASE_PATH=/things/ npm run build
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [thingsDevIngest()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
