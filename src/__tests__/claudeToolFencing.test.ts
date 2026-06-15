/**
 * @description B2 + B3 for the Claude adapter's `stripTuiElements`:
 *
 *  - B3: the terminal-only `(ctrl+o …)` affordance is stripped, prefix kept.
 *  - B2: a code-producing tool's `⎿` result body is wrapped in a ```` ``` ````
 *    fence so `renderAgentHtml` turns it into a `<pre><code>` block.
 *      · Bash/Grep/Glob — the `⎿` line IS stdout → fenced together with body;
 *      · Read/Edit/Update/Write — the `⎿` line is a summary (prose) → only the
 *        deeper-indented diff/file body is fenced; a summary with NO body
 *        (`Read 50 lines`) is left alone.
 *
 * Load-bearing negative: a thinking block (`Thinking for…` + `⎿ <prose>` with
 * 300-col-wrapped 5-space continuation lines) is NEVER fenced — the
 * continuation is byte-identical in shape to a diff/output body, so the
 * discriminator MUST be the tool header, not body indent. Fixtures are the
 * real shapes captured from the ExampleGroup → TelegramCode log.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  mergeAdjacentFences,
  stripTuiElements,
  stripTuiElementsWithContext,
} from '../adapters/claudeCliAdapter';

/** True iff `line` falls inside a ```` ``` ````-delimited span of `text`. */
function checkIsInsideFence(text: string, line: string): boolean {
  const lines = text.split('\n');
  let inFence = false;
  for (const current of lines) {
    if (/^```/.test(current)) {
      inFence = !inFence;
      continue;
    }
    if (current.includes(line)) return inFence;
  }
  return false;
}

// ─── B3 — (ctrl+o …) strip ─────────────────────────────────────────────

test('stripTuiElements: drops "(ctrl+o to expand)", keeps the prefix', () => {
  assert.equal(stripTuiElements('Thought for *4s* (ctrl+o to expand)'), 'Thought for *4s*');
});

test('stripTuiElements: drops "(ctrl+o to see full summary)" variant', () => {
  const out = stripTuiElements('  ⎿  Compacted (ctrl+o to see full summary)');
  assert.ok(!/ctrl\+o/.test(out), `ctrl+o leaked: ${JSON.stringify(out)}`);
  assert.ok(out.includes('Compacted'));
});

test('stripTuiElements: keeps the "… +N lines" truncation marker after ctrl+o strip', () => {
  assert.equal(stripTuiElements('     … +2 lines (ctrl+o to expand)'), '… +2 lines');
});

// ─── B2 — Bash (output tool): ⎿ line + body fenced ─────────────────────

test('stripTuiElements: fences a Bash command-output block', () => {
  const input = [
    '● *Bash*(ls -la)',
    '  ⎿  -rw-r--r--. 1 com com 100 file.log',
    '     42 file.log',
    '     ---panes---',
  ].join('\n');
  const expected = [
    '● *Bash*(ls -la)',
    '```',
    '-rw-r--r--. 1 com com 100 file.log',
    '42 file.log',
    '---panes---',
    '```',
  ].join('\n');
  assert.equal(stripTuiElements(input), expected);
});

// ─── B2 — Update (file tool): summary prose + fenced diff body ──────────

test('stripTuiElements: fences an Update diff body, summary stays prose', () => {
  const input = [
    '● *Update*(src/x.ts)',
    '  ⎿  Added *2* lines, removed *1* lines',
    '       10  const a = 1;',
    '       11 - const b = 2;',
    '       11 + const b = 3;',
  ].join('\n');
  const expected = [
    '● *Update*(src/x.ts)',
    '  ⎿  Added *2* lines, removed *1* lines',
    '```',
    '10  const a = 1;',
    '11 - const b = 2;',
    '11 + const b = 3;',
    '```',
  ].join('\n');
  assert.equal(stripTuiElements(input), expected);
});

// ─── B2 — a summary-only result (no body) is NOT fenced ────────────────

