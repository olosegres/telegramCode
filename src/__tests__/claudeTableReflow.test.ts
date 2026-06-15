/**
 * @description S1 streaming-table stabilizer (live incidents 2026-06-11 +
 * 2026-06-15, plan `2026-06-11-claude-wide-table-content-loss`).
 *
 * A wide markdown table the Claude TUI renders RE-FLOWS its column widths as
 * longer cells stream in, so every border/row line is byte-distinct between
 * layouts. {@link getNewPaneContent} is a line-SET diff, so it classifies the
 * whole table "new" on EVERY poll → before the original fix the table shipped
 * once per intermediate layout (empty skeleton → 1 row → full), and the final
 * full frame was often dropped under the coalescer debounce / a 429.
 *
 * The 2026-06-15 refinement: the table is emitted ONLY when the turn is
 * genuinely DONE — real prose follows it, or the turn went idle, or the safety
 * cap fires. The old "byte-stable for one poll → emit" rule mistook a mid-stream
 * PAUSE (Claude briefly stalls at an intermediate row count, byte-stable across a
 * poll while still streaming) for "done": it shipped the 4-row intermediate, then
 * the table grew to 6 rows and shipped again → the topic got TWO tables. These
 * tests drive the pure {@link getTableStabilizationDecision} across a poll
 * timeline with the new {@link checkHasContentAfterLastSharpTable} +
 * `isTurnIdle` signals (the latter via the real {@link checkIsClaudeSessionBusy})
 * and assert the emit SEQUENCE: EXACTLY ONE table emit, byte-equal to the
 * complete fenced table, with every row present and NO intermediate frame.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getNewPaneContent,
  getLastSharpTableBlock,
  getTableStabilizationDecision,
  checkHasContentAfterLastSharpTable,
  checkIsClaudeSessionBusy,
  maskSharpTableLines,
  stripTuiElementsWithContext,
} from '../adapters/claudeCliAdapter';

/**
 * The assistant-output bullet Claude's real TUI (v2.1.177) prints on the table's
 * TOP border (`⏺ ┌…`, U+23FA). A parallel `●` set (the older bullet) proves BOTH
 * variants are detected (the 2026-06-15 glyph regression: a `⏺`-led top border
 * was once unmatched, dropping the whole wide table).
 */
const outputBullet = '⏺';

/**
 * The real Claude busy footer — a spinner tick line plus the bypass-permissions
 * row carrying `esc to interrupt`. Its presence is what {@link checkIsClaudeBusy}
 * (via {@link checkIsClaudeSessionBusy}) reads as "turn still running", and BOTH
 * lines are chrome that {@link checkHasContentAfterLastSharpTable} must NOT count
 * as content (spinner → `SPINNER_TICK_RE`; bypass row → `checkIsClaudeChromeLine`).
 */
