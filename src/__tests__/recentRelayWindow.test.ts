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
  normalizeForComparison,
  relayDedupMinLineLength,
  relayWindowMaxLines,
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
