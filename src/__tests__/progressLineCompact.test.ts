/**
 * @description `/compact` has a different progress shape than the thinking
 * spinner — a `Compacting conversation… N%` verb line plus a `▰▰▱▱` bar
 * line, with NO token stats. The original `PROGRESS_LINE_RE` matches neither,
 * so a `/compact` run used to flood the topic with one message per redraw,
 * each stacking every intermediate percentage.
 *
 * These cases pin the two halves of the fix:
 *  - `checkIsProgressChunk` now also accepts the compaction shape (anchored
 *    on a bar line so a real `●`-prefixed answer is never swallowed);
 *  - `collapseProgressChunk` trims a redraw burst down to its latest frame so
 *    the coalesced status message shows only the current percentage.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkIsProgressChunk, collapseProgressChunk } from '../progressLine';

// ─── checkIsProgressChunk: /compact positives ──────────────────────────

test('checkIsProgressChunk: single compaction frame (verb + bar)', () => {
  const frame = '✻ Compacting conversation… (22s)\n  ▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱ 22%';
  assert.equal(checkIsProgressChunk(frame), true);
});

test('checkIsProgressChunk: compaction frame before the timer starts', () => {
  const frame = '✶ Compacting conversation…\n  ▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 1%';
  assert.equal(checkIsProgressChunk(frame), true);
});

test('checkIsProgressChunk: bar-only redraw fragment', () => {
  // A scrape diff can land just the bar line with no verb above it.
  assert.equal(checkIsProgressChunk('  ▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱ 33%'), true);
});

test('checkIsProgressChunk: multi-frame compaction burst (the flood repro)', () => {
  // The exact shape that used to reach handleAgentOutput as "real content"
  // and post one message per redraw, each stacking more percentages.
  const burst = [
    '✻ Compacting conversation… (16s)',
    '  ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱ 17%',
    '✢ Compacting conversation… (17s)',
    '  ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱ 18%',
    '✶ Compacting conversation… (18s)',
    '  ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱ 19%',
  ].join('\n');
  assert.equal(checkIsProgressChunk(burst), true);
});

// ─── checkIsProgressChunk: /compact negatives ──────────────────────────

test('checkIsProgressChunk: real answer ending in an ellipsis is NOT compaction', () => {
  // `●` is in the glyph set and the line ends in `…`, but there is no bar
  // line to anchor it — must stay real content, not a transient status.
  assert.equal(checkIsProgressChunk('● Готово — продолжаю дальше…'), false);
});

test('checkIsProgressChunk: lone compaction verb line (no bar) is NOT progress', () => {
  // Without the bar anchor a single glyph+ellipsis line is too ambiguous to
  // collapse, so it falls through to the normal output path.
  assert.equal(checkIsProgressChunk('✶ Compacting conversation…'), false);
});

test('checkIsProgressChunk: prose that merely contains a bar line is NOT progress', () => {
  // The core safety property: a bar line is the anchor, but a chunk is only
  // collapsed when EVERY line is a bar/verb/tick. Real content alongside a
  // bar must keep the whole chunk on the normal output path so nothing is
  // swallowed into a transient (deletable) status message.
  const mixed = 'Here is the progress chart:\n▰▰▰▰▰▰▱▱▱▱ 50%\nand the rest of the answer.';
  assert.equal(checkIsProgressChunk(mixed), false);
});

test('checkIsProgressChunk: bar line with the percentage clipped off', () => {
  // A redraw scrape can land the bar before its trailing `N%`. It must still
  // count as progress so it never reaches the flooding output path.
  assert.equal(checkIsProgressChunk('✻ Compacting conversation… (5s)\n  ▰▰▰▰▰▰▱▱▱▱'), true);
});

// ─── collapseProgressChunk ─────────────────────────────────────────────

test('collapseProgressChunk: keeps only the last tick of a thinking burst', () => {
  const burst =
    '✽ Smooshing… (1m 48s · ↑ 3.3k tokens)\n✽ Smooshing… (1m 49s · ↑ 3.3k tokens)';
  assert.equal(collapseProgressChunk(burst), '✽ Smooshing… (1m 49s · ↑ 3.3k tokens)');
});

test('collapseProgressChunk: compaction burst → latest verb + highest-% bar', () => {
  const burst = [
    '✻ Compacting conversation… (16s)',
    '  ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱ 17%',
    '✢ Compacting conversation… (17s)',
    '  ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱ 18%',
    '✶ Compacting conversation… (18s)',
    '  ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱ 19%',
  ].join('\n');
  assert.equal(
    collapseProgressChunk(burst),
    '✶ Compacting conversation… (18s)\n▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱ 19%',
  );
});

test('collapseProgressChunk: picks highest % even when scrape is out of order', () => {
  // A terminal redraw scrape can land frames out of order; `%` only grows,
  // so the max is the true latest and the lower duplicates must vanish.
  const burst =
    '✻ Compacting conversation… (1m 22s)\n  ▰▰▰▰▰▰▰▰▱▱▱▱ 76%\n' +
    '· Compacting conversation… (1m 21s)\n  ▰▰▰▰▰▰▱▱▱▱▱▱ 60%';
  const collapsed = collapseProgressChunk(burst);
  assert.ok(collapsed.includes('76%'), 'keeps the highest percentage');
  assert.ok(!collapsed.includes('60%'), 'drops the lower percentage');
});

test('collapseProgressChunk: bar alone when no verb line is present', () => {
  assert.equal(
    collapseProgressChunk('  ▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱ 33%'),
    '▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱ 33%',
  );
});

test('collapseProgressChunk: orders percentage-clipped bars by filled-cell count', () => {
  // When the `N%` is clipped, the filled-cell (`▰`) count is the fallback
  // ordering key, so the fuller (later) bar still wins.
  const burst = '▰▰▰▱▱▱▱▱▱▱\n▰▰▰▰▰▰▰▱▱▱';
  assert.equal(collapseProgressChunk(burst), '▰▰▰▰▰▰▰▱▱▱');
});
