/**
 * @description `recentRelayWindow` is the long-horizon dedup behind the Claude
 * stale re-scrape flood fix (live incident 2026-06-10: a TUI re-render of an
 * hours-old ~1400-line diff was re-relayed to the topic as ~12 overlapping
 * chunks, because the per-poll set diff only knows the previous capture).
 *
 * Load-bearing assertions, in tradeoff order:
 *  - fresh output passes an empty/unrelated window BYTE-IDENTICAL (an
 *    over-eager filter would silently eat live agent output in production);
 *  - an incident-shaped re-render (scrolled/overlapping subset of an
 *    already-relayed chunk) filters to EMPTY — no emit at all;
 *  - a genuinely-new line mixed into such a redraw SURVIVES;
 *  - short lines are never recorded nor suppressed.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createRecentRelayWindow,
  getRelayDedupedChunk,
  buildRelayBlockSignature,
  checkIsDiffGutterLine,
  normalizeForComparison,
  relayDedupMinLineLength,
  relayWindowMaxLines,
  relayBlockSignatureMax,
} from '../utils/recentRelayWindow';

/** A substantial (≥ min length) line unique per index — diff-result shaped. */
const buildDiffLine = (lineNo: number): string =>
  `${lineNo.toString().padStart(4, ' ')} +  research note about telomere data, batch ${lineNo}`;

// ─── window primitives: record / lookup / evict / reset ──────────────────────

test('window: a recorded substantial line is found, an unknown one is not', () => {
  const relayWindow = createRecentRelayWindow();
  relayWindow.record('A substantial relayed line');
  assert.equal(relayWindow.checkHasLine('A substantial relayed line'), true);
  assert.equal(relayWindow.checkHasLine('A different substantial line'), false);
});

test('window: lookup matches across glyph/whitespace re-renders (normalization domain)', () => {
  // The window must live in the SAME normalization domain as the pane-set
  // diff: a tool line repainted with another state glyph or extra indent is
  // the same line.
  const relayWindow = createRecentRelayWindow();
  relayWindow.record('● Bash(yarn test) finished with exit code 0');
  assert.equal(relayWindow.checkHasLine('✓ Bash(yarn test) finished with exit code 0'), true);
  assert.equal(relayWindow.checkHasLine('   Bash(yarn test) finished with exit code 0  '), true);
  // The real-v2.1.177 `⏺` output bullet must normalize into the same domain.
  assert.equal(relayWindow.checkHasLine('⏺ Bash(yarn test) finished with exit code 0'), true);
});

test('window: lookup matches across markdown/wrapping re-renders (the 2026-06-15 re-emit)', () => {
  // Live re-emit: a scrolled-off line came back with different emphasis spans —
  // `the Claude *liveness loop* …` vs `the Claude *liveness* *loop* …` — and the
  // base normalization left them as DIFFERENT strings, so the window re-emitted
  // it. The coarser relay-dedup normalization must recognise the re-render.
  const relayWindow = createRecentRelayWindow();
  relayWindow.record('the Claude *liveness loop* (the 1-second heartbeat that re-shows working)');
  assert.equal(
    relayWindow.checkHasLine('the Claude *liveness* *loop* (the 1-second heartbeat that re-shows working)'),
    true,
    'emphasis-span variance must still dedup',
  );
  assert.equal(
    relayWindow.checkHasLine('the Claude   liveness loop   (the 1-second heartbeat that re-shows working)'),
    true,
    'whitespace/padding variance must still dedup',
  );
});

test('window: short lines are never recorded and never suppressed', () => {
  const relayWindow = createRecentRelayWindow();
  const shortLine = 'yes, done';
  assert.ok(normalizeForComparison(shortLine).length < relayDedupMinLineLength);
  relayWindow.record(shortLine);
  assert.equal(relayWindow.checkHasLine(shortLine), false);
});

