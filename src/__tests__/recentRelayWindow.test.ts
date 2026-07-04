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

test('normalizeForComparison: a leading ANIMATED spinner glyph is stripped so re-animation dedups (S1)', () => {
  // The live flood 2026-07-04: a stable line re-painted with a different spinner
  // frame (`✻`→`✽`→`·`) looked NEW to the line-SET diff and re-emitted per frame.
  // Every animation glyph must normalize to the SAME key so the diff sees it as
  // unchanged. The full set: ✻ ✽ ✶ ✢ · * plus the ● ○ bullet states.
  const body = 'Reticulating splines across the manifold';
  const glyphVariants = ['✻', '✽', '✶', '✢', '·', '*', '●', '○'].map(g => `${g} ${body}`);
  const normalized = glyphVariants.map(normalizeForComparison);
  for (const n of normalized) assert.equal(n, body, 'every spinner glyph must strip to the same key');
  // And the bullet/tool STATE glyphs still normalize together (⏺/⏳/✓).
  assert.equal(normalizeForComparison('⏺ Read(x)'), normalizeForComparison('✓ Read(x)'));
  assert.equal(normalizeForComparison('⏳ Read(x)'), normalizeForComparison('✓ Read(x)'));
});

test('normalizeForComparison: prose without a leading glyph is unchanged (comparison-only, never eats content)', () => {
  // The nuance guard: only a LEADING glyph is stripped, and only for the equality
  // key — real prose (even prose that merely contains a glyph mid-line) is intact.
  assert.equal(normalizeForComparison('The quick brown fox'), 'The quick brown fox');
  assert.equal(normalizeForComparison('a · b · c mid-line dots'), 'a · b · c mid-line dots');
  assert.equal(normalizeForComparison('  indented prose  '), 'indented prose');
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

// ─── short `+`-gutter re-render dedup (the 2026-06-24 diff-line leak) ──────────

/**
 * Live bug (topic my-health, Claude scrape backend): a file-diff `NN +` change
 * gutter line (well under the 16-char per-line gate) scrolled off and was
 * RE-SCRAPED on a later poll, re-emitted as fresh output, and prepended onto the
 * next real message (`40 +`, `63 + …`, stray short tokens). The fix (S2-only):
 * the window records + suppresses a re-appearing `+`-led `NN +` gutter EVEN below
 * the gate — but ONLY on re-appearance, NEVER the first emit, NEVER a `-`-gutter
 * or any other short prose.
 */

test('gutter: a short `+`-led `NN +` gutter is recorded despite being under the per-line gate', () => {
  const relayWindow = createRecentRelayWindow();
  const gutter = '40 +';
  // It is genuinely short — the regular gate would skip it.
  assert.ok(normalizeForComparison(gutter).length < relayDedupMinLineLength);
  // First appearance is never suppressed…
  assert.equal(relayWindow.checkHasLine(gutter), false, 'first emit must not be suppressed');
  relayWindow.record(gutter);
  // …but after recording, a re-appearance IS suppressed.
  assert.equal(relayWindow.checkHasLine(gutter), true, 're-appearing gutter must be suppressed');
});

test('gutter: a `+`-gutter with trailing content is deduped on re-appearance, not first emit', () => {
  const relayWindow = createRecentRelayWindow();
  const gutter = '63 + research note about telomere data';
  // (This one happens to be long, but the rule applies to short ones too.)
  assert.equal(relayWindow.checkHasLine(gutter), false);
  relayWindow.record(gutter);
  assert.equal(relayWindow.checkHasLine(gutter), true);
});

test('gutter: a `-`-led deletion gutter is NEVER recorded nor suppressed (only `+` change gutters)', () => {
  const relayWindow = createRecentRelayWindow();
  const minusGutter = '40 -';
  relayWindow.record(minusGutter);
  assert.equal(relayWindow.checkHasLine(minusGutter), false, '`-` gutters stay outside the short-line dedup');
});

test('gutter: a legit short prose confirmation is never treated as a gutter', () => {
  // "done", "yes" etc. must keep repeating freely — the short-line bypass is
  // strictly the `NN +` diff-gutter shape, never short prose.
  const relayWindow = createRecentRelayWindow();
  for (const shortProse of ['done', 'yes', 'ok', '3 lines changed', '+1 done']) {
    relayWindow.record(shortProse);
    assert.equal(relayWindow.checkHasLine(shortProse), false, `"${shortProse}" must never be suppressed`);
  }
});

test('filter: a re-appearing short `+`-gutter is dropped from a later chunk, first emit passes', () => {
  // End-to-end through the chunk filter the live relay actually calls: the first
  // chunk carries the gutter + the prose answer and passes byte-identical; a
  // later chunk that re-renders the gutter glued to a NEW prose answer drops the
  // gutter but keeps the new prose (the answer is never swallowed).
  const relayWindow = createRecentRelayWindow();
  const firstChunk = ['40 +', '63 +', 'First answer, long enough to be substantial prose'].join('\n');
  assert.equal(getRelayDedupedChunk(relayWindow, firstChunk), firstChunk, 'first emit passes whole');
  relayWindow.record(firstChunk);

  const laterChunk = ['40 +', '63 +', 'Second answer, also long enough substantial prose'].join('\n');
  assert.equal(
    getRelayDedupedChunk(relayWindow, laterChunk),
    'Second answer, also long enough substantial prose',
    're-rendered gutters dropped, the new prose answer survives',
  );
});
