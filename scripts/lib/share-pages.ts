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
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { slugsFor } from '../../shared/slug.ts';
import { shopText, titleWithoutBrand } from '../../shared/text.ts';
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
  const facts = [item.brand, [item.price, item.domain].filter(Boolean).join(' at ')].filter(Boolean).join(' · ');
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
      `<meta property="og:image:alt" content="${esc(meta.image.alt)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
    );
  } else {
    tags.push(`<meta name="twitter:card" content="summary" />`);
  }
  if (!/<title>[^<]*<\/title>/.test(template) || !template.includes('</head>')) throw new Error('index.html has no <title> or </head>');
  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title)} · Things</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(meta.description)}" />`)
    .replace('</head>', `    ${tags.join('\n    ')}\n  </head>`);
}

/** The share card for an item, if `npm run images` has made one (see tools/images/share.ts). */
function shareCard(publicDir: string, heroBase: string | undefined): string | null {
  const m = heroBase?.match(/^\/items\/([^/]+)\/2d\/hero\.([0-9a-f]+)$/);
  if (!m) return null;
  const rel = `/items/${m[1]}/share.${m[2]}.jpg`;
  return existsSync(path.join(publicDir, rel)) ? rel : null;
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
      const media = JSON.parse(await readFile(path.join(root, 'data', 'media.json'), 'utf8')) as Record<string, { hero?: { base: string } }>;
      const slugs = slugsFor(items);

      // The shelf itself: a description for previews, no picture.
      const about = template.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
      const shelfTags = [
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="Things" />`,
        `<meta property="og:title" content="Things" />`,
        `<meta property="og:description" content="${about}" />`,
        `<meta property="og:url" content="${esc(site)}/" />`,
      ];
      await writeFile(path.join(outDir, 'index.html'), template.replace('</head>', `  ${shelfTags.join('\n    ')}\n  </head>`));

      let pages = 0;
      for (const item of items) {
        const slug = slugs.get(item.id) ?? item.id;
        const card = shareCard(path.join(root, 'public'), media[item.id]?.hero?.base);
        const name = titleWithoutBrand(item.title, item.brand);
        const meta = metaFor(item, {
          url: `${site}/t/${encodeURIComponent(slug)}`,
          image: card ? { url: `${site}${card}`, width: 1200, height: 630, alt: [item.brand, name].filter(Boolean).join(' ') } : undefined,
        });
        const html = sharePage(template, meta);
        await mkdir(path.join(outDir, 't'), { recursive: true });
        for (const key of new Set([slug, item.id, ...(item.aliases ?? [])])) {
          await writeFile(path.join(outDir, 't', key), html);
          pages++;
        }
      }
      this.info?.(`${pages} share pages`);
    },
  };
}
