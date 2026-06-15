/**
 * @description S1 streaming-table stabilizer (live incident 2026-06-11, plan
 * `2026-06-11-claude-wide-table-content-loss`).
 *
 * A wide markdown table the Claude TUI renders RE-FLOWS its column widths as
 * longer cells stream in, so every border/row line is byte-distinct between
 * layouts. {@link getNewPaneContent} is a line-SET diff, so it classifies the
 * whole table "new" on EVERY poll → before this fix the table shipped once per
 * intermediate layout (empty skeleton → 1 row → full), and the final full frame
 * was often dropped under the coalescer debounce / a 429 (the user saw an empty
 * skeleton or a 1-row fragment, never the complete table).
 *
 * These tests replay the real re-flow capture sequence through the REAL
 * `getNewPaneContent` + the new pure stabilization helpers
 * ({@link getLastSharpTableBlock}, {@link getTableStabilizationDecision},
 * {@link maskSharpTableLines}) + the REAL fence path
 * ({@link stripTuiElementsWithContext}), exactly as `pollOutput` wires them, and
 * assert EXACTLY ONE emit, byte-equal to the complete fenced table, with every
 * row present and NO empty-skeleton / partial frame.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getNewPaneContent,
  getLastSharpTableBlock,
  getTableStabilizationDecision,
  maskSharpTableLines,
  stripTuiElementsWithContext,
} from '../adapters/claudeCliAdapter';

/**
 * The assistant-output bullet Claude's real TUI (v2.1.177) prints on the table's
 * TOP border (`⏺ ┌…`, U+23FA). The pre-2026-06-15 fixtures used NO bullet, so the
 * `SHARP_TABLE_TOP_RE` bullet-prefix branch was never exercised and the live bug
 * (top border `⏺`-led → not matched → table never collected → wide rows dropped
 * by the >50-char chrome filter) shipped green. These fixtures now carry the real
 * glyph; a parallel `●` set (the older bullet) proves BOTH variants are detected.
 */
const outputBullet = '⏺';

/** Pane capture 1: the empty skeleton — borders only, narrowest layout. */
const captureSkeleton = [
  'Вот план:',
  '',
  `${outputBullet} ┌──┬────┬────┐`,
  '│# │План│Суть│',
  '├──┼────┼────┤',
  '└──┴────┴────┘',
].join('\n');

/** Pane capture 2: wider columns, the first data row has streamed in. */
const captureOneRow = [
  'Вот план:',
  '',
  `${outputBullet} ┌──┬───────────┬─────────┐`,
  '│# │ План      │ Суть    │',
  '├──┼───────────┼─────────┤',
  '│3 │ row 3     │ deet 3  │',
  '└──┴───────────┴─────────┘',
].join('\n');

/**
 * Pane capture 3: the FULL table — widest columns, all three data rows — with a
 * spinner footer below it (the TUI keeps repainting the spinner/footer after the
 * table finished painting, so `content` keeps changing while the TABLE BLOCK
 * within it stays identical — this is what makes case B fire in production).
 */
const captureFull = [
  'Вот план:',
  '',
  `${outputBullet} ┌──┬────────────────────┬──────────────┐`,
  '│# │ План               │ Суть         │',
  '├──┼────────────────────┼──────────────┤',
  '│3 │ row 3 content      │ detail 3     │',
  '│4 │ row 4 content      │ detail 4     │',
  '│5 │ row 5 content      │ detail 5     │',
  '└──┴────────────────────┴──────────────┘',
  '✻ Brewing… (3s · 1.2k tokens)',
].join('\n');

/** Capture 4: byte-identical table, only the spinner footer ticked on — the
 *  table block is now stable across two polls, so case B emits it once. */
const captureFullSettled = [
  'Вот план:',
  '',
  `${outputBullet} ┌──┬────────────────────┬──────────────┐`,
  '│# │ План               │ Суть         │',
  '├──┼────────────────────┼──────────────┤',
  '│3 │ row 3 content      │ detail 3     │',
  '│4 │ row 4 content      │ detail 4     │',
  '│5 │ row 5 content      │ detail 5     │',
  '└──┴────────────────────┴──────────────┘',
  '✻ Brewing… (4s · 1.3k tokens)',
].join('\n');

