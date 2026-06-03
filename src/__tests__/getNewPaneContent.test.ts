/**
 * @description `getNewPaneContent` is the line-SET diff between two tmux pane
 * captures (Claude redraws the whole pane each poll, so only NEW lines should
 * be emitted). The bug it now fixes (B1): the previous version dropped EVERY
 * empty line, so a multi-paragraph answer reached Telegram with every
 * paragraph glued to the next — the `cleanOutput` C1 fix preserved blanks in
 * the full pane, but this delta path still stripped them.
 *
 * Load-bearing assertion: a blank line that sat BETWEEN two runs of new
 * content survives (`\n\n` present); leading/trailing blanks and blanks next
 * to suppressed duplicate lines do NOT leak out.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getNewPaneContent } from '../adapters/claudeCliAdapter';

test('getNewPaneContent: preserves a blank line between two new paragraphs', () => {
  const out = getNewPaneContent('seed line', 'seed line\npara1\n\npara2');
  assert.equal(out, 'para1\n\npara2');
  assert.ok(out.includes('\n\n'), 'paragraph separator must survive');
});

test('getNewPaneContent: keeps every separator in a multi-paragraph answer', () => {
  const out = getNewPaneContent(
    'seed',
    'seed\nP1 line A\nP1 line B\n\nP2 line\n\nP3 line',
  );
  assert.equal(out, 'P1 line A\nP1 line B\n\nP2 line\n\nP3 line');
});

test('getNewPaneContent: drops leading and trailing blank lines', () => {
  // The blank before para1 has no preceding emitted line; the trailing blank
  // is flushed only before a NEW line that never comes — both vanish.
  assert.equal(getNewPaneContent('x', 'x\n\npara1\n\n'), 'para1');
});

test('getNewPaneContent: a blank between two duplicate lines is not emitted', () => {
  // old has a,b; new redraws them with a blank between, then adds c. Only c is
  // new — the blank separated two suppressed lines, so it must not leak.
  assert.equal(getNewPaneContent('a\nb', 'a\n\nb\nc'), 'c');
});

test('getNewPaneContent: collapses multiple blank separators to one', () => {
  // Three blank lines between paragraphs → a single separator (the per-line
  // pending-blank only ever emits ONE blank before the next new line).
  assert.equal(
    getNewPaneContent('seed', 'seed\npara1\n\n\n\npara2'),
    'para1\n\npara2',
  );
});

test('getNewPaneContent: empty old returns the whole new content verbatim', () => {
  assert.equal(getNewPaneContent('', 'para1\n\npara2'), 'para1\n\npara2');
});

test('getNewPaneContent: identical content yields no delta', () => {
  assert.equal(getNewPaneContent('same\n\ntext', 'same\n\ntext'), '');
});

test('getNewPaneContent: a redrawn tool line with a changed glyph is deduped', () => {
  // `normalizeForComparison` strips the leading ●/○/⏳/✓ glyph, so the same
  // tool line repainted with a different state is NOT re-emitted; only the
  // genuinely new line is.
  assert.equal(getNewPaneContent('● Done', '✓ Done\nNew line'), 'New line');
});