test('window: oldest line evicts first once capacity is exceeded', () => {
  const relayWindow = createRecentRelayWindow(3);
  relayWindow.record([1, 2, 3].map(buildDiffLine).join('\n'));
  relayWindow.record(buildDiffLine(4));
  assert.equal(relayWindow.checkHasLine(buildDiffLine(1)), false, 'oldest must evict');
  assert.equal(relayWindow.checkHasLine(buildDiffLine(2)), true);
  assert.equal(relayWindow.checkHasLine(buildDiffLine(3)), true);
  assert.equal(relayWindow.checkHasLine(buildDiffLine(4)), true);
});

test('window: a line repeated within one chunk occupies one slot', () => {
  // Otherwise the FIFO and the Set desync and eviction breaks.
  const relayWindow = createRecentRelayWindow(3);
  relayWindow.record([buildDiffLine(1), buildDiffLine(1), buildDiffLine(2), buildDiffLine(3)].join('\n'));
  assert.equal(relayWindow.checkHasLine(buildDiffLine(1)), true, 'still fits in 3 slots');
  relayWindow.record(buildDiffLine(4));
  assert.equal(relayWindow.checkHasLine(buildDiffLine(1)), false);
  assert.equal(relayWindow.checkHasLine(buildDiffLine(4)), true);
});

test('window: reset forgets everything', () => {
  const relayWindow = createRecentRelayWindow();
  relayWindow.record(buildDiffLine(1));
  relayWindow.reset();
  assert.equal(relayWindow.checkHasLine(buildDiffLine(1)), false);
});

test('window: default capacity matches the named constant', () => {
  // Guard the incident sizing: ~1500 covers a ~1400-line stale diff.
  const relayWindow = createRecentRelayWindow();
  for (let lineNo = 1; lineNo <= relayWindowMaxLines + 1; lineNo += 1) {
    relayWindow.record(buildDiffLine(lineNo));
  }
  assert.equal(relayWindow.checkHasLine(buildDiffLine(1)), false, 'one over capacity evicts the first');
  assert.equal(relayWindow.checkHasLine(buildDiffLine(2)), true);
});

// ─── chunk filter: fresh output must survive ─────────────────────────────────

test('filter: fresh chunk passes an empty window byte-identical', () => {
  // THE production-safety property: until something was relayed and recorded,
  // the filter must be a perfect no-op on shaped getNewPaneContent output.
  const relayWindow = createRecentRelayWindow();
  const freshChunk = 'para1 line A long enough to be substantial\n  indented continuation of paragraph one\n\npara2 line long enough to be substantial';
  assert.equal(getRelayDedupedChunk(relayWindow, freshChunk), freshChunk);
});

test('filter: two different consecutive chunks both relay (normal flow regression)', () => {
  // Chunks are shaped like real `newPart` (getNewPaneContent trims the joined
  // chunk, so the first line carries no leading indent).
  const relayWindow = createRecentRelayWindow();
  const firstChunk = [1, 2, 3].map(buildDiffLine).join('\n').trim();
  const secondChunk = [4, 5, 6].map(buildDiffLine).join('\n').trim();

  assert.equal(getRelayDedupedChunk(relayWindow, firstChunk), firstChunk);
  relayWindow.record(firstChunk);
  assert.equal(getRelayDedupedChunk(relayWindow, secondChunk), secondChunk);
});

test('filter: empty chunk stays empty', () => {
  assert.equal(getRelayDedupedChunk(createRecentRelayWindow(), ''), '');
});

// ─── chunk filter: the incident shape ─────────────────────────────────────────

test('filter: a scrolled/overlapping re-render of a recorded 60-line diff chunk filters to EMPTY', () => {
  // Incident shape: a ~60-line tool-result diff was relayed once; later the
  // TUI re-rendered the stale scrollback scrolled to another position (line
  // numbers jumping 21→1412→78→21), with state glyphs / indentation differing
  // from the original paint. Nothing of it may be re-relayed.
  const relayWindow = createRecentRelayWindow();
  const diffLines: string[] = [];
  for (let lineNo = 1; lineNo <= 60; lineNo += 1) diffLines.push(buildDiffLine(lineNo));
  const relayedChunk = diffLines.join('\n');
  relayWindow.record(relayedChunk);

  const redrawLines: string[] = [];
  for (let lineNo = 21; lineNo <= 55; lineNo += 1) {
    // Shifted subset + per-line render noise: glyph prefix, extra indent.
    redrawLines.push(lineNo % 2 === 0 ? `● ${buildDiffLine(lineNo)}` : `   ${buildDiffLine(lineNo)}`);
  }
  redrawLines.splice(10, 0, ''); // blank separators between dropped lines must not leak either
  assert.equal(getRelayDedupedChunk(relayWindow, redrawLines.join('\n')), '');
});

