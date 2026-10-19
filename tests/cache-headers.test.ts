import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

interface Rule { source: string; headers: { key: string; value: string }[] }
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { headers: Rule[] };
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** A Vercel source (path-to-regexp: `:name` or `:name(regex)` segments) as a RegExp, for the shapes used here. */
function toRegExp(source: string): RegExp {
  let out = '';
  for (let i = 0; i < source.length; ) {
    if (source[i] === ':') {
      const name = /^:\w+/.exec(source.slice(i))![0];
      i += name.length;
      if (source[i] === '(') {
        let depth = 0, j = i;
        for (; j < source.length; j++) {
          if (source[j] === '\\') { j++; continue; }
          if (source[j] === '(') depth++;
          if (source[j] === ')' && --depth === 0) break;
        }
        out += `(${source.slice(i + 1, j)})`;
        i = j + 1;
      } else out += '([^/]+)';
    } else {
      out += source[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}

const immutable = vercel.headers
  .filter((r) => r.headers.some((h) => h.key.toLowerCase() === 'cache-control' && h.value === IMMUTABLE))
  .map((r) => toRegExp(r.source));
const isImmutable = (p: string) => immutable.some((re) => re.test(p));

function files(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel)).flatMap((n) => (statSync(path.join(dir, rel, n)).isDirectory() ? files(dir, `${rel}/${n}`) : [`${rel}/${n}`]));
}
const all = files('public');

test('hashed images are served immutable: every 2D cut-out and photo, share card and home card', () => {
  assert.ok(immutable.length >= 3);
  const hashed = all.filter((f) => /\/2d\/|\/share\.[0-9a-f]+\.jpg$|^\/og\//.test(f));
  assert.ok(hashed.length > 300, String(hashed.length));
  for (const f of hashed) assert.ok(isImmutable(f), f);
});

test('nothing without a content hash in its name is made immutable', () => {
  const plain = all.filter((f) => /\/(ref-\d+\.\w+|primary\.png|model\.glb)$|^\/favicon/.test(f));
  assert.ok(plain.length > 100);
  for (const f of plain) assert.ok(!isImmutable(f), f);
  for (const f of ['/', '/t/ugmonk-analog-complete-kit', '/index.html', '/items/x/2d/hero-960.webp', '/og/home.jpg']) assert.ok(!isImmutable(f), f);
});
