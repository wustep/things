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