const busyFooter = [
  '✻ Brewing… (3s · 1.2k tokens)',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n');

/** A pane whose turn has FINISHED: the input box is back, no `esc to interrupt`. */
const idleFooter = ['', '❯ ', '  ─────────────────────────────────────'].join('\n');

/** Append a footer to a table-bearing pane body. */
function withFooter(body: string[], footer: string): string {
  return [...body, footer].join('\n');
}

/** Pane capture: the empty skeleton — borders only, narrowest layout (busy). */
const captureSkeleton = withFooter(
  [
    'Вот план:',
    '',
    `${outputBullet} ┌──┬────┬────┐`,
    '│# │План│Суть│',
    '├──┼────┼────┤',
    '└──┴────┴────┘',
  ],
  busyFooter,
);

/** Pane capture: wider columns, the first data row has streamed in (busy). */
const captureOneRow = withFooter(
  [
    'Вот план:',
    '',
    `${outputBullet} ┌──┬───────────┬─────────┐`,
    '│# │ План      │ Суть    │',
    '├──┼───────────┼─────────┤',
    '│3 │ row 3     │ deet 3  │',
    '└──┴───────────┴─────────┘',
  ],
  busyFooter,
);

/** The 4-row layout the live table briefly PAUSED at (header + 1 data + 3 data).
 *  Used to model the mid-stream pause: this exact block repeats byte-identically
 *  across two polls while still busy — the old rule shipped it; the new rule
 *  holds it. */
const fourRowBody = [
  'Вот план:',
  '',
  `${outputBullet} ┌──┬────────────────────┬──────────────┐`,
  '│# │ План               │ Суть         │',
  '├──┼────────────────────┼──────────────┤',
  '│3 │ row 3 content      │ detail 3     │',
  '│4 │ row 4 content      │ detail 4     │',
  '└──┴────────────────────┴──────────────┘',
];
const captureFourRowBusy = withFooter(fourRowBody, busyFooter);

/** The FULL table — all THREE data rows (rows 3,4,5). The complete answer. */
const fullTableBody = [
  'Вот план:',
  '',
  `${outputBullet} ┌──┬────────────────────┬──────────────┐`,
  '│# │ План               │ Суть         │',
  '├──┼────────────────────┼──────────────┤',
  '│3 │ row 3 content      │ detail 3     │',
  '│4 │ row 4 content      │ detail 4     │',
  '│5 │ row 5 content      │ detail 5     │',
  '└──┴────────────────────┴──────────────┘',
];
const captureFullBusy = withFooter(fullTableBody, busyFooter);

/** The full table followed by REAL prose (the done-signal: content after table). */
const captureFullThenProse = withFooter(
  [...fullTableBody, '', 'Рекомендация: начать с пункта 3.'],
  idleFooter,
);

/**
 * The full table block alone (what the stabilizer must emit), carrying the same
 * `⏺ ` top-border bullet the captures do — so the byte-equal assertion runs the
 * bullet-strip path on both sides.
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

/** Same FULL pane but with the OLDER `●` bullet on the top border. */
const captureFullBusyDotBullet = captureFullBusy.replace(`${outputBullet} ┌`, '● ┌');
const captureFullThenProseDotBullet = captureFullThenProse.replace(`${outputBullet} ┌`, '● ┌');

/** A `│ … │` content/header/separator row count helper (load-bearing assertion). */
function countTableRows(text: string): number {
  return text.split('\n').filter(line => /│/.test(line)).length;
}

/**
 * Faithful mini-driver: replay a sequence of pane captures through the exact
 * pipeline `pollOutput` runs for the table path, collecting every `output` emit
 * (prose deltas AND stabilized table blocks, each already fenced). Mirrors the
 * adapter: per poll compute the diff, run the stabilization decision on the FULL
 * pane with the two done-signals (`hasContentAfterTable` from the real helper,
 * `isTurnIdle` from the real busy predicate — `isActive: true`, exactly as a live
 * poll), mask table lines out of the prose delta, emit a done block via the fence
 * path, and emit the (masked) prose delta separately. Unchanged polls are still
 * fed (an idle/frozen pane is the idle-flush path), so the SEQUENCE of table
 * emits is exactly what the topic would receive.
 */
function replayPoll(captures: string[]): { proseEmits: string[]; tableEmits: string[] } {
  let lastContent = '';
  let streamingTable: ReturnType<typeof getTableStabilizationDecision>['nextStreamingTable'] = null;
  const proseEmits: string[] = [];
  const tableEmits: string[] = [];

  for (const content of captures) {
    const isTurnIdle = !checkIsClaudeSessionBusy({ isActive: true, lastContent: content });
    const hasContentAfterTable = checkHasContentAfterLastSharpTable(content);

    // Idle-flush path: an unchanged poll still consults the stabilizer (a table
    // frozen on the pane is flushed only on a done-signal).
    if (content === lastContent) {
      if (!streamingTable) continue;
      const idle = getTableStabilizationDecision({
        currentTable: getLastSharpTableBlock(content),
        streamingTable,
        hasContentAfterTable,
        isTurnIdle,
      });
      streamingTable = idle.nextStreamingTable;
      if (idle.kind === 'emit' && idle.block) {
        const fenced = stripTuiElementsWithContext(idle.block).text;
        if (fenced) tableEmits.push(fenced);
      }
      continue;
    }

    const diff = getNewPaneContent(lastContent, content);
    lastContent = content;

    const decision = getTableStabilizationDecision({
      currentTable: getLastSharpTableBlock(content),
      streamingTable,
      hasContentAfterTable,
      isTurnIdle,
    });
    streamingTable = decision.nextStreamingTable;

    let prose = diff.text;
    if (decision.kind !== 'none') prose = maskSharpTableLines(prose);
    if (decision.kind === 'emit' && decision.block) {
      const fenced = stripTuiElementsWithContext(decision.block).text;
      if (fenced) tableEmits.push(fenced);
    }
    const strippedProse = stripTuiElementsWithContext(prose).text;
    if (strippedProse) proseEmits.push(strippedProse);
  }

  return { proseEmits, tableEmits };
}

test('table reflow: grows in stages (with a mid-stream pause) → EXACTLY ONE emit, complete', () => {
  // The live bug (2026-06-15): the table paints to 4 rows, PAUSES there for a
  // poll (byte-identical, still busy), then grows to 6 rows, then settles with
  // prose after it. The old "stable one poll → emit" rule shipped the 4-row
  // intermediate AND the full table (two tables); the done-based rule ships ONE.
  const { tableEmits } = replayPoll([
    captureSkeleton, //      hold (busy, no content after)
    captureOneRow, //        hold (block changed, busy)
    captureFourRowBusy, //   hold (block changed, busy)
    captureFourRowBusy, //   PAUSE: same 4-row block, still busy → STILL HOLD (was the bug)
    captureFullBusy, //      hold (grew to 6 rows, busy)
    captureFullThenProse, // DONE: prose now follows → emit the 6-row table once
  ]);

  assert.equal(tableEmits.length, 1, `expected ONE table emit, got ${tableEmits.length}`);
  const emitted = tableEmits[0];
  // Byte-equal to the complete fenced table (same fence path as the inline path).
  assert.equal(emitted, stripTuiElementsWithContext(fullTableBlock).text);
  // Every row present (header + separator-less count: header + 3 data = 4 `│`-rows).
  assert.equal(countTableRows(emitted), countTableRows(fullTableBlock), 'all table rows must survive');
  assert.ok(emitted.includes('row 3 content'), 'row 3 must be present');
  assert.ok(emitted.includes('row 4 content'), 'row 4 must be present');
  assert.ok(emitted.includes('row 5 content'), 'row 5 must be present');
  // The intermediate 4-row pause must NOT have shipped: rows 3+4 are shared, but
  // a 4-row emit would have ROW 4 as its last data row with NO row 5 — the single
  // emit having row 5 proves no 4-row intermediate slipped out.
});

// Both assistant-output bullets are detected, emitted once, complete, identically.
for (const { glyph, fullBusy, thenProse } of [
  { glyph: outputBullet, fullBusy: captureFullBusy, thenProse: captureFullThenProse },
  { glyph: '●', fullBusy: captureFullBusyDotBullet, thenProse: captureFullThenProseDotBullet },
] as const) {
  test(`table reflow: a "${glyph}"-bulleted top border is detected and emitted complete`, () => {
    assert.ok(
      getLastSharpTableBlock(fullBusy) !== null,
      `"${glyph} ┌…" top border must be detected as a sharp table`,
    );
    const { tableEmits } = replayPoll([captureSkeleton, captureOneRow, fullBusy, thenProse]);
    assert.equal(tableEmits.length, 1, `expected ONE table emit, got ${tableEmits.length}`);
    const emitted = tableEmits[0];
    // The strip path turns the bullet into a uniform indent, so BOTH glyphs emit
    // byte-identically to the canonical `⏺`-topped block — every row complete.
    assert.equal(emitted, stripTuiElementsWithContext(fullTableBlock).text);
    assert.equal(countTableRows(emitted), countTableRows(fullTableBlock), 'all table rows must survive');
    assert.ok(emitted.includes('row 5 content'), 'the full table (row 5) must be present');
  });
}

test('table reflow: NO empty-skeleton or partial frame is ever emitted', () => {
  const { tableEmits } = replayPoll([
    captureSkeleton,
    captureOneRow,
    captureFourRowBusy,
    captureFourRowBusy,
    captureFullBusy,
    captureFullThenProse,
  ]);
  const all = tableEmits.join('\n---\n');
  assert.ok(!all.includes('│План│Суть│'), 'empty-skeleton header must never ship');
  assert.ok(!all.includes('deet 3'), 'the intermediate 1-row layout must never ship');
});

test('table reflow: surrounding prose still streams (only the table waits)', () => {
  const { proseEmits } = replayPoll([
    captureSkeleton,
    captureOneRow,
    captureFullBusy,
    captureFullThenProse,
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

test('table reflow: table then prose → emit the table ONCE, ahead of the trailing prose (ordering)', () => {
  // Done-signal #2: real content follows the table. The table emits once, and —
  // because the adapter runs the table emit BEFORE the masked prose delta — it
  // lands ahead of "Рекомендация…".
  const { proseEmits, tableEmits } = replayPoll([
    captureSkeleton,
    captureFullBusy,
    captureFullThenProse,
  ]);
  assert.equal(tableEmits.length, 1, 'the done table emits exactly once');
  assert.ok(tableEmits[0].includes('row 5 content'), 'the emitted table is the full version');
  // The trailing prose reached the topic too (not swallowed by the table emit).
  assert.ok(
    proseEmits.some(emit => emit.includes('Рекомендация')),
    'the prose after the table must still stream',
  );
});

test('table reflow: table-only answer emits at IDLE, not on byte-stability', () => {
  // Done-signal #3: a table is the WHOLE answer (no trailing prose ever). It must
  // emit when the turn goes idle — NOT only at the safety cap, and NOT on the old
  // "stable one poll" rule (which no longer exists). Drive the pure decision:
  const tableBlock = getLastSharpTableBlock(captureFullBusy)!;

  // Poll N: table painted, still BUSY, no content after → HOLD (the pause case).
  const busy1 = getTableStabilizationDecision({
    currentTable: tableBlock,
    streamingTable: null,
    hasContentAfterTable: false,
    isTurnIdle: false,
  });
  assert.equal(busy1.kind, 'hold');

  // Poll N+1: SAME block, STILL busy → STILL HOLD (byte-stability alone never
  // emits — this is the live-bug guard).
  const busy2 = getTableStabilizationDecision({
    currentTable: tableBlock,
    streamingTable: busy1.nextStreamingTable,
    hasContentAfterTable: false,
    isTurnIdle: false,
  });
  assert.equal(busy2.kind, 'hold', 'a byte-stable but still-busy table must NOT emit');

  // Poll N+2: same block, turn now IDLE → emit once, promptly.
  const idle = getTableStabilizationDecision({
    currentTable: tableBlock,
    streamingTable: busy2.nextStreamingTable,
    hasContentAfterTable: false,
    isTurnIdle: true,
  });
  assert.equal(idle.kind, 'emit');
  assert.equal(idle.block, tableBlock);
  assert.equal(idle.nextStreamingTable, null);
  assert.ok(stripTuiElementsWithContext(idle.block!).text.includes('row 5 content'));
});

test('table reflow: a table that leaves the pane flushes the held table once (case C)', () => {
  // The pane moves on to prose with the table scrolled out of the capture window
  // before any done-signal fired while it was visible → the no-table rule flushes
  // the last held version exactly once (never lost).
  const proseAfter = ['Позже добавлю детали.', '', 'Готово.'].join('\n');
  const { tableEmits } = replayPoll([
    captureSkeleton,
    captureOneRow,
    captureFullBusy, // held (busy, no content after)
    proseAfter, //      table gone → flush the held full version
  ]);
  assert.equal(tableEmits.length, 1, 'the held table must flush exactly once on case C');
  assert.ok(tableEmits[0].includes('row 5 content'), 'the flushed table is the full version');
});

test('checkHasContentAfterLastSharpTable: busy footer (spinner + bypass row) is NOT content', () => {
  // The live false-positive risk: the streaming footer must never read as "prose
  // after the table" (it would emit the table mid-stream). Both footer lines are
  // chrome, so a still-busy full table has NO content after it.
  assert.equal(checkHasContentAfterLastSharpTable(captureFullBusy), false);
});

test('checkHasContentAfterLastSharpTable: the input box and its rule are NOT content', () => {
  // An idle pane's `❯ ` box + `────` rule must not count as content either —
  // idleness is the `isTurnIdle` signal's job, not this one's.
  const tableThenBox = [...fullTableBody, '', '❯ ', '  ──────────────────'].join('\n');
  assert.equal(checkHasContentAfterLastSharpTable(tableThenBox), false);
});

test('checkHasContentAfterLastSharpTable: a real prose line after the table IS content', () => {
  assert.equal(checkHasContentAfterLastSharpTable(captureFullThenProse), true);
});

test('checkHasContentAfterLastSharpTable: no table → false', () => {
  assert.equal(checkHasContentAfterLastSharpTable('just prose\nno table'), false);
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

test('getTableStabilizationDecision: holds a still-busy table and advances heldPolls only while unchanged', () => {
  const noSignals = { hasContentAfterTable: false, isTurnIdle: false } as const;
  const first = getTableStabilizationDecision({ currentTable: 'T1', streamingTable: null, ...noSignals });
  assert.equal(first.kind, 'hold');
  assert.deepEqual(first.nextStreamingTable, { block: 'T1', heldPolls: 1 });

  // Same block held again → counter advances.
  const second = getTableStabilizationDecision({
    currentTable: 'T1',
    streamingTable: first.nextStreamingTable,
    ...noSignals,
  });
  assert.equal(second.kind, 'hold');
  assert.deepEqual(second.nextStreamingTable, { block: 'T1', heldPolls: 2 });

  // A CHANGED block (still re-flowing) RESETS the counter — it gets the full budget.
  const changed = getTableStabilizationDecision({
    currentTable: 'T2',
    streamingTable: second.nextStreamingTable,
    ...noSignals,
  });
  assert.equal(changed.kind, 'hold');
  assert.deepEqual(changed.nextStreamingTable, { block: 'T2', heldPolls: 1 });
});

test('getTableStabilizationDecision: a byte-stable but still-busy table does NOT emit', () => {
  // The core regression guard (2026-06-15): identical block across polls, still
  // busy, nothing after it → HOLD, never emit.
  const held = { block: 'T', heldPolls: 1 };
  const decision = getTableStabilizationDecision({
    currentTable: 'T',
    streamingTable: held,
    hasContentAfterTable: false,
    isTurnIdle: false,
  });
  assert.equal(decision.kind, 'hold');
  assert.deepEqual(decision.nextStreamingTable, { block: 'T', heldPolls: 2 });
});

test('getTableStabilizationDecision: emits when real content follows the table', () => {
  const held = { block: 'T', heldPolls: 1 };
  const decision = getTableStabilizationDecision({
    currentTable: 'T',
    streamingTable: held,
    hasContentAfterTable: true,
    isTurnIdle: false,
  });
  assert.equal(decision.kind, 'emit');
  assert.equal(decision.block, 'T');
  assert.equal(decision.nextStreamingTable, null);
});

test('getTableStabilizationDecision: emits when the turn goes idle', () => {
  const held = { block: 'T', heldPolls: 1 };
  const decision = getTableStabilizationDecision({
    currentTable: 'T',
    streamingTable: held,
    hasContentAfterTable: false,
    isTurnIdle: true,
  });
  assert.equal(decision.kind, 'emit');
  assert.equal(decision.block, 'T');
  assert.equal(decision.nextStreamingTable, null);
});

test('getTableStabilizationDecision: flushes the held block when the table is gone', () => {
  const held = { block: 'T', heldPolls: 3 };
  const decision = getTableStabilizationDecision({
    currentTable: null,
    streamingTable: held,
    hasContentAfterTable: false,
    isTurnIdle: false,
  });
  assert.equal(decision.kind, 'emit');
  assert.equal(decision.block, 'T');
  assert.equal(decision.nextStreamingTable, null);
});

test('getTableStabilizationDecision: no table and nothing held is a no-op', () => {
  const decision = getTableStabilizationDecision({
    currentTable: null,
    streamingTable: null,
    hasContentAfterTable: false,
    isTurnIdle: false,
  });
  assert.equal(decision.kind, 'none');
  assert.equal(decision.nextStreamingTable, null);
});

test('getTableStabilizationDecision: SAFETY force-emits a never-settling busy table past the cap', () => {
  // A pane stuck re-flowing forever while still busy (never a done-signal) must
  // never swallow the table: once heldPolls would exceed the cap, the latest
  // version is force-emitted. Here the SAME block is held every poll (busy, no
  // content after) so the counter climbs to the cap.
  let held: { block: string; heldPolls: number } | null = null;
  let emitted: string | null = null;
  for (let poll = 0; poll < 40; poll++) {
    const decision = getTableStabilizationDecision({
      currentTable: 'T',
      streamingTable: held,
      hasContentAfterTable: false,
      isTurnIdle: false,
    });
    held = decision.nextStreamingTable;
    if (decision.kind === 'emit') {
      emitted = decision.block;
      break;
    }
  }
  assert.ok(emitted !== null, 'the safety cap must force-emit a never-settling table');
});
