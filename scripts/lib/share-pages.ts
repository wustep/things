/**
 * One page per thing in the build, so a shared /t/<slug> link unfurls (iMessage, Slack, social)
 * with the thing's name, a line about it and its share card, instead of a bare "Things".
 *
 * Each page is the built index.html with the head's title and description swapped and Open Graph
 * tags added; the app itself is unchanged and routes from the URL as before.
 *
 * Each page is written as an extensionless file at exactly dist/t/<key>, so the host's filesystem
 * match for /t/<key> is exact (it is checked before the SPA rewrite; vercel.json sends it as HTML).
 * A key with no page (a thing since removed) falls through to the app, which says so. The item id
 * path (/t/<id>) gets the same page, since those links work too.
 *
 * Each thing's card (its cut-out on the shelf, with its maker and name; scripts/lib/og-card.ts) is
 * made here too, at dist/og/<id>.<hash>.jpg, the hash being of the image so a changed card is a new
 * URL. Cards are kept in node_modules/.cache/things-og by their inputs, so a rebuild only makes
 * the ones whose cut-out, name or drawing changed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { H, heroFile, itemCard, W, type Hero } from './og-card.ts';
import { slugsFor } from '../../shared/slug.ts';
import { plans, shopText, titleWithoutBrand, wholeDollars } from '../../shared/text.ts';
import type { Item } from '../../shared/types.ts';

export const SITE_URL = 'https://things.wustep.me';

export interface ShareMeta {
  title: string;
  description: string;
  url: string;
  image?: { url: string; width: number; height: number; alt: string };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Cut at a word boundary, with an ellipsis, so a preview never ends mid-word. */
export function clip(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6)).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** Markdown down to one plain line (for a note used as a description). */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What a preview says about a thing: maker, price and shop, then Stephen's note or the shop's words. */
export function metaFor(item: Item, opts: { url: string; image?: ShareMeta['image'] }): ShareMeta {
  const name = titleWithoutBrand(item.title, item.brand);
  // An app's plans read as a list here, so the " · " between facts stays the only dot.
  const price = item.price ? plans(wholeDollars(item.price)).join(', ') : undefined;
  const facts = [item.brand, item.platforms?.join(' and '), [price, item.domain].filter(Boolean).join(' at ')].filter(Boolean).join(' · ');
  const words = item.commentary?.trim() ? plain(item.commentary) : shopText(item.description) ?? '';
  return {
    title: name,
    description: clip([facts, words].filter(Boolean).join('. ')),
    url: opts.url,
    image: opts.image,
  };
}

/** The built index.html with a thing's head: title, description, canonical and Open Graph tags. */
export function sharePage(template: string, meta: ShareMeta): string {
  const tags = [
    `<link rel="canonical" href="${esc(meta.url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Things" />`,
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    `<meta property="og:url" content="${esc(meta.url)}" />`,
  ];
  if (meta.image) {
    tags.push(
      `<meta property="og:image" content="${esc(meta.image.url)}" />`,
      `<meta property="og:image:width" content="${meta.image.width}" />`,
      `<meta property="og:image:height" content="${meta.image.height}" />`,
      `<meta property="og:image:type" content="image/jpeg" />`,
      `<meta property="og:image:alt" content="${esc(meta.image.alt)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:image" content="${esc(meta.image.url)}" />`,
      `<meta name="twitter:image:alt" content="${esc(meta.image.alt)}" />`,
    );
  } else {
    tags.push(`<meta name="twitter:card" content="summary" />`);
  }
  tags.push(`<meta name="twitter:title" content="${esc(meta.title)}" />`, `<meta name="twitter:description" content="${esc(meta.description)}" />`);
  if (!/<title>[^<]*<\/title>/.test(template) || !template.includes('</head>')) throw new Error('index.html has no <title> or </head>');
  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title)} · Things</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(meta.description)}" />`)
    .replace('</head>', `    ${tags.join('\n    ')}\n  </head>`);
}

/** The shelf's own card (tools/images/home-card.ts, `npm run og`), if one has been made: /og/home.<hash>.jpg. */
export function homeCard(publicDir: string): string | null {
  const dir = path.join(publicDir, 'og');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((n) => /^home\.[0-9a-f]+\.jpg$/.test(n)).sort()[0];
  return f ? `/og/${f}` : null;
}

/** The home page's Open Graph tags: the shelf's description and, when there is one, its card. */
export function shelfTags(site: string, about: string, card: string | null): string[] {
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Things" />`,
    `<meta property="og:title" content="Things" />`,
    `<meta property="og:description" content="${about}" />`,
    `<meta property="og:url" content="${esc(site)}/" />`,
    `<meta name="twitter:description" content="${about}" />`,
  ];
  if (card) {
    tags.push(
      `<meta property="og:image" content="${esc(site + card)}" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:alt" content="Things on a lit shelf in a dark room" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:image" content="${esc(site + card)}" />`,
    );
  } else {
    tags.push(`<meta name="twitter:card" content="summary" />`);
  }
  return tags;
}

