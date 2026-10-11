# Things

A quiet, dark shelf of objects. Each thing stands on a lit shelf at a believable size next to
the others, with a small tag on the edge below it. Open one to see it up close, with photos
from its shop, what it costs, a link back to where it came from, and Stephen's notes on it.

Things is a personal collection viewer: one `items.json`, one folder of images, no backend.

## Run it

```sh
npm install
npm run dev          # http://localhost:5173
```

The shelf shows everything in `data/items.json`, one case per `section` (Office, Home, Music, Misc),
packed into as many shelves as the window needs. Click a thing (or Tab to it and press Enter;
the arrow keys walk the shelf) to open it. In the detail view, ← and → (or a sideways swipe on a
phone) step through the collection, Esc goes back to the shelf, and the thumbnails switch between the cut-out and
the shop's own photos. With a mouse, click the big picture for a closer look and move to look
around (click again to leave); from the keyboard, Z zooms in and the arrows look around. Esc
always closes the view, zoomed or not.

Every thing has its own address, `/t/<maker-and-name>` (for example
`/t/ugmonk-analog-complete-kit`); the item id works too (`/t/ugmonk-5117191f`). Links can be
shared and reloaded, and Back returns to the shelf.

A shared link unfurls with the thing's name, a line about it (maker, price and shop, then the
note or the shop's words) and a share card: the cut-out standing on a shelf in the same dark
room. The build writes one page per thing for this (`scripts/lib/share-pages.ts`; the app inside
is the same), and `npm run images` makes the cards (`tools/images/share.ts`).

## Notes

Each item can carry a `commentary` field in `data/items.json`: Markdown (paragraphs, **bold**,
_italic_, links, lists, quotes, code). While `npm run dev` is running, the detail view has a
**Write a note** / **Edit note** button: write, press ⌘↵ (or **Save note**), and the note is saved
straight into `data/items.json` (the dev server writes it; nothing else in the file changes).
Clearing a note removes the field. The built site shows notes read-only, and things without one
say so quietly.

Re-ingesting a thing with `--force` keeps its note.

## Add things

```sh
npm run ingest -- https://example.com/some-product
npm run ingest -- https://a.com/x https://b.com/y      # several at once
npm run ingest -- data/demo.json                        # a batch file
npm run images                                          # then give new things their 2D cut-outs
```

Ingest fetches the page, reads its product metadata (JSON-LD, Open Graph, site-specific
fallbacks) and downloads the product photos. While `npm run dev` is running you can also
**paste or drop a URL onto the page**: the dev server runs the same ingest and, when the image
tool is installed (below), builds the new thing's cut-out too, and the shelf updates in place.
A production build has no server.

A few things keep that honest on real shops:

- **Full-size photos.** Shopify CDN links lose their `?width=` / `_600x600` hints and Amazon's
  SL1500 gallery images are preferred, so a photo arrives as it was uploaded, not as a theme
  thumbnail.
- **Shopify fallback.** When a `/products/<handle>` page comes back thin (client-rendered
  theme, bot wall, no images, title or price), ingest asks the shop's public product JSON at
  `<product-url>.js`, then `.json`, and fills in only what the page was missing. Shopify
  doesn't reliably say which currency it means there, so no price is guessed from it.
- **Quieter retry.** Some bot walls reject a full browser header set coming from Node but let
  a plain request through; a 403 page fetch is retried once that way.
- **Transparency is kept.** A primary image that already has a real alpha channel keeps it.
- **Download limits.** Pages and product JSON are capped at 6 MB, each image at 24 MB, and
  the 20 s timeout covers the whole body, so a CDN that stalls fails instead of hanging the run.

Every ingest writes:

- `data/items.json`, the collection (imported by the viewer, so it ships in the build)
- `media/originals/<id>/ref-N.<ext>`, the photos exactly as the shop served them, plus
  `sources.json` (where each came from). Kept in the repo, never deployed.
- `public/items/<id>/ref-N.jpg` and `primary.png`, the 1200px copies and quick keyed cut-out
  (the 3D archive uses these, and the shelf falls back to `primary.png` until `npm run images`
  has run)

Files are built in a staging folder and swapped in only once the whole ingest succeeded, so a
`--force` that fails halfway (the shop now blocks you, no usable images) leaves everything as
it was.

```sh
npm run ingest -- --list                       # what's on the shelf
npm run ingest -- --remove <id-or-url>         # take something off (deletes its files)
npm run ingest -- --force <url>                # re-ingest an existing item (keeps its note)
npm run ingest -- --originals [<id> ...]       # re-download full-size originals only
npm run ingest -- --max-refs 2 <url>           # keep fewer photos
npm run ingest -- --parallel 4 batch.json      # work on four entries at once
```

`--originals` touches nothing but `media/originals/<id>/`. When a shop now blocks automated
requests, the photos already on disk become that item's originals (marked as such).