test('filter: a genuinely-new line mixed into the redraw SURVIVES', () => {
  const relayWindow = createRecentRelayWindow();
  const relayedChunk = Array.from({ length: 60 }, (_, index) => buildDiffLine(index + 1)).join('\n');
  relayWindow.record(relayedChunk);

  const genuinelyNewLine = 'Готово: добавил сводку источников в конец файла';
  const redrawWithNewLine = [
    buildDiffLine(21),
    buildDiffLine(22),
    genuinelyNewLine,
    buildDiffLine(23),
    buildDiffLine(24),
  ].join('\n');
  assert.equal(getRelayDedupedChunk(relayWindow, redrawWithNewLine), genuinelyNewLine);
});

test('filter: short lines inside a redraw are never suppressed', () => {
  const relayWindow = createRecentRelayWindow();
  const shortLine = '- done';
  relayWindow.record([buildDiffLine(1), shortLine, buildDiffLine(2)].join('\n'));

  const redraw = [buildDiffLine(1), shortLine, buildDiffLine(2)].join('\n');
  assert.equal(getRelayDedupedChunk(relayWindow, redraw), shortLine);
});

// ─── S2: short diff-gutter CHANGE lines bypass the length gate ───────────────

test('S2: checkIsDiffGutterLine matches "+"-led gutters, not numbered/"-"-led prose', () => {
  assert.equal(checkIsDiffGutterLine('40 +'), true, 'bare "NN +" gutter');
  assert.equal(checkIsDiffGutterLine('51 + считает полноценными'), true, '"NN +" with content (normalized key)');
  assert.equal(checkIsDiffGutterLine('42 +-'), true, '"NN +-" replace marker');
  // NOT a "+"-led diff gutter — must stay prose so it is never short-suppressed.
  assert.equal(checkIsDiffGutterLine('404 - Not Found'), false, '"-"-led prose (the reviewed-out FP)');
  assert.equal(checkIsDiffGutterLine('65 - old line'), false, 'pure "-" deletion gutter is OUT of scope');
  assert.equal(checkIsDiffGutterLine('1. Первый пункт плана'), false, 'numbered list item');
  assert.equal(checkIsDiffGutterLine('2024 was the year'), false, 'numbered prose');
  assert.equal(checkIsDiffGutterLine('66  ## Структура'), false, 'context row is not a CHANGE gutter');
  assert.equal(checkIsDiffGutterLine('done'), false, 'short confirmation');
});

test('S2: a SHORT diff-gutter line IS recorded and suppressed (the live 12238 leak)', () => {
  // Pre-fix the bare `40 +` (< the 16-char gate) bypassed the window entirely and
  // re-emitted on every scrollback re-render. The gutter shape is never legit
  // repeated prose, so it is recorded/suppressed even short.
  const relayWindow = createRecentRelayWindow();
  const shortGutter = '40 +';
  assert.ok(
    normalizeForComparison(shortGutter).length < relayDedupMinLineLength,
    'the gutter is below the normal length gate',
  );
  assert.equal(relayWindow.checkHasLine(shortGutter), false, 'unseen gutter is new');
  relayWindow.record(shortGutter);
  assert.equal(relayWindow.checkHasLine(shortGutter), true, 'the re-rendered gutter is now suppressed');
});

test('S2: a SHORT non-gutter line is STILL never recorded nor suppressed (no regression)', () => {
  // The S2 bypass is "+"-led-gutter-shape-specific — short prose still always passes,
  // including short "-"-led numbered prose (the reviewed-out over-suppression case).
  const relayWindow = createRecentRelayWindow();
  for (const shortProse of ['- done', '2 - yes', '8 - bit']) {
    relayWindow.record(shortProse);
    assert.equal(relayWindow.checkHasLine(shortProse), false, `short prose "${shortProse}" never suppressed`);
  }
});

