import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../src/markdown.ts';

test('notes render the Markdown people actually write', () => {
  assert.equal(renderMarkdown('Bought it **twice**, _happily_.'), '<p>Bought it <strong>twice</strong>, <em>happily</em>.</p>');
  assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(renderMarkdown('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>');
  assert.equal(renderMarkdown('# Verdict'), '<h3>Verdict</h3>');
  assert.equal(renderMarkdown('line one\nline two\n\nnext'), '<p>line one<br>line two</p>\n<p>next</p>');
  assert.equal(renderMarkdown('> quoted'), '<blockquote><p>quoted</p></blockquote>');
  assert.equal(renderMarkdown('`a_b_c`'), '<p><code>a_b_c</code></p>');
});

test('links open safely and keep their underscores', () => {
  assert.equal(
    renderMarkdown('[review](https://example.com/a_b_c)'),
    '<p><a href="https://example.com/a_b_c" target="_blank" rel="noopener noreferrer">review</a></p>',
  );
  assert.match(renderMarkdown('see https://example.com/x.'), /<a href="https:\/\/example.com\/x"[^>]*>https:\/\/example.com\/x<\/a>\.<\/p>/);
});

test('notes can never inject markup or script links', () => {
  assert.equal(renderMarkdown('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.doesNotMatch(renderMarkdown('[click](javascript:alert(1))'), /<a|javascript:/);
  assert.equal(renderMarkdown('[click](javascript:void)'), '<p>click</p>');
  assert.doesNotMatch(renderMarkdown('[x](https://a.com/"onmouseover="alert(1))'), /"onmouseover/);
});