Batch files are a JSON array of URLs or objects. Objects can override what the page says and
add what it doesn't know:

```json
{
  "url": "https://...",
  "title": "...", "brand": "...", "price": "...",
  "section": "Office",
  "image": "https://.../primary.jpg",
  "images": ["https://.../another-angle.jpg"]
}
```

`section` groups things on the shelf. `image` is used as the primary photo and `images` add
more; both are tried before anything the page declares (handy for pinning one variant, as
`samples/2026-10-additions.json` does for the small metal Nelson lamp). `maxRefs` caps that
entry's photos, so a variant can keep only its own (the charcoal Perch, the white-oak Sway). When the brand is known
it is stripped from the title ("Simplehuman 60L Trash Can" becomes "60L Trash Can" under a
Simplehuman line) so the tag never says it twice. Items are identified by a stable id derived
from the URL (tracking parameters are ignored; Amazon URLs collapse to their ASIN).

## The 2D image set

```sh
npm run images                 # every item whose photo, picks or the pipeline changed
npm run images -- <id> ...     # just these
npm run images -- --force      # everything
```

`tools/images/build.ts` turns one photo per thing into a cut-out that sits with the others:

1. **Background removal.** The photo's own transparency when it has some; otherwise
   [BiRefNet_HR](https://github.com/ZhengPeng7/BiRefNet) (MIT), run locally with onnxruntime-node
   at its native 2048² so legs, cords and strap loops keep their width. The edge is then refined
   at up to 3072 px with a colour guided filter on a band around the silhouette (it follows the
   photo's own edge; inside and outside the band the model's matte stands), stray specks are
   dropped, and the object's own colour is estimated in the transition band (multi-level
   foreground estimation, as in pymatting) so the studio backdrop mixed into edge pixels is taken
   out instead of glowing on the dark page. Everything is scaled down to the output sizes only
   after that.
2. **Colour.** A gentle white balance on neutral pixels (±6% at most, so walnut stays walnut),
   one common white point with a soft shoulder, and the deepest blacks lifted a touch so a black
   mouse keeps its shape on a dark shelf.
3. **Framing.** Trimmed to the object, then the same padding ratio around every one. No shadow
   is baked in; things sit straight on the shelf.
4. **Formats.** AVIF and WebP at 480, 960 and 1600 px wide (never upscaled), with content-hashed
   names. Gallery photos stay photographs, at 640 and 1280.

Which photo is used, and which others go in the gallery, is chosen in `data/photos.json`:

```json
"remsen-f65a1f42": { "hero": "ref-6.jpg", "gallery": ["ref-5.jpg", "ref-7.jpg"] },
"jamescookartworkshop-b0e89a91": { "hero": { "file": "ref-1.jpg", "mode": "photo" } },
"roli-0e3366f5": { "hero": { "file": "ref-2.jpg", "holes": true } }
```

`mode: "photo"` keeps the picture as a rectangle (flat art, or a shop that only has a room
shot); `crop` is `[left, top, width, height]` in fractions. `matte` picks the model:
`"general"` (the default, BiRefNet_HR-general: solid, crisp edges) or `"matting"`
(BiRefNet_HR-matting: real partial alpha, for clear acrylic and glass, such as the record stand). `lay: true` is for rugs: the photo is the rug from straight above, and it is
laid down on the shelf in perspective (seen from the same low three-quarter angle as the furniture
shots, with a sliver of pile along the near edge), so a rug reads as a rug lying on the shelf rather
than a poster standing on it. `frame: true` puts flat art (a print) into a thin black frame that
stands on the shelf like any other object. `holes` keys out backdrop the model
left inside or between parts of the object:

- `true`: anything within a few levels of the backdrop colour (an open frame on a dark object;
  it would eat a white one).