test('stripTuiElements: a "Read N lines" summary with no body is not fenced', () => {
  const input = '● *Read*(src/x.ts)\n  ⎿  Read *50* lines';
  const out = stripTuiElements(input);
  assert.ok(!out.includes('```'), `unexpected fence: ${JSON.stringify(out)}`);
  assert.equal(out, input);
});

// ─── B2 — LOAD-BEARING NEGATIVE: thinking prose is never fenced ────────

test('stripTuiElements: thinking block with wrapped continuation is NOT fenced', () => {
  // The exact shape from the log: a `Thinking for…` header (NOT a code tool)
  // and a `⎿` prose body whose long line wrapped at the 300-col pane into
  // 5-space-indented continuation lines — identical indent to a diff/output
  // body. Header-based discrimination must keep this as prose.
  const input = [
    'Thinking for *1m 6s*… (ctrl+o to expand)',
    '  ⎿  I am realizing the actual scope is much larger than initially reported',
    '     errors are unused imports (211 of them), but here is the catch',
    '     every future commit touching any of the affected files would get blocked',
  ].join('\n');
  const out = stripTuiElements(input);
  assert.ok(!out.includes('```'), `thinking prose was wrongly fenced: ${JSON.stringify(out)}`);
  assert.ok(!/ctrl\+o/.test(out), 'ctrl+o still stripped on the thinking header');
  assert.ok(out.includes('Thinking for *1m 6s*…'));
  assert.ok(out.includes('errors are unused imports (211 of them), but here is the catch'));
});

// ─── B2 — header-less diff-row fallback (cross-poll split) ─────────────

test('stripTuiElements: fences a header-less run of diff rows (≥2)', () => {
  const input = ['       10  const a = 1;', '       11 + const b = 3;'].join('\n');
  const expected = ['```', '10  const a = 1;', '11 + const b = 3;', '```'].join('\n');
  assert.equal(stripTuiElements(input), expected);
});

test('stripTuiElements: a lone diff-looking row is NOT fenced (too few to be a diff)', () => {
  const out = stripTuiElements('       10  const a = 1;');
  assert.ok(!out.includes('```'), `lone row wrongly fenced: ${JSON.stringify(out)}`);
  assert.equal(out, '10  const a = 1;');
});

// ─── B2 — agent-authored fences are not double-wrapped ─────────────────

test('stripTuiElements: leaves an agent ``` block untouched (no double-wrap)', () => {
  const input = ['```ts', '   10 const a = 1;', '```'].join('\n');
  assert.equal(stripTuiElements(input), input);
});

// ─── B2 — triple-backticks inside a fenced body are neutralised ────────

test('stripTuiElements: breaks ``` inside a fenced body so it cannot close the fence', () => {
  // Bash printing a file that itself contains a code fence: the inner ``` must
  // not prematurely close our wrapper, so only the 2 wrapper fences remain.
  const input = [
    '● *Bash*(cat readme.md)',
    '  ⎿  # Title',
    '     ```js',
    '     code',
    '     ```',
  ].join('\n');
  const out = stripTuiElements(input);
  const standaloneFences = (out.match(/^```$/gm) ?? []).length;
  assert.equal(standaloneFences, 2, `expected exactly 2 wrapper fences: ${JSON.stringify(out)}`);
  assert.ok(out.includes('​'), 'inner backticks should be broken with a zero-width space');
});

// ─── B2 — CROSS-POLL: orphan ⎿ body (header was a prior poll) ──────────

test('stripTuiElements: fences an orphan Bash ⎿ body when the tool context is "output"', () => {
  // The `yarn test` repro: the `● Bash(…)` header streamed in an earlier poll,
  // so this delta is just the result. The `output` kind threaded from that
  // header poll (incomingKind) is what lets it still be fenced. The trailing
  // `… +N lines` collapse marker is chrome → it drops OUT of the fence and
  // renders plain below the fenced stdout (S1).
  const input = [
    "  ⎿  type: 'test'",
    '     # Subtest: paginateBindList',
    '     … +33 lines',
  ].join('\n');
  const out = stripTuiElements(input, 'output');
  assert.equal((out.match(/^```$/gm) ?? []).length, 2, `expected fenced body: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('⎿'), 'the ⎿ marker glyph should be dropped inside the fence');
  assert.ok(out.includes("type: 'test'"));
  // The collapse marker must sit OUTSIDE the fenced span (the last ``` line).
  const lines = out.split('\n');
  const lastFenceIndex = lines.lastIndexOf('```');
  const markerIndex = lines.findIndex(line => line.includes('… +33 lines'));
  assert.ok(markerIndex > lastFenceIndex, `collapse marker should be plain, after the fence: ${JSON.stringify(out)}`);
});