/**
 * The full table block alone (what the stabilizer must emit), borders + rows,
 * carrying the same `⏺ ` top-border bullet the captures do — so the byte-equal
 * assertion runs the bullet-strip path on both sides (the strip turns `⏺ ` into a
 * two-space indent on the top border; see {@link ASSISTANT_BULLET_PREFIX_RE}).
 */
const fullTableBlock = [
  `${outputBullet} ┌──┬────────────────────┬──────────────┐`,
  '│# │ План               │ Суть         │',
  '├──┼────────────────────┼──────────────┤',
  '│3 │ row 3 content      │ detail 3     │',
  '│4 │ row 4 content      │ detail 4     │',
  '│5 │ row 5 content      │ detail 5     │',
  '└──┴────────────────────┴──────────────┘',
].join('\n');

/** Same FULL pane as {@link captureFull} but with the OLDER `●` bullet on the top
 *  border — proves the detector accepts both assistant-output glyphs. */
const captureFullDotBullet = captureFull.replace(`${outputBullet} ┌`, '● ┌');
const captureFullSettledDotBullet = captureFullSettled.replace(`${outputBullet} ┌`, '● ┌');

/** A `│ … │` content/header/separator row count helper (load-bearing assertion). */
function countTableRows(text: string): number {
  return text.split('\n').filter(line => /│/.test(line)).length;
}

/**
 * Faithful mini-driver: replay a sequence of pane captures through the exact
 * pipeline `pollOutput` runs for the table path, collecting every `output` emit
 * (prose deltas AND stabilized table blocks, each already fenced). Mirrors the
 * adapter: per poll compute the diff, run the stabilization decision on the FULL
 * pane, mask table lines out of the prose delta, emit a settled block via the
 * fence path, and emit the (masked) prose delta separately.
 */
function replayPoll(captures: string[]): { proseEmits: string[]; tableEmits: string[] } {
  let lastContent = '';
  let streamingTable: ReturnType<typeof getTableStabilizationDecision>['nextStreamingTable'] = null;
  const proseEmits: string[] = [];
  const tableEmits: string[] = [];

  for (const content of captures) {
    if (content === lastContent) continue;
    const diff = getNewPaneContent(lastContent, content);
    lastContent = content;

    const decision = getTableStabilizationDecision({
      currentTable: getLastSharpTableBlock(content),
      streamingTable,
    });
    streamingTable = decision.nextStreamingTable;

    let prose = diff.text;
    if (decision.kind !== 'none') prose = maskSharpTableLines(prose);
    if (decision.kind === 'emit' && decision.block) {
      const fenced = stripTuiElementsWithContext(decision.block).text;
      if (fenced) tableEmits.push(fenced);
    }
    // The adapter only emits prose when it survives the chrome strip; the
    // surrounding "Вот план:" prose is the only non-table content here.
    const strippedProse = stripTuiElementsWithContext(prose).text;
    if (strippedProse) proseEmits.push(strippedProse);
  }

  return { proseEmits, tableEmits };
}

test('table reflow: a settled table (seen twice) emits EXACTLY ONCE, complete', () => {
  // skeleton → 1 row → full → full (the last unchanged poll is what marks the
  // table "settled" — case B). Three intermediate layouts, ONE final emit.
  const { tableEmits } = replayPoll([
    captureSkeleton,
    captureOneRow,
    captureFull,
    captureFullSettled,
  ]);

  assert.equal(tableEmits.length, 1, `expected ONE table emit, got ${tableEmits.length}`);
  const emitted = tableEmits[0];

  // Byte-equal to the complete fenced table (same fence path as the inline path).
  assert.equal(emitted, stripTuiElementsWithContext(fullTableBlock).text);

  // Every row present: the full table has 6 `│`-rows (header + separator + 3
  // data rows + ... actually header(1) + 3 data = 4 content rows, plus the
  // separator `├─┼─┤` which also contains no `│`). Count `│`-bearing lines.
  const fullRowCount = countTableRows(fullTableBlock);
  assert.equal(countTableRows(emitted), fullRowCount, 'all table rows must survive');
  assert.ok(emitted.includes('row 3 content'), 'row 3 must be present');
  assert.ok(emitted.includes('row 4 content'), 'row 4 must be present');
  assert.ok(emitted.includes('row 5 content'), 'row 5 must be present');
});