const sha = (b: Buffer | string) => createHash('sha1').update(b).digest('hex');
const OG_SOURCE = fileURLToPath(new URL('./og-card.ts', import.meta.url));

/** A thing's card, from the cache when its inputs (cut-out, label, the drawing code) are unchanged. */
async function cachedCard(cacheDir: string, publicDir: string, hero: Hero, label: { brand?: string; name: string }, drawing: string): Promise<Buffer> {
  const src = await readFile(heroFile(publicDir, hero));
  const key = sha(JSON.stringify([drawing, sha(src), hero.subject, label.brand ?? '', label.name]));
  const hit = path.join(cacheDir, `${key}.jpg`);
  if (existsSync(hit)) return readFile(hit);
  const jpg = await itemCard(src, hero, label);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(hit, jpg);
  return jpg;
}

export function thingsSharePages(): Plugin {
  let outDir = 'dist';
  let base = '/';
  let root = process.cwd();
  return {
    name: 'things-share-pages',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      base = config.base;
      root = config.root;
    },
    async closeBundle() {
      const site = (process.env.SITE_URL ?? SITE_URL).replace(/\/$/, '') + base.replace(/\/$/, '');
      const template = await readFile(path.join(outDir, 'index.html'), 'utf8');
      const items = JSON.parse(await readFile(path.join(root, 'data', 'items.json'), 'utf8')) as Item[];
      const media = JSON.parse(await readFile(path.join(root, 'data', 'media.json'), 'utf8')) as Record<string, { hero?: Hero }>;
      const slugs = slugsFor(items);

      // The shelf itself: its description and its own card (a few things on a lit shelf).
      const about = template.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
      const home = shelfTags(site, about, homeCard(path.join(root, 'public')));
      await writeFile(path.join(outDir, 'index.html'), template.replace('</head>', `  ${home.join('\n    ')}\n  </head>`));

      // Every thing's card, a few at a time (each one keeps sharp's threads busy).
      const publicDir = path.join(root, 'public');
      const cacheDir = path.join(root, 'node_modules', '.cache', 'things-og');
      const drawing = sha(await readFile(OG_SOURCE));
      await mkdir(path.join(outDir, 'og'), { recursive: true });
      const cards = new Map<string, string>();
      let made = 0;
      const queue = items.filter((item) => media[item.id]?.hero);
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          for (let item; (item = queue.shift()); ) {
            const jpg = await cachedCard(cacheDir, publicDir, media[item.id]!.hero!, { brand: item.brand, name: titleWithoutBrand(item.title, item.brand) }, drawing);
            const rel = `/og/${item.id}.${sha(jpg).slice(0, 8)}.jpg`;
            await writeFile(path.join(outDir, rel), jpg);
            cards.set(item.id, rel);
            made++;
          }
        }),
      );

      let pages = 0;
      for (const item of items) {
        const slug = slugs.get(item.id) ?? item.id;
        const card = cards.get(item.id);
        const name = titleWithoutBrand(item.title, item.brand);
        const meta = metaFor(item, {
          url: `${site}/t/${encodeURIComponent(slug)}`,
          image: card ? { url: `${site}${card}`, width: W, height: H, alt: [item.brand, name].filter(Boolean).join(' ') } : undefined,
        });
        const html = sharePage(template, meta);
        await mkdir(path.join(outDir, 't'), { recursive: true });
        for (const key of new Set([slug, item.id, ...(item.aliases ?? [])])) {
          await writeFile(path.join(outDir, 't', key), html);
          pages++;
        }
      }
      this.info?.(`${pages} share pages for ${items.length} things, ${made} cards`);
    },
  };
}

/**
 * `vite preview` serves the built site as the host does: a share page (an extensionless file at
 * dist/t/<key>) goes out as HTML, as vercel.json's header for /t/:key makes it there, so a shared
 * link opens the same way in the end-to-end tests as in production.
 */
export function thingsSharePagesPreview(): Plugin {
  return {
    name: 'things-share-pages-preview',
    apply: (_config, env) => !!env.isPreview,
    configurePreviewServer(server) {
      const base = server.config.base.replace(/\/$/, '');
      server.middlewares.use((req, res, next) => {
        const p = (req.url ?? '').split('?')[0];
        if (p.startsWith(`${base}/t/`)) res.setHeader('Content-Type', 'text/html; charset=utf-8');
        next();
      });
    },
  };
}
