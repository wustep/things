# Things

A personal shelf for objects worth keeping. Save product links, look around a small 3D
collection, and arrange the things you want to come back to. No account or database.

## Start

Use Node.js 22 or newer.

```sh
npm install
npm run dev
# Open http://localhost:5173
```

The included collection has product photos and existing 3D models. **No paid service is
needed.** New imports use product images by default, even if a Meshy key is present.

## Make it yours

- **Browse:** section tabs filter the collection. Shelf pages show eight objects on a desktop
  and four on a phone. Use the arrows at the bottom to see more.
- **Look around:** drag to orbit, scroll or pinch to zoom, and choose **Reset view** to return.
  Dragging and pinching never open an object.
- **Inspect:** hover for a quick label; click or tap an object or its name for photos, details,
  and a clearly labeled shop link. Shop links open a new tab.
- **Find:** switch to **Catalog** for a searchable, scrollable photo collection.
- **Arrange:** open a thing, type or choose a section, then select **Move**. A new name creates
  a section; a blank name moves it to Unsorted. The arrow buttons reorder things within a
  section. Empty sections disappear.
- **Remove:** choose **Remove from collection**. Undo stays available until the next action
  or a reload. Removing in the app keeps the image/model files on disk.
- **Add:** choose **Add a thing**, paste one or more product URLs, and submit. Pasting or
  dropping links anywhere opens the form for review. Up to ten links can be added together.

While the local app is running, edits are written atomically to `data/items.json` and
imports appear without reloading. Commit that file and any new assets to publish them.

**On a published static site**, arrangements are personal to that browser and site path,
using local storage. They survive reloads and preserve newly published items. They do not
modify the shared collection or sync across devices. Adding a link prepares a safely quoted
terminal command to run in your local Things folder. If browser storage is unavailable,
Things reports the problem instead of pretending the edit was saved.

### Keyboard and accessibility

All objects have keyboard-accessible name buttons and catalog entries. On the shelf canvas,
use arrow keys to browse objects, Enter to inspect, and **R** to reset the camera. Escape
closes dialogs; focus returns to the collection. Dialogs contain keyboard focus. Section
tabs, view toggles, loading messages and errors have accessible names or live announcements.
Reduced motion removes camera transitions and hover/entrance animation. If WebGL is
unavailable, Things opens the catalog. Broken images/models retain their item details.

## Import from the terminal

```sh
npm run ingest -- https://store.stonemaiergames.com/products/wingspan
npm run ingest -- https://shop.example/one https://shop.example/two
npm run ingest -- data/demo.json
npm run ingest -- --list
```

The importer reads JSON-LD, Open Graph, Amazon gallery markup and product image containers.
It also tries Shopify's public product JSON when metadata is incomplete. JPEG, PNG, WebP
and AVIF are supported. Tracking parameters do not create duplicate items; Amazon product
links are keyed by ASIN. Existing URLs are skipped unless `--force` is supplied.

Images are deduplicated, bounded in size, and stored as reference JPEGs plus a PNG for the
shelf. Existing alpha is preserved. For flat backgrounds, edge-connected removal retains
interior highlights, removes matte fringes and refuses near-empty masks. Clean cutouts keep
their original silhouette. Busy lifestyle photographs remain photographs; background removal
is a conservative local algorithm, not a semantic segmentation service.

```sh
npm run ingest -- --force <url>         # Refresh metadata and images safely
npm run ingest -- --max-refs 2 <url>    # Save fewer reference photos
npm run ingest -- --parallel 3 batch.json
npm run ingest -- --no-mesh <url>       # Explicitly free; also the default
npm run ingest -- --remove <id-or-url>  # Permanently delete this item AND its asset folder
```

`--force` builds in a staging directory. A failed download or cutout leaves the previous
item and its assets intact. Collection writes are atomic; a lock prevents overlapping CLI
and UI edits from silently overwriting each other. A mixed batch saves successful items and
returns exit code 1 if any item fails. Repeated inputs in a batch are processed once.

### Blocked shops and overrides

Some shops reject automated requests or render their product information only in a browser.
A 403, missing image or timeout is reported with the original reason. Things does not bypass
shop protections. Use a direct product URL, try later, or provide a product image and metadata
in a batch file:

```json
[
  {
    "url": "https://shop.example/products/lamp",
    "title": "Desk lamp",
    "brand": "Example Studio",
    "price": "€89",
    "section": "Office",
    "image": "https://cdn.example/lamp.png",
    "images": ["https://cdn.example/lamp-side.jpg"],
    "shape": "card"
  }
]
```

