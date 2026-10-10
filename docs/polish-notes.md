# Things polish journal

## Baseline — 2026-10-10

Ran `npm install`, served Vite, and captured untouched 1440×1000 and 390×844 views plus hover, orbit and Office focus with headless Chrome. Clicked a real item and verified the outgoing Amazon URL. All 24 original items are preserved. Screenshots live in `~/Projects/things-pr-shots/before-*.png`.

Ranked reasons it feels unfinished:

1. **The collection is illegible on a phone.** All 24 models shrink into a narrow column; section navigation disappears exactly where it is most needed.
2. **Objects float without a convincing shelf or visual hierarchy.** Tiny gray chrome, harsh highlights, uneven model fidelity and sparse random dust make this feel like a rendering demo.
3. **Core actions are undiscoverable.** No visible add action, reset camera, view switch, search or collection controls. Desktop click immediately leaves the experience instead of letting you inspect an object.
4. **No usable collection management.** Sections, order and removals require editing JSON or a destructive CLI command. Keyboard and screen-reader users cannot reach items.
5. **Loading and failure are invisible.** The screen starts black; failed assets silently disappear; WebGL failure prevents the whole interface from booting.
6. **Ingest can destroy an existing asset before its replacement succeeds.** Paid Meshy generation is implicit when a key exists, errors lose detail, and common shop metadata/image handling needs real URL trials and regression tests.
7. **Motion and rendering run continuously.** Reduced motion still animates camera and entrances; hidden tabs and idle frames need attention.
8. **No automated regression suite or complete operational guide.** README describes a prototype and offers paid bulk rebuilds too casually.

## Planned rounds

1. Make the shelf legible and intentional: scene, responsive composition, lighting, navigation, inspect and accessible catalog.
2. Complete collection and intake flows: add, sections/order/removal with undo, durable local persistence, honest loading/error/empty states, robust free ingest and tests.
3. Use and reassess the entire product: real shop trials, camera/touch/keyboard/production checks, visual refinements, performance, documentation and deployment verification.

Each round records evidence, reassessment and remaining gaps below.

## Round 1 — legibility and a real place for objects

Built a restrained graphite/sage interface with system grotesk typography, two rows of physical beveled shelves, balanced environment lighting, visible object labels and eight objects per desktop page / four per phone page. Sections now remain available on phones. Added catalog/search, in-app inspection, explicit external shop links, camera reset, keyboard item navigation and visible intake. The renderer pauses when idle/hidden and limits model loading to three concurrent requests; reduced-motion viewers get immediate camera transitions. A WebGL failure falls back to the catalog.

Validation: `npm run typecheck`, `npm run build`; headless Chrome at 1440×1000 and 390×844; inspect, catalog, shelf switching; no page exceptions or horizontal overflow. Reviewed screenshots in `/private/tmp/things-round1/`.

Reassessment: the phone is finally readable, but the bright shelves compete with objects and long labels need slightly more breathing room. The inspection panel and controls are now discoverable; persistence/undo and robust intake are the largest remaining gaps. The first real batch added Wingspan and TP–7, while Aesop and LEGO returned 403. The TP–7 price was incorrectly inferred from unrelated body text, so the next round must remove that heuristic and use product-scoped metadata.

## Round 2 — a collection you can actually maintain

Connected section creation/moves, ordering within sections, removal and persistent undo feedback. Local edits save the source JSON; static deployments keep an arrangement overlay in browser storage, so later published additions still appear. Added same-origin editing, shared validation, atomic writes and a cross-process collection lock. Failed `--force` ingests now stage assets before replacement. Paid generation requires explicit `--mesh`/`--remesh`; browser intake always passes `--no-mesh`.

Repaired nested product metadata, added Shopify product JSON fallback, removed the unrelated-body-price heuristic, bounded downloads (including slow response bodies), retained source alpha, removed matte fringes and protected against empty masks. Successful cutouts now remain silhouettes. The four live successes (Teenage Engineering, Stonemaier Games, Ugmonk and Amazon) are in New finds; Aesop and LEGO honestly report their HTTP 403. All 24 original item records and asset folders are preserved. Updated the demo batch and README to match tested behavior, and patched the two dependency advisories (`npm install` reports zero vulnerabilities).

Validation: 15 unit/integration tests cover real CLI ingestion against a local shop fixture, failed refresh byte preservation, mixed-batch exit status, locks, the actual local edit endpoint, transparent/white cutouts, metadata and browser arrangements. Production headless Chrome exercises real mesh hover/click, orbit, dialogs and focus, shop link, search, edits/undo/reload, phone/touch, empty/invalid-input states and WebGL fallback. Zero page exceptions and zero axe WCAG A/AA violations across desktop, detail, catalog, add, phone, phone detail and empty states.

Reassessment: the fundamental flows now work end to end. Remaining priorities are darkening the shelf materials, improving photo/image-failure presentation, verifying idle rendering and slow-load behavior, and reviewing final matched screenshots. Existing generated geometry still has rough areas; the original product photograph remains the reliable inspection reference. Static hosting deliberately cannot fetch new products server-side or sync arrangements between devices.

## Round 3 — final craft, resilience and preservation

Darkened the shelf surfaces and toned down lighting so objects carry the scene. Improved phone navigation so all three original sections fit, added contextual persistence/section hints and explicit image-failure placeholders, and made cutout picking respect transparency. The catalog no longer triggers model loading when filters change. Verified that the settled scene issues zero draw calls over an idle sample and that initial desktop loading requests only eight models. Slow-load, missing-model-and-image, reduced-motion touch, and no-WebGL paths all retain a usable collection.

Stephen clarified that the live shop trials must not ship. Moved those four trial products into `/private/tmp/things-ingest-fixture`, then removed only their newly created records/assets. `data/items.json` is identical to main and there is no final diff under `public/items/`. The real collection is the original 24 items, unchanged.

Final reassessment: the collection is readable at 390px, inspection and management are complete, important actions are discoverable, and errors are visible and recoverable. Remaining limitations are explicit product boundaries: some shops block automated imports; complex lifestyle photos are not semantically segmented; existing generated meshes can contain imperfect geometry; static arrangements stay in one browser and new imports require local development. None require a paid service to use the product. Physical-device Safari testing is still a follow-up; phone checks here use headless Chromium touch emulation.

Final verification: typecheck includes the regression tests; 15 unit/integration tests pass; production build passes; complete production browser suite reports zero exceptions, zero axe WCAG A/AA violations, zero idle draw calls, and eight initial model requests. Matching 1440×1000 and 390×844 before/after views plus hover, orbit, section, detail, catalog and failure states accompany the PR. Vercel preview status is recorded in the PR after deployment.
