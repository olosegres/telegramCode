/**
 * @description Plan §2026-05-30 tg-html-output / S1. Agent output must reach
 * Telegram as real HTML: fenced code → `<pre><code>`, inline → `<code>`,
 * `*bold*` / `**bold**` → `<b>`, `# headings` → `<b>`, links → `<a>`, and
 * `& < >` escaped. The load-bearing promise is that a ```` ```diff ```` chunk
 * renders as a monospaced block (NOT literal backticks in the message), that a
 * lone `*` / unpaired backtick no longer forces the whole message to plain
 * text, and that OpenCode's `**bold**` / `## heading` no longer leak raw
 * markdown (`*<b>bold</b>*`, literal `##`) into Telegram.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { renderAgentHtml, escapeHtmlText } from '../renderAgentHtml';

test('fenced block with a language tag → <pre><code class="language-...">, no literal backticks', () => {
  const input = '```diff\n- old line\n+ new line\n```';
  const out = renderAgentHtml(input);
  assert.equal(
    out,
    '<pre><code class="language-diff">- old line\n+ new line</code></pre>',
  );
  // The actual bug: backticks must NOT survive into the message.
  assert.ok(!out.includes('```'));
});

test('fenced block without a language tag → bare <pre><code>', () => {
  const out = renderAgentHtml('```\nplain\n```');
  assert.equal(out, '<pre><code>plain</code></pre>');
});

test('inline code → <code>', () => {
  assert.equal(renderAgentHtml('run `yarn test` now'), 'run <code>yarn test</code> now');
});

test('*bold* → <b>', () => {
  assert.equal(renderAgentHtml('this is *important* ok'), 'this is <b>important</b> ok');
});

test('**bold** → <b> with NO stray leading/trailing asterisk', () => {
  // Live OpenCode bug: the single-star matcher started at the 2nd `*` and left
  // `*<b>bold</b>*`. The double-star pass must consume BOTH asterisks.
  const out = renderAgentHtml('this is **important** ok');
  assert.equal(out, 'this is <b>important</b> ok');
  assert.ok(!out.includes('*'));
});

test('**a** and **b** → two separate <b> spans (non-greedy)', () => {
  // Greedy matching would swallow the gap and produce one span across both.
  assert.equal(renderAgentHtml('**a** and **b**'), '<b>a</b> and <b>b</b>');
});

test('## heading → <b>, no literal #', () => {
  const out = renderAgentHtml('## Section Title');
  assert.equal(out, '<b>Section Title</b>');
  assert.ok(!out.includes('#'));
});

test('# H1 and ###### H6 both → <b>', () => {
  assert.equal(renderAgentHtml('# H1'), '<b>H1</b>');
  assert.equal(renderAgentHtml('###### H6'), '<b>H6</b>');
});

test('non-ASCII heading → <b> (Cyrillic)', () => {
  assert.equal(renderAgentHtml('## Заголовок'), '<b>Заголовок</b>');
});

test('a # mid-line is NOT converted to a heading', () => {
  assert.equal(renderAgentHtml('issue #42 is open'), 'issue #42 is open');
});

test('heading inside a fenced code block stays literal (not converted)', () => {
  const out = renderAgentHtml('```\n## not a heading\n```');
  assert.equal(out, '<pre><code>## not a heading</code></pre>');
  assert.ok(out.includes('## not a heading'));
});

test('** inside inline code is NOT turned into <b>', () => {
  const out = renderAgentHtml('use `a ** b` here');
  assert.equal(out, 'use <code>a ** b</code> here');
  assert.ok(!out.includes('<b>'));
});

test('[text](url) → <a href>', () => {
  assert.equal(
    renderAgentHtml('see [docs](https://example.com/a)'),
    'see <a href="https://example.com/a">docs</a>',
  );
});

test('& < > escaped in prose', () => {
  assert.equal(renderAgentHtml('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
});

test('& < > escaped INSIDE a code span (only those three)', () => {
  const out = renderAgentHtml('`if (a < b && c > d)`');
  assert.equal(out, '<code>if (a &lt; b &amp;&amp; c &gt; d)</code>');
});

test('lone * stays literal (escaped prose, no <b>) — does not break the message', () => {
  // A single unpaired asterisk used to drop the whole message to plain text
  // under legacy Markdown. Under HTML it is simply inert.
  assert.equal(renderAgentHtml('2 * 3 = 6'), '2 * 3 = 6');
});

test('unpaired backtick stays literal', () => {
  assert.equal(renderAgentHtml('a single ` backtick'), 'a single ` backtick');
});

test('mixed prose + inline code + bold in one chunk', () => {
  const out = renderAgentHtml('Fix *now*: call `getThing()` before <render>');
  assert.equal(out, 'Fix <b>now</b>: call <code>getThing()</code> before &lt;render&gt;');
});

test('code-span content is shielded from bold/link substitution', () => {
  // Asterisks and bracket syntax inside code must NOT be turned into tags.
  const out = renderAgentHtml('`a * b` and `[x](y)`');
  assert.equal(out, '<code>a * b</code> and <code>[x](y)</code>');
});

test('href attribute guards a double-quote without double-escaping &', () => {
  const out = renderAgentHtml('[q](https://e.com/?a=1&b="2")');
  assert.equal(out, '<a href="https://e.com/?a=1&amp;b=&quot;2&quot;">q</a>');
});

test('a stray placeholder sentinel in agent output cannot forge a stashed span', () => {
  // `\x00N\x00` is the internal stash marker; a stray one (from a PTY encoding
  // glitch) must be stripped, never restored to a wrong span or to "undefined".
  const out = renderAgentHtml('```\nfirst\n```\nthen \x000\x00 tail');
  assert.equal(out, '<pre><code>first</code></pre>\nthen 0 tail');
  assert.ok(!out.includes('undefined'));
  assert.ok(!out.includes('\x00'));
});

test('fence info-string keeps only the first token as the language', () => {
  // Trailing metadata after the language token must not leak into the class.
  assert.equal(
    renderAgentHtml('```ts extra meta\ncode\n```'),
    '<pre><code class="language-ts">code</code></pre>',
  );
});

test('a double-quote in the language tag cannot break the class attribute', () => {
  const out = renderAgentHtml('```js"x\ncode\n```');
  assert.equal(out, '<pre><code class="language-js&quot;x">code</code></pre>');
});

test('escapeHtmlText handles the three specials and leaves the rest', () => {
  assert.equal(escapeHtmlText('a&b<c>d*e`f'), 'a&amp;b&lt;c&gt;d*e`f');
});
