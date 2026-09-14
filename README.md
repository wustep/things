# Things

A black void with a shelf in it. Paste a product URL, and the thing appears on the shelf as
a floating cut-out, a box, or a bottle you can orbit around. Click it to go back to where it
came from.

Things is a personal collection viewer: one `items.json`, one folder of images, no backend.

## Run it

```sh
npm install
npm run dev          # http://localhost:5173
```

The dev server starts with the demo shelf in `data/items.json`. Drag to orbit, scroll to
zoom, hover for the label, click to open the product page.

## Add things

```sh
npm run ingest -- https://example.com/some-product
npm run ingest -- https://a.com/x https://b.com/y      # several at once
npm run ingest -- data/demo.json                        # a batch file
```

Ingest fetches the page, reads its product metadata (JSON-LD, Open Graph, site-specific
fallbacks), downloads the best reference images, keys the background out of the primary
photo, and decides how to show it:

| Shape      | When                                                        |
| ---------- | ----------------------------------------------------------- |
| `card`     | Default: the cut-out floats as a flat card                  |
| `box`      | Books, consoles, boxed things; or when the photo couldn't be keyed |
| `cylinder` | Tall bottles, cans, candles, tumblers                        |

While `npm run dev` is running you can also **paste or drop a URL onto the page**. The dev
server runs the same ingest and the shelf updates in place as items land. A production
build has no server, so pasting there just shows you the command to run.

Every ingest writes:

- `data/items.json`, the collection (imported by the viewer, so it ships in the build)
- `public/items/<id>/primary.png`, the keyed cut-out used as the texture
- `public/items/<id>/ref-N.jpg`, the reference photos
- `public/items/<id>/model.glb`, only when Meshy is enabled (below)

Useful flags and subcommands:

```sh
npm run ingest -- --list                       # what's on the shelf
npm run ingest -- --remove <id-or-url>         # take something off (deletes its files)
npm run ingest -- --force <url>                # re-ingest an existing item
npm run ingest -- --max-refs 2 <url>           # keep fewer reference photos
npm run ingest -- --no-mesh <url>              # skip Meshy even if a key is set
```

Batch files are a JSON array of URLs or objects. Objects can override what the page says:
`{ "url": "...", "title": "...", "brand": "...", "price": "...", "shape": "box" }`.

Re-ingesting the same URL is a no-op unless you pass `--force`. Items are identified by a
stable id derived from the URL (tracking parameters are ignored; Amazon URLs collapse to
their ASIN).

### Optional: real 3D models with Meshy

Copy `.env.example` to `.env` and set `MESHY_API_KEY`. Ingest will then send the cut-out to
[Meshy](https://www.meshy.ai) image-to-3D and store the resulting GLB next to the item. The
viewer prefers the GLB and keeps the procedural shape as a fallback. Without a key everything
works offline with procedural shapes.

## Demo shelf

The four demo items were ingested from public product pages with `npm run ingest -- --max-refs 2 data/demo.json`.
Product images belong to their respective owners and are included only to show the app working;
`npm run ingest -- --remove <id>` clears any of them.

## Build and deploy

```sh
npm run typecheck
npm run build        # dist/
npm run preview      # serve dist/ locally
```

`dist/` is a fully static site: the item list is bundled in and images are copied from
`public/`. Deploy it anywhere that serves static files.

- **Vercel**: `vercel.json` is included (Vite framework preset, `dist` output, SPA rewrite).
  Import the repo and deploy; the build command is `npm run build`.
- **Sub-path hosting** (GitHub Pages and the like): `BASE_PATH=/things/ npm run build`.

The build has no ingest endpoint. Add items locally, commit `data/` and `public/items/`,
and redeploy.

## Layout

```
index.html            entry
src/                  viewer (Vite + Three.js)
  main.ts             boot, HMR hook for data/items.json
  scene.ts            the void: renderer, orbit, dust, picking, animation
  items.ts            Item -> card / box / cylinder / GLB
  layout.ts           shelf slots
  ui.ts               caption, empty state, paste / drop intake
scripts/ingest.ts     CLI ingest
scripts/lib/          fetch, extract, images (keying, palette), asset (shape), meshy, dev-ingest (Vite plugin)
shared/types.ts       Item / Asset types shared by both sides
data/items.json       the collection
data/demo.json        batch file that produced the demo shelf
public/items/<id>/    per-item images (and model.glb when present)
```