test('S2: glyph-led gutter records + suppresses across the normalization domain (Finding 5)', () => {
  // record('⏺ 40 +') and lookup of the plain '40 +' must agree — the gutter verdict
  // is decided on the NORMALIZED key (leading glyph stripped), one domain for both.
  const relayWindow = createRecentRelayWindow();
  relayWindow.record('⏺ 40 +');
  assert.equal(relayWindow.checkHasLine('40 +'), true, 'plain re-render of the glyph-led gutter is suppressed');
});

test('S2: getRelayDedupedChunk drops a re-rendered SHORT gutter, keeps it the first time', () => {
  const relayWindow = createRecentRelayWindow();
  // First render: the bare gutter passes (not yet recorded), then is recorded.
  const firstRender = '40 +';
  assert.equal(getRelayDedupedChunk(relayWindow, firstRender), firstRender, 'first occurrence relays');
  relayWindow.record(firstRender);
  // Scrollback re-render of the same gutter → suppressed to empty.
  assert.equal(getRelayDedupedChunk(relayWindow, firstRender), '', 're-rendered gutter is dropped');
});

test('S2: two DIFFERENT short gutters both pass (only an exact re-render is dropped)', () => {
  const relayWindow = createRecentRelayWindow();
  relayWindow.record('40 +');
  // A different line number is a different key → not suppressed.
  assert.equal(relayWindow.checkHasLine('41 +'), false, 'a different gutter line is new');
  // A "-"-led line is not a "+"-led gutter at all → short gate applies → not suppressed.
  assert.equal(relayWindow.checkHasLine('40 -'), false, 'a "-"-led short line is not gutter-suppressed');
});

// ─── chunk filter: blank-line shaping (same shape as getNewPaneContent) ──────

test('filter: keeps one separator between surviving paragraphs, drops blanks at dropped lines', () => {
  const relayWindow = createRecentRelayWindow();
  relayWindow.record(`${buildDiffLine(1)}\n${buildDiffLine(2)}`);

  const mixedChunk = [
    buildDiffLine(1), // dropped
    '',
    'new paragraph one, substantial line',
    '',
    '',
    'new paragraph two, substantial line',
    buildDiffLine(2), // dropped
    '',
  ].join('\n');
  // The blank after the dropped head line must not leak as a leading blank;
  // the double blank collapses to one separator; the trailing blank vanishes.
  assert.equal(
    getRelayDedupedChunk(relayWindow, mixedChunk),
    'new paragraph one, substantial line\n\nnew paragraph two, substantial line',
  );
});

// ─── block-level dedup: the box-table flood guard (2026-06-16) ────────────────

/**
 * The flood shape: a Claude TUI box-drawing table re-printed byte-identically
 * ~500 times. Its individual lines (border rows `├──┤`, tiny cells `│ ✅ │`)
 * are mostly UNDER the per-line min length, so `checkHasLine` could never catch
 * it — only the whole-block signature can. These tests anchor that.
 */
const boxTableBlock = [
  '⏺ ┌────┬──────────────┬────┐',
  '│ #  │ Check        │ OK │',
  '├────┼──────────────┼────┤',
  '│ 1  │ login        │ ✅ │',
  '│ 2  │ logout       │ ✅ │',
  '│ 3  │ refresh      │ ⏳ │',
  '└────┴──────────────┴────┘',
].join('\n');

test('block: an identical table block is recognised as already-relayed', () => {
  const relayWindow = createRecentRelayWindow();
  assert.equal(relayWindow.checkBlockAlreadyRelayed(boxTableBlock), false, 'unseen block must be new');
  relayWindow.record(boxTableBlock);
  assert.equal(relayWindow.checkBlockAlreadyRelayed(boxTableBlock), true, 're-printed identical block → already relayed');
});

