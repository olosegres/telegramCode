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
import { stripTuiElements, stripTuiElementsWithContext } from '../adapters/claudeCliAdapter';

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
  // header poll (incomingKind) is what lets it still be fenced.
  const input = [
    "  ⎿  type: 'test'",
    '     # Subtest: paginateBindList',
    '     … +33 lines',
  ].join('\n');
  const out = stripTuiElements(input, 'output');
  assert.equal((out.match(/^```$/gm) ?? []).length, 2, `expected fenced body: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('⎿'), 'the ⎿ marker glyph should be dropped inside the fence');
  assert.ok(out.includes("type: 'test'") && out.includes('… +33 lines'));
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
