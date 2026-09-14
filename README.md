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

The dev server starts with the shelf in `data/items.json`. Drag to orbit, scroll to zoom,
hover (or tap) a thing for its card, click the thing or the card to open the product page.
Items with a `section` are grouped into their own shelves, and on wider screens the section
labels under the wordmark show live counts; click one to frame that section.

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
npm run ingest -- --remesh <url>               # keep its photos, just (re)make the Meshy model
npm run ingest -- --max-refs 2 <url>           # keep fewer reference photos
npm run ingest -- --no-mesh <url>              # skip Meshy even if a key is set
npm run ingest -- --parallel 4 batch.json      # work on four entries at once (Meshy is the slow part)
```

Batch files are a JSON array of URLs or objects. Objects can override what the page says and
add what it doesn't know:

```json
{
  "url": "https://...",
  "title": "...", "brand": "...", "price": "...",
  "section": "Office",
  "image": "https://.../primary.jpg",
  "images": ["https://.../another-angle.jpg"],
  "shape": "box"
}
```

`section` groups things on the shelf (a Moonsift collection's sections, say). `image` is used
as the primary photo and `images` add more reference photos; both are tried before anything
the page declares. When the brand is known it is stripped from the title ("Simplehuman 60L
Trash Can" becomes "60L Trash Can" under a Simplehuman line) so the card never says it twice.

Reference photos are de-duplicated by perceptual hash, so a CDN's ladder of sizes for the same
shot counts once (the largest version wins), and `--max-refs` distinct views are kept.

Re-ingesting the same URL is a no-op unless you pass `--force`. Items are identified by a
stable id derived from the URL (tracking parameters are ignored; Amazon URLs collapse to
their ASIN).

### Optional: real 3D models with Meshy

Copy `.env.example` to `.env` and set `MESHY_API_KEY`. Ingest will then send up to four
reference photos (the primary first, then the cleanest other single-object shots) to
[Meshy](https://www.meshy.ai) multi-image-to-3D and store the resulting GLB next to the item.
Meshy's 2k PBR textures are downsized to 1k JPEGs and the geometry quantized on the way in, so
a model lands at roughly 1 MB instead of 7–15 MB. The viewer prefers the GLB and keeps the
procedural shape as a fallback; `asset.refs` records which photos the mesh came from. Without
a key everything works offline with procedural shapes.

Each Meshy task takes a few minutes and costs credits (30 per model at the time of writing), so
batches are best run with `--parallel`; the account's concurrent-task limit is respected by
waiting and retrying.

`--remesh` gives items that are already on the shelf a model without fetching anything again:
the photos and cut-out on disk are reused, only the GLB is made (and batch overrides for
`title`, `brand`, `price` and `section` still apply). Items that already have a model are
skipped unless `--force` is also given, and an item is left untouched when Meshy fails. If an
ingest was interrupted after Meshy finished, the paid-for model is still on Meshy's side: put
its task id in the batch entry as `meshTask` and `--remesh` attaches it instead of starting a
new task.

## The shelf

`samples/moonsift-ingest.json` is a Moonsift collection (Office / Home / Misc) plus a couple of
extra Amazon finds; `npm run ingest -- --force --parallel 4 samples/moonsift-ingest.json` rebuilds
it with Meshy models, and `npm run ingest -- --remesh --parallel 4 samples/moonsift-ingest.json`
fills in models for whatever is still procedural. `data/demo.json` is a small batch of public product pages for trying the
pipeline. Product images belong to their respective owners; `npm run ingest -- --remove <id>`
clears any of them.

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
  scene.ts            the void: renderer, orbit, dust, picking, animation, section framing
  items.ts            Item -> card / box / cylinder / GLB
  layout.ts           shelf slots, one block of shelves per section
  sections.ts         group items by section (layout and chrome counts share it)
  ui.ts               product card, section labels, empty state, paste / drop intake
scripts/ingest.ts     CLI ingest
scripts/lib/          fetch, extract, images (keying, hashing, palette), asset (shape), meshy, glb (slimming), dev-ingest (Vite plugin)
shared/types.ts       Item / Asset types shared by both sides
shared/text.ts        brand-once title rule shared by both sides
data/items.json       the collection
data/demo.json        small batch of public product pages
samples/              the Moonsift collection batch and its raw export
public/items/<id>/    per-item images (and model.glb when present)
```