test('stripTuiElements: the SAME orphan body with no tool context stays prose', () => {
  // Proves the fencing is context-driven, not shape-driven: with no governing
  // tool kind the body must NOT be fenced (this is how thinking prose is spared).
  const input = [
    "  ⎿  type: 'test'",
    '     # Subtest: paginateBindList',
    '     … +33 lines',
  ].join('\n');
  assert.ok(!stripTuiElements(input, null).includes('```'));
});

test('stripTuiElements: fences an orphan indented continuation under "output" context', () => {
  // A later poll of a long command: pure indented stdout, no ⎿, no header.
  const out = stripTuiElements('     output line 1\n     output line 2', 'output');
  const expected = ['```', 'output line 1', 'output line 2', '```'].join('\n');
  assert.equal(out, expected);
});

test('stripTuiElements: an indented continuation with no context is NOT fenced', () => {
  // The thinking cross-poll case: continuation prose with `null` context stays prose.
  const out = stripTuiElements('     thinking continues here\n     and still more', null);
  assert.ok(!out.includes('```'));
});

// ─── B2 — progress lines (◯ sub-agent, compaction bar) are never fenced ─

test('stripTuiElements: a sub-agent ◯ task line is NEVER fenced, even with a stale output kind', () => {
  // Live regression: the `◯` line is indented, so a stale `output` kind routed
  // it through the orphan-continuation fence. The bot collapses `◯` bursts via
  // checkIsProgressChunk — fencing breaks that (the ``` delimiters aren't
  // progress lines) and re-floods the topic with one fenced tick per second.
  const line =
    '  ◯ pre-commit-code-reviewer  Pre-commit review of output-readability fix    49s';
  const out = stripTuiElements(line, 'output');
  assert.ok(!out.includes('```'), `sub-agent line wrongly fenced: ${JSON.stringify(out)}`);
  assert.ok(out.includes('◯ pre-commit-code-reviewer'));
});

test('stripTuiElements: the cursor-led "❯ ◯" sub-agent frame is not fenced either', () => {
  assert.ok(!stripTuiElements('  ❯ ◯ general-purpose  some task    1m 2s', 'output').includes('```'));
});

test('stripTuiElementsWithContext: a ◯ sub-agent line clears the open tool kind', () => {
  // So a following spinner/answer poll never inherits a stale "output" kind.
  assert.equal(stripTuiElementsWithContext('  ◯ general-purpose  task    5s', 'output').toolKind, null);
});

test('stripTuiElements: a compaction progress bar is not fenced under a stale output kind', () => {
  assert.ok(!stripTuiElements('  ▰▰▰▰▰▱▱▱▱▱ 50%', 'output').includes('```'));
});

// ─── stripTuiElementsWithContext — cross-poll tool-kind threading ──────

test('stripTuiElementsWithContext: a Bash header chunk reports outgoing kind "output"', () => {
  // The header poll: sets the kind that the NEXT poll's orphan body inherits.
  const { toolKind } = stripTuiElementsWithContext('● *Bash*(yarn test)\n  ⎿  Running…');
  assert.equal(toolKind, 'output');
});

test('stripTuiElementsWithContext: an Update header chunk reports outgoing kind "file"', () => {
  const { toolKind } = stripTuiElementsWithContext('● *Update*(src/x.ts)\n  ⎿  Added 1 line');
  assert.equal(toolKind, 'file');
});

