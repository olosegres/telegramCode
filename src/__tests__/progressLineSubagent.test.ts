/**
 * @description While a Task sub-agent runs, Claude's TUI redraws a
 * `◯ <type>  <title>  <elapsed> · ↓ <tokens>` line every second. The trailing
 * time/token counter changes each tick, so the pane diff sees every redraw as
 * a brand-new line and the topic floods with one message per second (the live
 * bug report: dozens of identical `◯ general-purpose  Move styles into
 * solClientKit  6m 29s · ↓ 119.2k tokens` lines, time ticking up).
 *
 * `SUBAGENT_PROGRESS_LINE_RE` catches the line (anchored on the `◯` U+25EF
 * sub-agent glyph, distinct from the `○`/`●` glyphs), `checkIsProgressChunk`
 * routes the burst into the rolling status message, and
 * `collapseProgressChunk` keeps only the latest frame of each distinct task
 * with the TUI padding squeezed out.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  SUBAGENT_PROGRESS_LINE_RE,
  checkIsProgressChunk,
  collapseProgressChunk,
} from '../progressLine';

// The real padded line from the bug log (padding shortened here; the count of
// spaces is irrelevant to the regex, only that it is a run of 2+).
const PADDED = '◯ general-purpose  Move styles into solClientKit                6m 50s · ↓ 120.2k tokens';

// ─── SUBAGENT_PROGRESS_LINE_RE ─────────────────────────────────────────

test('SUBAGENT_PROGRESS_LINE_RE: matches a task line with stats', () => {
  assert.ok(SUBAGENT_PROGRESS_LINE_RE.test(PADDED));
});

test('SUBAGENT_PROGRESS_LINE_RE: matches a task line before its timer shows', () => {
  assert.ok(SUBAGENT_PROGRESS_LINE_RE.test('◯ general-purpose  Move styles into solClientKit'));
});

test('SUBAGENT_PROGRESS_LINE_RE: matches the cursor-selected (❯) frame', () => {
  assert.ok(SUBAGENT_PROGRESS_LINE_RE.test('❯ ◯ general-purpose  Move styles into solClientKit                6m 50s · ↓ 120.2k tokens'));
});

test('SUBAGENT_PROGRESS_LINE_RE: does NOT match the ○ thinking spinner or ● bullet', () => {
  // `○` (U+25CB) is the spinner glyph, `●` (U+25CF) the tool/result bullet —
  // neither is a sub-agent task line and must not be swallowed.
  assert.equal(SUBAGENT_PROGRESS_LINE_RE.test('○ Thinking… (3s)'), false);
  assert.equal(SUBAGENT_PROGRESS_LINE_RE.test('● Bash(ls -la)'), false);
  assert.equal(SUBAGENT_PROGRESS_LINE_RE.test('● main                          ↑/↓ to select · Enter to view'), false);
});

// ─── checkIsProgressChunk ──────────────────────────────────────────────

test('checkIsProgressChunk: single sub-agent task line', () => {
  assert.equal(checkIsProgressChunk(PADDED), true);
});

test('checkIsProgressChunk: sub-agent redraw burst (the flood repro)', () => {
  const burst = [
    '◯ general-purpose  Move styles into solClientKit                6m 29s · ↓ 119.2k tokens',
    '◯ general-purpose  Move styles into solClientKit                6m 30s · ↓ 119.2k tokens',
    '◯ general-purpose  Move styles into solClientKit                6m 31s · ↓ 119.2k tokens',
    '◯ general-purpose  Move styles into solClientKit                6m 32s · ↓ 119.6k tokens',
  ].join('\n');
  assert.equal(checkIsProgressChunk(burst), true);
});

test('checkIsProgressChunk: parallel fan-out of several sub-agents', () => {
  const burst = [
    '◯ general-purpose  Move styles into solClientKit       1m 0s · ↓ 5.0k tokens',
    '◯ Explore  Find all call sites of renderAgentHtml       1m 0s · ↓ 3.0k tokens',
    '◯ general-purpose  Move styles into solClientKit       1m 1s · ↓ 6.0k tokens',
    '◯ Explore  Find all call sites of renderAgentHtml       1m 1s · ↓ 4.0k tokens',
  ].join('\n');
  assert.equal(checkIsProgressChunk(burst), true);
});

test('checkIsProgressChunk: a sub-agent line mixed with real prose is NOT progress', () => {
  const mixed = [
    PADDED,
    'Here is what the sub-agent found: the styles live in three files.',
  ].join('\n');
  assert.equal(checkIsProgressChunk(mixed), false);
});

// ─── collapseProgressChunk ─────────────────────────────────────────────

test('collapseProgressChunk: single sub-agent → latest frame, padding squeezed', () => {
  const burst = [
    '◯ general-purpose  Move styles into solClientKit                6m 29s · ↓ 119.2k tokens',
    '◯ general-purpose  Move styles into solClientKit                7m 0s · ↓ 120.7k tokens',
  ].join('\n');
  assert.equal(
    collapseProgressChunk(burst),
    '◯ general-purpose Move styles into solClientKit 7m 0s · ↓ 120.7k tokens',
  );
});

test('collapseProgressChunk: cursor hopping onto a task does NOT split it into two lines', () => {
  // The `❯` selection cursor moves on/off a task as the panel redraws; the
  // identity (and the rendered line) must ignore it, so one task stays one
  // rolling line regardless of selection state.
  const burst = [
    '◯ general-purpose  Move styles into solClientKit       6m 29s · ↓ 119.2k tokens',
    '❯ ◯ general-purpose  Move styles into solClientKit       6m 30s · ↓ 119.2k tokens',
    '◯ general-purpose  Move styles into solClientKit       6m 31s · ↓ 119.2k tokens',
  ].join('\n');
  assert.equal(
    collapseProgressChunk(burst),
    '◯ general-purpose Move styles into solClientKit 6m 31s · ↓ 119.2k tokens',
  );
});

test('collapseProgressChunk: parallel fan-out → one latest line per distinct task', () => {
  const burst = [
    '◯ general-purpose  Move styles into solClientKit       1m 0s · ↓ 5.0k tokens',
    '◯ Explore  Find all call sites of renderAgentHtml       1m 0s · ↓ 3.0k tokens',
    '◯ general-purpose  Move styles into solClientKit       1m 1s · ↓ 6.0k tokens',
    '◯ Explore  Find all call sites of renderAgentHtml       1m 1s · ↓ 4.0k tokens',
  ].join('\n');
  // First-seen order preserved; each task collapses to its latest tick.
  assert.equal(
    collapseProgressChunk(burst),
    '◯ general-purpose Move styles into solClientKit 1m 1s · ↓ 6.0k tokens\n' +
      '◯ Explore Find all call sites of renderAgentHtml 1m 1s · ↓ 4.0k tokens',
  );
});