`image` is tried first. Optional `images` supply other views. A `shape` override can be
`card`, `box`, or `cylinder`. Prices are snapshots, not live quotes. The importer only uses
product-specific price metadata: unrelated shipping thresholds and cart prices are ignored.
If it cannot establish the price or currency reliably, it leaves the price blank.

The October 2026 smoke pass imported Teenage Engineering, Stonemaier Games, Ugmonk and Amazon.
Aesop and LEGO returned HTTP 403. Shop behavior can change; `data/demo.json` contains the four
successful examples. The 24 original collection items and all their assets were preserved.

If an interrupted process leaves `data/items.json.lock`, first verify no import or dev edit
is running, then remove that empty lock directory and retry. In normal failures it is
released automatically. Temporary staging directories are cleaned up after a failed import.

### Optional paid 3D generation

Existing GLB models load automatically. To generate **new** models, set `MESHY_API_KEY` in
`.env` (see `.env.example`) and explicitly pass `--mesh`:

```sh
npm run ingest -- --mesh <url>          # Uses paid Meshy credits
npm run ingest -- --remesh <url>        # Also explicitly requests paid generation
```

Meshy is never invoked by the browser intake. `--no-mesh` disables it on the CLI. Without
an explicit generation flag, no credits are spent. Generated models are optimized for the
web; a photo/procedural fallback is retained. Mesh generation is approximate and can distort
fine text or geometry. The inspection photo is the source reference.

`--remesh` reuses photos already on disk. A batch entry can provide `meshTask` to retrieve an
existing completed task rather than creating a new one. Check your Meshy account for current
pricing and task limits before choosing paid generation.

## Check and build

```sh
npm test                 # Metadata, cutouts, persistence, network and real CLI fixture tests
npm run typecheck        # Viewer, shared code and scripts
npm run build            # Typecheck viewer + production assets in dist/
npm run preview -- --port 5174
npm run test:browser     # Headless Chrome against http://127.0.0.1:5174
```

Browser tests require Chrome locally. `PLAYWRIGHT_CHANNEL=chromium` uses an installed
Playwright Chromium instead; `npx playwright install chromium` installs it. On CI,
`CI=1` selects the Playwright browser. `SITE_URL`, `SCREENSHOT_DIR`, and `SCREENSHOT_PREFIX`
override the review target and screenshots (default `/private/tmp/things-review`). The full
browser suite is intended for a production build: persistence tests use an isolated browser
profile and never remove repository items. It covers raycast hover/click, orbit, keyboard,
search, ordering, section edits, undo, persistence, phone/touch, empty and error states,
WebGL fallback, and WCAG A/AA checks with axe.

## Publish

`dist/` is static: collection metadata is bundled and `public/items/` is copied into the
build. Vercel uses `npm run build` and the included `vercel.json`. For sub-path hosting:

```sh
BASE_PATH=/things/ npm run build
```

There is no public ingest or edit endpoint. Local endpoints exist only in Vite development,
require same-origin JSON requests, and serialize collection writes. No user data is sent to
an external model service during normal use.

The renderer only loads the current shelf, with three concurrent asset loads, capped pixel
ratio, explicit GPU disposal on page changes, and no rendering while idle, hidden or in
Catalog. The original full collection is available through the lightweight catalog without
loading every GLB. Large model files are still the main first-visit cost.

## Project map

```text
src/main.ts             boot, local/static persistence, collection hot reload
src/scene.ts            demand rendering, camera, lighting, shelves, pointer/keyboard picking
src/items.ts            model/photo assets and GPU disposal
src/ui.ts               catalog, dialogs, sections, pagination, intake and notifications
src/style.css           responsive interface and reduced motion
shared/collection.ts    validated items, section/order/removal and browser arrangements
scripts/ingest.ts       CLI pipeline (free by default)
scripts/lib/            extraction, images, bounded fetches, atomic store, Vite endpoints
scripts/lib/meshy.ts    optional explicitly requested paid generation
shared/types.ts         shared item and asset types
data/items.json         published collection
data/demo.json          free import examples
public/items/<id>/      primary.png, ref-N.jpg, optional model.glb
tests/                  unit/integration and headless browser checks
docs/polish-notes.md    ranked critique, iteration notes and remaining limitations
```

Product photos and models derived from them belong to their respective owners.
