/**
 * @description `getNewPaneContent` is the line-SET diff between two tmux pane
 * captures (Claude redraws the whole pane each poll, so only NEW lines should
 * be emitted). The bug it now fixes (B1): the previous version dropped EVERY
 * empty line, so a multi-paragraph answer reached Telegram with every
 * paragraph glued to the next — the `cleanOutput` C1 fix preserved blanks in
 * the full pane, but this delta path still stripped them.
 *
 * It returns `{ text, startsNewParagraph }`: INTERIOR blanks survive inline in
 * `text` (`\n\n` present); a LEADING blank (before the chunk's first new line)
 * is dropped from `text` — a fresh message must never start blank — and instead
 * reported via `startsNewParagraph` so the append JOIN can rebuild the separator
 * past the pipeline's trims. Pane-top padding (a leading blank with NO content
 * above) must NOT set the flag.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getNewPaneContent } from '../adapters/claudeCliAdapter';

test('getNewPaneContent: preserves a blank line between two new paragraphs', () => {
  const out = getNewPaneContent('seed line', 'seed line\npara1\n\npara2');
  assert.equal(out.text, 'para1\n\npara2');
  assert.ok(out.text.includes('\n\n'), 'paragraph separator must survive');
  // The first new line (para1) had no blank before it → not a paragraph start.
  assert.equal(out.startsNewParagraph, false);
});

test('getNewPaneContent: keeps every separator in a multi-paragraph answer', () => {
  const out = getNewPaneContent(
    'seed',
    'seed\nP1 line A\nP1 line B\n\nP2 line\n\nP3 line',
  );
  assert.equal(out.text, 'P1 line A\nP1 line B\n\nP2 line\n\nP3 line');
  assert.equal(out.startsNewParagraph, false);
});

test('getNewPaneContent: a new paragraph after a blank-after-content sets startsNewParagraph, text has NO leading blank', () => {
  // Poll N showed "seed line"; poll N+1 added a blank then a fresh paragraph.
  // The leading blank is the inter-paragraph break and must be reported
  // out-of-band — NOT carried as a leading blank in `text`.
  const out = getNewPaneContent('seed line', 'seed line\n\npara1');
  assert.equal(out.text, 'para1');
  assert.ok(!out.text.startsWith('\n'), 'text must never start with a blank');
  assert.equal(out.startsNewParagraph, true);
});

test('getNewPaneContent: a mid-paragraph continuation (no preceding blank) does NOT set startsNewParagraph', () => {
  // A single paragraph wrapped across two polls: the new line directly follows
  // the retained content with no blank — it must not gain a paragraph break.
  const out = getNewPaneContent('seed', 'seed\ncontinued line');
  assert.equal(out.text, 'continued line');
  assert.equal(out.startsNewParagraph, false);
});

test('getNewPaneContent: an interior blank within one chunk is preserved in text', () => {
  // Both paragraphs are new in THIS chunk — the blank between them is interior
  // and survives inline; the chunk itself does not start a new paragraph.
  const out = getNewPaneContent('seed', 'seed\npara1\n\npara2');
  assert.equal(out.text, 'para1\n\npara2');
  assert.equal(out.startsNewParagraph, false);
});

test('getNewPaneContent: a pane-top leading blank with no content above does NOT set startsNewParagraph', () => {
  // The old line is absent from the new pane (nothing retained), so the leading
  // blanks are pane-top padding — there is no paragraph above them to separate
  // from, so the flag stays false and the blank is dropped.
  const out = getNewPaneContent('oldonly', '\n\npara1');
  assert.equal(out.text, 'para1');
  assert.equal(out.startsNewParagraph, false);
});

test('getNewPaneContent: drops leading and trailing blank lines (sets the paragraph flag instead of a leading blank)', () => {
  // The blank before para1 sits AFTER retained content ("x"), so it is a real
  // paragraph break → reported out-of-band, not carried in `text`. The trailing
  // blank is flushed only before a NEW line that never comes — it vanishes.
  const out = getNewPaneContent('x', 'x\n\npara1\n\n');
  assert.equal(out.text, 'para1');
  assert.equal(out.startsNewParagraph, true);
});

test('getNewPaneContent: a blank between two duplicate lines is not emitted', () => {
  // old has a,b; new redraws them with a blank between, then adds c. Only c is
  // new — the blank separated two suppressed lines, so it must not leak, and c
  // directly follows retained content with no preceding blank.
  const out = getNewPaneContent('a\nb', 'a\n\nb\nc');
  assert.equal(out.text, 'c');
  assert.equal(out.startsNewParagraph, false);
});

test('getNewPaneContent: collapses multiple blank separators to one', () => {
  // Three blank lines between paragraphs → a single separator (the per-line
  // pending-blank only ever emits ONE blank before the next new line).
  const out = getNewPaneContent('seed', 'seed\npara1\n\n\n\npara2');
  assert.equal(out.text, 'para1\n\npara2');
  assert.equal(out.startsNewParagraph, false);
});

test('getNewPaneContent: empty old returns the whole new content verbatim', () => {
  const out = getNewPaneContent('', 'para1\n\npara2');
  assert.equal(out.text, 'para1\n\npara2');
  assert.equal(out.startsNewParagraph, false);
});

test('getNewPaneContent: identical content yields no delta', () => {
  const out = getNewPaneContent('same\n\ntext', 'same\n\ntext');
  assert.equal(out.text, '');
  assert.equal(out.startsNewParagraph, false);
});

test('getNewPaneContent: a redrawn tool line with a changed glyph is deduped', () => {
  // `normalizeForComparison` strips the leading ●/○/⏳/✓ glyph, so the same
  // tool line repainted with a different state is NOT re-emitted; only the
  // genuinely new line is.
  const out = getNewPaneContent('● Done', '✓ Done\nNew line');
  assert.equal(out.text, 'New line');
  assert.equal(out.startsNewParagraph, false);
});

// ─── B10 — already-sent answer re-emitted when a wrapped draft grows the box ──

test('getNewPaneContent: an already-sent line duplicated in the new pane is NOT re-emitted (B10)', () => {
  // Live trace (2026-06-04 13:57:54): a chunk of the previous, already-relayed
  // answer ("*Знания* *разложены* *по* *слоям*…") was re-emitted as fresh
  // output while the user typed a long wrapped draft. Mechanism: typing a draft
  // that wraps to several rows grows the input box; the viewport is fixed
  // height, so the transcript scrolls and tmux re-renders the lines straddling
  // the scrollback↔visible boundary TWICE in one capture. The previous
  // multiset diff suppressed only as many occurrences as `oldContent` had, so
  // the SECOND copy of the answer line counted as new and was re-sent.
  //
  // Observed transition: oldContent has the answer line ONCE (count 1); the new
  // capture shows it TWICE (count 2) plus the genuinely-new ❯ draft row. The
  // load-bearing assertion: the answer line (count 2 > 1) must NOT leak — only
  // the never-before-seen draft row is new.
  const answerLine =
    '● *Знания* *разложены* *по* *слоям* — от кросс-проектных правил до локального';
  const oldContent = [answerLine, '  состояния агента.', '', '❯'].join('\n');
  const newContent = [
    answerLine,
    '  состояния агента.',
    answerLine, // re-rendered duplicate straddling the scroll boundary
    '  состояния агента.',
    '',
    '❯ А ещё меня смущает',
  ].join('\n');
  // The draft row follows a blank that sits after retained content → the chunk
  // is reported as a paragraph start, but only the draft row survives in `text`.
  const out = getNewPaneContent(oldContent, newContent);
  assert.equal(out.text, '❯ А ещё меня смущает');
});

test('getNewPaneContent: scrollback growth still emits genuinely-new bottom lines', () => {
  // Guard the B10 fix against over-suppression: when real new output appears at
  // the bottom while older content scrolls up, the new lines (absent from
  // oldContent) must still be emitted. Only lines that were ALREADY present are
  // suppressed.
  const oldContent = ['line A', 'line B', 'line C'].join('\n');
  const newContent = ['line B', 'line C', 'line D', 'line E'].join('\n');
  const out = getNewPaneContent(oldContent, newContent);
  assert.equal(out.text, 'line D\nline E');
  assert.equal(out.startsNewParagraph, false);
});