test('stripTuiElementsWithContext: a spinner-only chunk preserves the incoming kind', () => {
  // Spinner ticks between the header poll and the output poll are filtered to
  // nothing — the open tool kind must survive so the later body is fenced.
  const { text, toolKind } = stripTuiElementsWithContext('✻ Meandering… (3s · ↓ 5 tokens)', 'output');
  assert.equal(text, '');
  assert.equal(toolKind, 'output');
});

test('stripTuiElementsWithContext: an orphan output body keeps the kind open and is fenced', () => {
  const { text, toolKind } = stripTuiElementsWithContext('  ⎿  8836db2 fix\n     15e5ff6 feat', 'output');
  assert.ok(text.includes('```'));
  assert.equal(toolKind, 'output');
});

test('stripTuiElementsWithContext: a prose answer clears the kind to null', () => {
  // After the tool output, the agent answers in prose — the kind must close so
  // the answer (and its later continuation polls) is never fenced as output.
  const { toolKind } = stripTuiElementsWithContext('● Here is the final answer.', 'output');
  assert.equal(toolKind, null);
});

test('stripTuiElementsWithContext: a thinking chunk does not open a tool kind', () => {
  const { text, toolKind } = stripTuiElementsWithContext(
    'Thinking for 30s…\n  ⎿  pondering the approach',
    null,
  );
  assert.ok(!text.includes('```'));
  assert.equal(toolKind, null);
});

// ─── S1 — CLI status / summary lines never fenced (drop stale transients) ──

test('stripTuiElements: a stale "Running…" transient is DROPPED, only real stdout fenced', () => {
  // The msg-20718 case: a fast command captured in one frame, the transient
  // "Running…" tick still painted above the real stdout. It must be dropped
  // entirely (not even kept plain) so only the genuine output stays fenced.
  const input = ['  ⎿  Running…', '     removed old hygiene plan'].join('\n');
  const out = stripTuiElements(input, 'output');
  assert.ok(!out.includes('Running…'), `stale transient should be dropped: ${JSON.stringify(out)}`);
  assert.ok(checkIsInsideFence(out, 'removed old hygiene plan'), `real stdout must stay fenced: ${JSON.stringify(out)}`);
});

test('stripTuiElements: a standalone "… +1 tool use" collapse marker renders PLAIN', () => {
  const out = stripTuiElements('     … +1 tool use', 'output');
  assert.ok(!out.includes('```'), `collapse marker must not be fenced: ${JSON.stringify(out)}`);
  assert.ok(out.includes('… +1 tool use'), `collapse marker must be kept: ${JSON.stringify(out)}`);
});

test('stripTuiElements: a standalone "Waiting…" tick renders PLAIN (no real output to supersede it)', () => {
  const out = stripTuiElements('     Waiting…', 'output');
  assert.ok(!out.includes('```'), `lone transient must not be fenced: ${JSON.stringify(out)}`);
  assert.ok(out.includes('Waiting…'), `lone transient must be kept plain: ${JSON.stringify(out)}`);
});

test('stripTuiElements: a "Done (… tokens …)" completion summary renders PLAIN', () => {
  const summary = 'Done (14 tool uses · 66.9k tokens · 1m 55s)';
  const out = stripTuiElements(`     ${summary}`, 'output');
  assert.ok(!out.includes('```'), `completion summary must not be fenced: ${JSON.stringify(out)}`);
  assert.ok(out.includes(summary), `completion summary must be kept: ${JSON.stringify(out)}`);
  assert.ok(!checkIsInsideFence(out, summary), 'completion summary must sit outside every fence');
});

test('stripTuiElements: a real one-line stdout ending in "…" is NOT matched, still fenced', () => {
  // False-positive guard: only the literal status shapes are chrome; a genuine
  // one-line output that happens to end in an ellipsis must stay fenced.
  const realOutput = 'Compiling project, please wait…';
  const out = stripTuiElements(`     ${realOutput}`, 'output');
  assert.ok(checkIsInsideFence(out, realOutput), `genuine stdout must stay fenced: ${JSON.stringify(out)}`);
});