- `"exact"`: only sizeable patches that are the backdrop colour itself, so a white object on a
  white backdrop keeps its body (the Tower hamper's X-frame and base bars).
- `"clear"`: clear acrylic or glass on white; each pixel's distance from the backdrop becomes its
  opacity, on top of the model's matte (the record stand).
- `"grow"`: a backdrop in shade, such as the gap between two cards; the cleared backdrop spreads
  into shaded pixels of the same hue that change only gradually (the card bar).
- `"fill"`: the other way round: clear patches the backdrop can't reach from the photo's edge
  become solid again, for light parts the model keyed out inside the object (the kalimba's chrome
  tines over white).

`floor: [[x, y], ...]` traces the object's bottom edge, left to right, in fractions of the photo,
and clears everything below it: a floor reflection under a base seen at an angle, which a
rectangular crop can't take off without clipping the base (the kalimba).

Every cut-out also has its edges defringed: sharpened shop photos leave a ring lighter than the
backdrop around the object, so an edge pixel lighter than the object just inside it takes the
inside colour. Results land in
`public/items/<id>/2d/` and `data/media.json` (sizes, the object's box inside the image, its
average colour for placeholders), which the viewer imports.

The tool is its own small package (`tools/images/package.json`) so its ONNX runtime never lands in
the app's install or the deploy; `npm run images` installs it on first use. Each model is a release
asset of ZhengPeng7/BiRefNet `v1`, pinned in `tools/images/matte.ts` by file size and SHA-256
(`BiRefNet_HR-general-epoch_130.onnx`, `BiRefNet_HR-matting-epoch_135.onnx`, about 1.1 GB each),
downloaded once into `tools/images/.cache` (git-ignored) only when an item needs it. Runs on the
CPU, about half a minute per cut-out. No paid APIs, no keys.

### Size

Things keep a believable relative size: `data/sizes.json` holds each one's largest real
dimension in cm, and the shelf scales by its square root (a sofa is still the biggest thing on
the shelf; a mouse is about a third of it rather than a sixteenth). Anything not listed stands
at the median size.

## The 3D archive (`/3d`)

The earlier three.js shelf, with Meshy models, still lives at **`/3d`** (`3d/index.html`,
`src/3d/`). Nothing in the 2D app links to it. It is built and deployed with the site, and the
2D page never downloads three.js: the two pages are separate Vite entries that share only the
collection data.

The 3D pipeline is kept intact for it:

- `npm run ingest -- --mesh <url>` / `--remesh <url>` make a model with
  [Meshy](https://www.meshy.ai) multi-image-to-3D (paid; needs `MESHY_API_KEY` in `.env`, see
  `.env.example`). Without one of those flags Meshy is never called, even with a key set. Models
  are slimmed to roughly 1 MB on the way in, and `asset.refs` records which photos they came from.
  `meshTask` in a batch entry attaches a task that already finished instead of paying again.
- `npm run refine` evens out Meshy's patchy texture atlases locally (island brightness smoothing,
  black lift, roughness floor, `glass` for acrylic); per-item settings in `data/mesh-finish.json`.
- In the archive: drag to orbit, scroll to zoom, hover or tap for a card, click to open the shop;
  `?procedural` shows every thing's fallback shape. Things without a model (the newest ones)
  stand as cut-out cards.

## Build and deploy

```sh
npm run typecheck
npm test             # ingest, extraction and notes-rendering tests (node --test via tsx)
npm run build        # dist/: the 2D site at /, the 3D archive at /3d/
npm run preview      # serve dist/ locally
```

The ingest tests serve fake product pages and images from a local HTTP server, run the real CLI
against a temp folder (`THINGS_ROOT`), and preload `tests/helpers/no-paid-network.ts`, which
blocks any request to Meshy, so they never touch the network or spend credits.

`dist/` is a fully static site: the collection is bundled in and images are copied from
`public/`. Deploy it anywhere that serves static files and can fall back to `index.html`
for `/t/...` addresses.

- **Vercel**: `vercel.json` is included (Vite preset, `dist` output; `/3d` goes to the archive,
  everything else that isn't a file to the 2D app).
- **Sub-path hosting** (GitHub Pages and the like): `BASE_PATH=/things/ npm run build`.

The build has no server. Add things and write notes locally, commit `data/`, `media/` and
`public/items/`, and redeploy.

## Layout

```
index.html              the 2D app
src/                    viewer
  main.ts               boot, routing (/t/<slug>), view transitions, paste-to-ingest, HMR
  shelf.ts              cases, shelf packing, real-size scaling, tags, keyboard walk
  detail.ts             one thing up close: gallery, facts, notes (and the dev note editor)
  media.ts              data/media.json, <picture> sources, real sizes
  markdown.ts           the small, escaping Markdown renderer for notes
  route.ts              slugs and paths
  commentary-client.ts  saving notes through the dev server
  style.css, fonts.ts   the look (Spectral + IBM Plex Mono, self-hosted)
  data.ts, sections.ts  the collection and its sections (shared with the 3D archive)
3d/index.html, src/3d/  the archived three.js shelf at /3d
scripts/ingest.ts       CLI ingest
scripts/lib/            fetch, extract, images (keying, hashing, palette), asset, meshy, glb,
                        refine, store (staged writes), dev-ingest (Vite dev server: ingest, notes, /3d)
tools/images/           npm run images: the 2D cut-outs (its own package)
shared/                 Item types and the brand-once title rule
data/items.json         the collection
data/photos.json        which photo each thing is shown with
data/media.json         generated by npm run images
data/sizes.json         real sizes
media/originals/<id>/   untouched shop photos (not deployed)
public/items/<id>/      deployed images: 2d/ for the shelf, the rest for the 3D archive
samples/                batch files (the Moonsift collection, the October 2026 additions)
tests/                  node --test suite
```

Product images belong to their respective owners; `npm run ingest -- --remove <id>` clears any
of them.