// Both assistant-output bullets the live TUI prints on a table's top border are
// detected, emitted once, complete, and identically (this is the regression the
// 2026-06-15 glyph fix closes: a `⏺`-led top border was never matched, so the
// whole wide table was dropped — the no-bullet-only fixtures hid it).
for (const { glyph, settledCapture } of [
  { glyph: outputBullet, settledCapture: captureFullSettled },
  { glyph: '●', settledCapture: captureFullSettledDotBullet },
] as const) {
  test(`table reflow: a "${glyph}"-bulleted top border is detected and emitted complete`, () => {
    // The bulleted top border MUST be recognised as a table start.
    assert.ok(
      getLastSharpTableBlock(settledCapture) !== null,
      `"${glyph} ┌…" top border must be detected as a sharp table`,
    );

    const fullCapture = glyph === outputBullet ? captureFull : captureFullDotBullet;
    const { tableEmits } = replayPoll([
      captureSkeleton,
      captureOneRow,
      fullCapture,
      settledCapture,
    ]);

    assert.equal(tableEmits.length, 1, `expected ONE table emit, got ${tableEmits.length}`);
    const emitted = tableEmits[0];
    // The strip path turns the bullet into a uniform indent, so BOTH glyphs emit
    // byte-identically to the canonical `⏺`-topped block — every row complete.
    assert.equal(emitted, stripTuiElementsWithContext(fullTableBlock).text);
    assert.equal(countTableRows(emitted), countTableRows(fullTableBlock), 'all table rows must survive');
    assert.ok(emitted.includes('row 3 content'), 'row 3 must be present');
    assert.ok(emitted.includes('row 4 content'), 'row 4 must be present');
    assert.ok(emitted.includes('row 5 content'), 'row 5 must be present');
  });
}

test('table reflow: NO empty-skeleton or partial frame is ever emitted', () => {
  const { tableEmits } = replayPoll([
    captureSkeleton,
    captureOneRow,
    captureFull,
    captureFullSettled,
  ]);
  const all = tableEmits.join('\n---\n');
  // The empty skeleton has the narrow `│План│Суть│` header with no spaces; the
  // 1-row layout has `row 3     │ deet 3` — neither must appear in any emit.
  assert.ok(!all.includes('│План│Суть│'), 'empty-skeleton header must never ship');
  assert.ok(!all.includes('deet 3'), 'the intermediate 1-row layout must never ship');
});

test('table reflow: surrounding prose still streams (only the table waits)', () => {
  const { proseEmits } = replayPoll([
    captureSkeleton,
    captureOneRow,
    captureFull,
    captureFullSettled,
  ]);
  // "Вот план:" is prose above the table — it must reach the topic promptly on
  // the first poll, NOT be held with the table.
  assert.ok(
    proseEmits.some(emit => emit.includes('Вот план:')),
    'leading prose must stream even while the table is held',
  );
  // And the prose emits must NOT contain any table line.
  for (const emit of proseEmits) {
    assert.ok(!/[┌├└│]/.test(emit), `prose emit leaked a table line: ${JSON.stringify(emit)}`);
  }
});

test('table reflow: a table followed by prose flushes the held table once (case C)', () => {
  // The pane moves on to more prose with the table scrolled out of the capture
  // window before it ever repeated identically → case C flushes the last held
  // version exactly once (never lost).
  const proseAfter = [
    'Позже добавлю детали.',
    '',
    'Рекомендация: начать с пункта 3.',
  ].join('\n');
  const { tableEmits } = replayPoll([
    captureSkeleton,
    captureOneRow,
    captureFull,
    proseAfter,
  ]);
  assert.equal(tableEmits.length, 1, 'the held table must flush exactly once on case C');
  assert.ok(tableEmits[0].includes('row 5 content'), 'the flushed table is the full version');
});