test('stripTuiElements: status lines mixed with real stdout — output fenced, status plain', () => {
  // Load-bearing combined case: genuine stdout present and fenced, each status
  // line present and OUTSIDE every fenced span.
  const input = [
    '  ⎿  some real stdout line',
    '     more real output',
    '     … +1 tool use',
    '     Done (14 tool uses · 66.9k tokens · 1m 55s)',
  ].join('\n');
  const out = stripTuiElements(input, 'output');
  assert.ok(checkIsInsideFence(out, 'some real stdout line'), `stdout must be fenced: ${JSON.stringify(out)}`);
  assert.ok(checkIsInsideFence(out, 'more real output'), `stdout must be fenced: ${JSON.stringify(out)}`);
  assert.ok(!checkIsInsideFence(out, '… +1 tool use'), 'collapse marker must be outside the fence');
  assert.ok(!checkIsInsideFence(out, 'Done (14 tool uses'), 'completion summary must be outside the fence');
});

// ─── S2 — mergeAdjacentFences: blank-separated same-lang fences join ────

test('mergeAdjacentFences: close + blank + open (same lang) → ONE fence', () => {
  const input = ['```', 'body part 1', '```', '', '```', 'body part 2', '```'];
  const out = mergeAdjacentFences(input);
  const fenceCount = out.filter(line => line === '```').length;
  assert.equal(fenceCount, 2, `expected a single merged fence: ${JSON.stringify(out)}`);
  assert.deepEqual(out, ['```', 'body part 1', '', 'body part 2', '```']);
});

test('mergeAdjacentFences: two fences separated by a non-blank line stay TWO', () => {
  // A `● Bash(…)` header between two outputs is a real separator: it blocks the
  // merge so different tool calls never fuse into one block.
  const input = ['```', 'first output', '```', '● Bash(echo hi)', '```', 'second output', '```'];
  const out = mergeAdjacentFences(input);
  const fenceCount = out.filter(line => line === '```').length;
  assert.equal(fenceCount, 4, `expected two separate fences: ${JSON.stringify(out)}`);
  assert.deepEqual(out, input);
});