test('block: a table whose individual lines are too short is STILL recognised as a duplicate', () => {
  // The load-bearing case: every line of this table is short (< the per-line min
  // length after normalization), so the per-line layer (checkHasLine) cannot
  // catch it — only the whole-block signature can.
  const tinyTable = ['┌──┬──┐', '│✅│⏳│', '├──┼──┤', '│1 │2 │', '└──┴──┘'].join('\n');
  const relayWindow = createRecentRelayWindow();
  relayWindow.record(tinyTable);
  // Per-line layer misses every short line…
  for (const line of tinyTable.split('\n')) {
    assert.equal(relayWindow.checkHasLine(line), false, 'short lines never match per-line');
  }
  // …but the block layer recognises the whole duplicate block.
  assert.equal(relayWindow.checkBlockAlreadyRelayed(tinyTable), true);
});

test('block: a CHANGED table (one cell flips ⏳→✅) is a different block → not suppressed', () => {
  const relayWindow = createRecentRelayWindow();
  relayWindow.record(boxTableBlock);
  const changedTable = boxTableBlock.replace('│ refresh      │ ⏳ │', '│ refresh      │ ✅ │');
  assert.notEqual(changedTable, boxTableBlock);
  assert.equal(
    relayWindow.checkBlockAlreadyRelayed(changedTable),
    false,
    'a genuine change is a new block and must still emit',
  );
});

test('block: a re-rendered table with different column widths (re-flow) still dedups', () => {
  // The TUI re-flows column widths as it repaints — the block signature drops
  // markdown/whitespace noise, but border widths differ by character, so a true
  // re-flow is a DIFFERENT block. We only claim byte-identical suppression here:
  // an identical re-print (same widths) dedups; a re-flow is intentionally a new
  // block (it carries genuinely new layout, and S1's stabilizer holds re-flows
  // until they settle so only the settled form reaches record()).
  const relayWindow = createRecentRelayWindow();
  relayWindow.record(boxTableBlock);
  // Same content, identical widths, only a state glyph on the bullet line and
  // surrounding whitespace differ — must still dedup (coarse normalization).
  const reRenderedSameWidth = boxTableBlock
    .replace('⏺ ┌', '● ┌')
    .split('\n')
    .map(line => `  ${line}  `)
    .join('\n');
  assert.equal(
    relayWindow.checkBlockAlreadyRelayed(reRenderedSameWidth),
    true,
    'a glyph/whitespace re-render of the same-width table must dedup',
  );
});

test('block: an empty / whitespace-only block is never treated as relayed', () => {
  const relayWindow = createRecentRelayWindow();
  relayWindow.record('   \n\n  ');
  assert.equal(relayWindow.checkBlockAlreadyRelayed(''), false);
  assert.equal(relayWindow.checkBlockAlreadyRelayed('   \n\n  '), false);
});

test('block: reset forgets recorded block signatures', () => {
  const relayWindow = createRecentRelayWindow();
  relayWindow.record(boxTableBlock);
  relayWindow.reset();
  assert.equal(relayWindow.checkBlockAlreadyRelayed(boxTableBlock), false);
});

test('block: oldest signature evicts once the block FIFO is full', () => {
  const relayWindow = createRecentRelayWindow();
  // Record one distinctive block, then flood past the signature cap with others.
  relayWindow.record(boxTableBlock);
  assert.equal(relayWindow.checkBlockAlreadyRelayed(boxTableBlock), true);
  for (let n = 0; n < relayBlockSignatureMax; n += 1) {
    relayWindow.record(`a distinct relayed block number ${n} with enough length to be real`);
  }
  assert.equal(
    relayWindow.checkBlockAlreadyRelayed(boxTableBlock),
    false,
    'the first block must have evicted past the signature cap',
  );
});

test('buildRelayBlockSignature: drops blanks and normalizes; same content → same signature', () => {
  const a = ['│ a │', '', '│ b │'].join('\n');
  const b = ['  │ a │  ', '│ b │'].join('\n');
  assert.equal(buildRelayBlockSignature(a), buildRelayBlockSignature(b));
  assert.equal(buildRelayBlockSignature('   \n  '), '', 'whitespace-only → empty signature');
});