test('table reflow: a table that freezes the pane is flushed on the idle poll (case B)', () => {
  // Models the adapter's idle-poll path: the table paints (hold), then the pane
  // goes byte-IDENTICAL (the change branch would not re-run, but the idle-flush
  // consults the stabilizer). currentTable == held block → case B emits once.
  // Without the idle flush this table would be held forever (silent drop).
  const tableBlock = getLastSharpTableBlock(captureFull)!;
  // Poll N: table painted, still laying out → held.
  const hold = getTableStabilizationDecision({ currentTable: tableBlock, streamingTable: null });
  assert.equal(hold.kind, 'hold');
  // Poll N+1: pane frozen, same table block → the idle flush emits it.
  const idle = getTableStabilizationDecision({
    currentTable: tableBlock,
    streamingTable: hold.nextStreamingTable,
  });
  assert.equal(idle.kind, 'emit');
  assert.equal(idle.block, tableBlock);
  assert.equal(idle.nextStreamingTable, null);
  assert.ok(stripTuiElementsWithContext(idle.block!).text.includes('row 5 content'));
});

test('getLastSharpTableBlock: returns null when no sharp table is present', () => {
  assert.equal(getLastSharpTableBlock('just prose\nno table here'), null);
});

test('getLastSharpTableBlock: returns the LAST table when two are present', () => {
  const twoTables = [
    '┌──┬──┐',
    '│a │b │',
    '└──┴──┘',
    'between',
    '┌───┬───┐',
    '│cc │dd │',
    '└───┴───┘',
  ].join('\n');
  const block = getLastSharpTableBlock(twoTables);
  assert.ok(block !== null);
  assert.ok(block!.includes('cc'), 'must return the second (last) table');
  assert.ok(!block!.includes('│a '), 'must not return the first table');
});

test('maskSharpTableLines: drops only table lines, keeps prose', () => {
  const mixed = ['prose before', '┌──┬──┐', '│a │b │', '└──┴──┘', 'prose after'].join('\n');
  assert.equal(maskSharpTableLines(mixed), 'prose before\nprose after');
});

test('getTableStabilizationDecision: case A holds and advances heldPolls', () => {
  const first = getTableStabilizationDecision({ currentTable: 'T1', streamingTable: null });
  assert.equal(first.kind, 'hold');
  assert.deepEqual(first.nextStreamingTable, { block: 'T1', heldPolls: 1 });

  const second = getTableStabilizationDecision({
    currentTable: 'T2',
    streamingTable: first.nextStreamingTable,
  });
  assert.equal(second.kind, 'hold');
  assert.deepEqual(second.nextStreamingTable, { block: 'T2', heldPolls: 2 });
});

test('getTableStabilizationDecision: case B emits when the block is stable', () => {
  const held = { block: 'T', heldPolls: 1 };
  const decision = getTableStabilizationDecision({ currentTable: 'T', streamingTable: held });
  assert.equal(decision.kind, 'emit');
  assert.equal(decision.block, 'T');
  assert.equal(decision.nextStreamingTable, null);
});

test('getTableStabilizationDecision: case C flushes the held block when the table is gone', () => {
  const held = { block: 'T', heldPolls: 3 };
  const decision = getTableStabilizationDecision({ currentTable: null, streamingTable: held });
  assert.equal(decision.kind, 'emit');
  assert.equal(decision.block, 'T');
  assert.equal(decision.nextStreamingTable, null);
});

test('getTableStabilizationDecision: no table and nothing held is a no-op', () => {
  const decision = getTableStabilizationDecision({ currentTable: null, streamingTable: null });
  assert.equal(decision.kind, 'none');
  assert.equal(decision.nextStreamingTable, null);
});

test('getTableStabilizationDecision: SAFETY force-emits a never-settling table past the cap', () => {
  // A pane stuck re-flowing forever must never swallow the table: once heldPolls
  // would exceed the cap, the latest version is force-emitted.
  let held: { block: string; heldPolls: number } | null = null;
  let emitted: string | null = null;
  for (let poll = 0; poll < 40; poll++) {
    const decision = getTableStabilizationDecision({
      // a different block every poll → never byte-stable (case A forever)
      currentTable: `T${poll}`,
      streamingTable: held,
    });
    held = decision.nextStreamingTable;
    if (decision.kind === 'emit') {
      emitted = decision.block;
      break;
    }
  }
  assert.ok(emitted !== null, 'the safety cap must force-emit a never-settling table');
});