test('mergeAdjacentFences: different-language fences are NOT merged', () => {
  const input = ['```', 'plain body', '```', '', '```ts', 'const a = 1;', '```'];
  const out = mergeAdjacentFences(input);
  const fenceOpenCount = out.filter(line => /^```/.test(line)).length;
  assert.equal(fenceOpenCount, 4, `mismatched languages must stay separate: ${JSON.stringify(out)}`);
});

test('mergeAdjacentFences: three blank-separated same-lang fences collapse into one', () => {
  const input = ['```', 'a', '```', '', '```', 'b', '```', '', '```', 'c', '```'];
  const out = mergeAdjacentFences(input);
  assert.deepEqual(out, ['```', 'a', '', 'b', '', 'c', '```']);
});

// ─── S2 — sharp-corner markdown table scrape (bug #10) ─────────────────────
//
// Claude's TUI renders a markdown table as a SHARP-corner box-drawing frame.
// A WIDE table body row (a long `│ … │`) used to be deleted by the chrome-drop
// filter `/[╭─╮│╰╯]/.test(line) && trimmedLine.length > 50` — the "header
// survives, body rows lost" bug. The fix collects the whole sharp-corner block
// and fences it BEFORE that filter runs, so every row survives. Chrome uses
// ROUNDED corners (`╭╮╰╯`) and is still dropped by the same filter.

/** Count of flush-left ```` ``` ```` fence delimiters in `text`. */
function getFenceDelimiterCount(text: string): number {
  return text.split('\n').filter(line => line === '```').length;
}

// Both assistant-output bullets the live TUI leads a wide table's top border with
// (`●` historically, `⏺` U+23FA in v2.1.177) must license the table-collecting
// branch — a `⏺`-led top border going unmatched was the 2026-06-15 wide-table
// content-loss bug (every body row fell through to the >50-char chrome filter).
for (const bullet of ['●', '⏺'] as const) {
  test(`stripTuiElements: WIDE "${bullet}"-led sharp-corner table keeps ALL body rows, fenced (bug #10)`, () => {
    const input = [
      `${bullet} ┌───────┬────────────────────────────────────────────────────────────┬─────────┐`,
      '  │ Scope │            Description of the change in detail             │ Ratchet │',
      '  ├───────┼────────────────────────────────────────────────────────────┼─────────┤',
      '  │ S1    │ rewrite all the date helper functions into solUtils module │ 8 → 2   │',
      '  ├───────┼────────────────────────────────────────────────────────────┼─────────┤',
      '  │ S2    │ migrate the legacy ScrollView component over to KitEngine  │ 1 → 0   │',
      '  └───────┴────────────────────────────────────────────────────────────┴─────────┘',
    ].join('\n');
    const out = stripTuiElements(input);

    // Every header + body cell must survive — these are the rows the bug dropped.
    for (const token of [
      'Scope',
      'S1',
      'rewrite all the date helper functions into solUtils module',
      'S2',
      'migrate the legacy ScrollView component over to KitEngine',
      '8 → 2',
      '1 → 0',
    ]) {
      assert.ok(out.includes(token), `dropped table content "${token}": ${JSON.stringify(out)}`);
    }
    // The block is wrapped in exactly one fence (open + close), rows in between.
    assert.equal(getFenceDelimiterCount(out), 2, `expected a single fence: ${JSON.stringify(out)}`);
    assert.ok(checkIsInsideFence(out, 'rewrite all the date helper functions into solUtils module'));
  });
}

test('stripTuiElements: NARROW sharp-corner table keeps all rows, fenced', () => {
  const input = [
    '● ┌───────┬──────────────┬─────────┐',
    '  │ Scope │ Что          │ Ratchet │',
    '  ├───────┼──────────────┼─────────┤',
    '  │ S1    │ date-хелперы │ 8 → 2   │',
    '  └───────┴──────────────┴─────────┘',
  ].join('\n');
  const out = stripTuiElements(input);
  for (const token of ['Scope', 'Что', 'Ratchet', 'S1', 'date-хелперы', '8 → 2']) {
    assert.ok(out.includes(token), `dropped narrow-table content "${token}": ${JSON.stringify(out)}`);
  }
  assert.equal(getFenceDelimiterCount(out), 2, `expected a single fence: ${JSON.stringify(out)}`);
  assert.ok(checkIsInsideFence(out, 'date-хелперы'));
});

for (const bullet of ['●', '⏺'] as const) {
  test(`stripTuiElements: leading "${bullet} " bullet does not break the table frame`, () => {
    const input = [
      `${bullet} ┌───────┬─────────┐`,
      '  │ Scope │ Ratchet │',
      '  ├───────┼─────────┤',
      '  │ S1    │ 8 → 2   │',
      '  └───────┴─────────┘',
    ].join('\n');
    const out = stripTuiElements(input);
    // The bullet is gone but the box stays intact — top border survives, fenced.
    assert.ok(!out.includes(bullet), `bullet leaked into the frame: ${JSON.stringify(out)}`);
    assert.ok(out.includes('┌'), `top border lost: ${JSON.stringify(out)}`);
    assert.ok(out.includes('└'), `bottom border lost: ${JSON.stringify(out)}`);
    assert.equal(getFenceDelimiterCount(out), 2, `expected a single fence: ${JSON.stringify(out)}`);
  });
}

test('stripTuiElements: GUARD — WIDE rounded-corner chrome is still DROPPED', () => {
  // A wide `│ … │` line that belongs to a ROUNDED chrome panel (no sharp `┌`
  // top above it) must keep hitting the existing width filter, proving the new
  // sharp-table branch did not swallow chrome handling.
  const chromeRow =
    '│ Recent activity in this project that you might want to resume later on │';
  assert.ok(chromeRow.length > 50, 'fixture must exceed the 50-char width filter');
  const input = [
    '╭──────────────────────────────────────────────────────────────────────╮',
    chromeRow,
    '╰──────────────────────────────────────────────────────────────────────╯',
  ].join('\n');
  const out = stripTuiElements(input);
  assert.ok(
    !out.includes('Recent activity in this project'),
    `rounded chrome row leaked through: ${JSON.stringify(out)}`,
  );
});
