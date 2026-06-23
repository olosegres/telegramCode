/**
 * @description Load-bearing tests for the pure Claude scrape-chunk classifier
 * (S3). Each test asserts the REAL tag a run of lines gets, not "no crash" —
 * the classifier is the decision layer the verbosity scopes (S4 tool_results,
 * S5 thinking, S6 sub-agent fold) will consume, so a mis-tag here is a flooded
 * topic / a swallowed answer there.
 *
 * Fixtures are real scraped lines: the overview-2 panel-preview flood captured
 * live 2026-06-11, and the thinking-block / tool-fence shapes mined from
 * `claudeToolFencing.test.ts` and `claudeQuestion.test.ts`.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ClaudeChunkTag,
  classifyClaudeChunk,
  createInitialChunkContext,
  type ClaudeChunkSegment,
} from '../utils/claudeChunkClassifier';

/** The ordered tag sequence of a chunk classified from a fresh context. */
function getTags(chunkText: string): ClaudeChunkTag[] {
  const { segments } = classifyClaudeChunk(chunkText, createInitialChunkContext());
  return segments.map(segment => segment.tag);
}

/** The first segment with the given tag, or undefined. */
function findSegment(
  segments: ClaudeChunkSegment[],
  tag: ClaudeChunkTag,
): ClaudeChunkSegment | undefined {
  return segments.find(segment => segment.tag === tag);
}

// ─── tool header + ⎿ body ──────────────────────────────────────────────

// Both assistant-output bullets that lead a real tool header (`●`, and the
// v2.1.177 `⏺`) must tag as ToolHeader, not prose — a `⏺`-led header going
// unrecognised was the 2026-06-15 relay bug.
for (const bullet of ['●', '⏺'] as const) {
  test(`a "${bullet}"-led tool header + ⎿ body → toolHeader then toolBody, body text intact`, () => {
    const header = `${bullet} *Bash*(yarn test)`;
    const chunk = [
      header,
      '  ⎿  build exit=0',
      '     2 passing',
    ].join('\n');
    const { segments } = classifyClaudeChunk(chunk, createInitialChunkContext());

    assert.deepEqual(
      segments.map(s => s.tag),
      [ClaudeChunkTag.ToolHeader, ClaudeChunkTag.ToolBody],
    );
    const body = findSegment(segments, ClaudeChunkTag.ToolBody);
    assert.ok(body, 'a toolBody segment must exist');
    assert.ok(body.text.includes('build exit=0'), 'the ⎿ marker line is body');
    assert.ok(body.text.includes('2 passing'), 'the indented continuation is body');
    assert.equal(findSegment(segments, ClaudeChunkTag.ToolHeader)?.text, header);
  });
}

test('an Update(…) header (Claude TUI render of Edit) → toolHeader, not prose', () => {
  // Live bug (all-minimal topic, 2026-06-13): `Update` was missing from
  // ANY_TOOL_HEADER_RE though FILE_TOOL_HEADER_RE has it — so Claude's most
  // common header (`● Update(file)`) leaked as prose, bypassing verbosity routing.
  const chunk = ['● *Update*(src/foo.ts)', '  ⎿  Added 3 lines, removed 1'].join('\n');
  const { segments } = classifyClaudeChunk(chunk, createInitialChunkContext());
  assert.equal(segments[0]?.tag, ClaudeChunkTag.ToolHeader, 'Update header is a tool header');
  assert.equal(findSegment(segments, ClaudeChunkTag.ToolHeader)?.text, '● *Update*(src/foo.ts)');
});

test('a sub-agent ⎿ Update(…) preview under a ◯ panel → subagentPanelPreview (folds)', () => {
  // The Update-header gap also meant `⎿ Update(…)` previews under a running
  // sub-agent panel did not fold (the ID 30447 leak). With Update recognised the
  // preview is panel chatter again.
  const chunk = [
    '  ◯ general-purpose  Implement the fix                                          1m 2s',
    '  ⎿  Update(src/utils/claudeChunkClassifier.ts)',
  ].join('\n');
  const tags = getTags(chunk);
  assert.ok(tags.includes(ClaudeChunkTag.SubagentPanelPreview), 'the ⎿ Update(…) preview folds as panel chatter');
  assert.ok(!tags.includes(ClaudeChunkTag.Prose), 'the preview must not leak as prose');
});

// ─── sub-agent panel preview flood (the overview-2 wall) ───────────────

test('"… +N tool uses" + ⎿ Tool(…) previews under a ◯ panel → subagentPanelPreview', () => {
  // Real lines captured live 2026-06-11 from the overview-2 topic flood.
  const chunk = [
    '⎿  Bash(cd /home/user/src/overview && yarn e2e:build > /home/user/src/overview/agent/tmp/e2eBuildGreen.log 2>&1; echo "build exit=$?"; ya',
    '     Bash(cd /home/user/src/overview && node startupErrorProbe.cjs 2>&1 | tail -20)',
    '… +80 tool uses',
    '  ◯ general-purpose  Implement relations add-flow fix                          26m 9s',
  ].join('\n');
  const { segments } = classifyClaudeChunk(chunk, createInitialChunkContext());

  // The ⎿ Bash(…) preview + the indented Bash(…) + "… +80 tool uses" wall are
  // all panel chatter; the ◯ title line is progress (chrome, relay collapses it).
  const preview = findSegment(segments, ClaudeChunkTag.SubagentPanelPreview);
  assert.ok(preview, 'panel previews must be tagged subagentPanelPreview');
  assert.ok(preview.text.includes('yarn e2e:build'), 'the ⎿ Bash(…) preview is panel chatter');
  assert.ok(preview.text.includes('node startupErrorProbe.cjs'), 'the indented Bash(…) preview is panel chatter');
  assert.ok(preview.text.includes('… +80 tool uses'), 'the "+N tool uses" wall is panel chatter');

  // NONE of the flood lines may leak as prose (the live bug: 92% of messages
  // were tool/panel walls that reached the topic as permanent output).
  assert.equal(findSegment(segments, ClaudeChunkTag.Prose), undefined, 'no flood line is prose');

  // The ◯ panel title is chrome (progressLine already collapses it).
  const chrome = findSegment(segments, ClaudeChunkTag.Chrome);
  assert.ok(chrome, 'the ◯ panel title is chrome');
  assert.ok(chrome.text.includes('◯ general-purpose'), 'the ◯ title is the chrome line');
});

test('a bare "… +N tool uses" wall while a panel is open → subagentPanelPreview', () => {
  // Panel opened in a prior poll; only the collapse wall arrives this poll.
  const ctx = { ...createInitialChunkContext(), isSubagentPanelOpen: true };
  const { segments } = classifyClaudeChunk('… +62 tool uses', ctx);
  assert.deepEqual(segments.map(s => s.tag), [ClaudeChunkTag.SubagentPanelPreview]);
});

test('an ORPHAN "… +N tool uses" wall (no open panel) → chrome, never prose', () => {
  // S6 (a): the panel scrolled off / closed in a prior poll, so the collapse
  // wall arrives with NO open panel context. Pre-fix it fell through to prose
  // and re-introduced part of the overview-2 flood; now it is dropped as chrome.
  assert.deepEqual(getTags('… +62 tool uses'), [ClaudeChunkTag.Chrome]);
});

test('an ORPHAN "… +N lines" summary (no open tool) is UNCHANGED — stays prose, not chrome', () => {
  // Guards that the tool-use-only regex does NOT swallow the legitimate
  // "+N lines" tool-body summary: with no open tool kind a fresh context still
  // leaves it as the conservative prose default (its real handling is the
  // ToolBody branch, which only fires under an open tool kind).
  assert.deepEqual(getTags('… +5 lines'), [ClaudeChunkTag.Prose]);
});

// ─── thinking block ────────────────────────────────────────────────────

test('"Thinking for…" header + reasoning + "Thought/Cooked for Ns" trailer → thinkingBlock', () => {
  const chunk = [
    'Thinking for *1m 6s*…',
    '  ⎿  I am realizing the actual scope is much larger than initially reported',
    '     every future commit touching the affected files would get blocked',
    '✻ Cooked for 27s',
  ].join('\n');
  const { segments } = classifyClaudeChunk(chunk, createInitialChunkContext());

  // The whole block is one coalesced thinkingBlock segment.
  assert.deepEqual(segments.map(s => s.tag), [ClaudeChunkTag.ThinkingBlock]);
  const block = segments[0];
  assert.ok(block.text.includes('Thinking for *1m 6s*…'), 'the header is thinking');
  assert.ok(block.text.includes('much larger than initially reported'), 'the reasoning body is thinking');
  assert.ok(block.text.includes('Cooked for 27s'), 'the post-thinking trailer is thinking');
});

test('"Thinking for 32s…" with the duration UNbolded still tags as thinkingBlock', () => {
  const { segments } = classifyClaudeChunk(
    'Thinking for 32s…\n  ⎿  pondering the approach',
    createInitialChunkContext(),
  );
  assert.deepEqual(segments.map(s => s.tag), [ClaudeChunkTag.ThinkingBlock]);
});

test('a prose "Thinking for a moment about X" is NOT thinkingBlock (no duration)', () => {
  // No `\d+s…` tail, so the conservative header regex must not fire.
  assert.deepEqual(getTags('Thinking for a moment about the next step'), [ClaudeChunkTag.Prose]);
});

// ─── prose (the conservative default) ──────────────────────────────────

test('a prose answer line ("● План большой …") → prose', () => {
  assert.deepEqual(getTags('● План большой, разобью его на несколько этапов.'), [
    ClaudeChunkTag.Prose,
  ]);
});

test('an unrecognized line → prose (conservative default)', () => {
  assert.deepEqual(getTags('Some arbitrary sentence with no TUI markers at all.'), [
    ClaudeChunkTag.Prose,
  ]);
});

// ─── chrome (box-drawing / question / nav hints) ───────────────────────

test('box-drawing + question chrome → chrome (real AskUserQuestion frame)', () => {
  // Real frame shape from claudeQuestion.test.ts.
  const chunk = [
    '╭───────────────────────────────────────────────╮',
    '│ Enter to select · Esc to cancel                 │',
    '╰───────────────────────────────────────────────╯',
  ].join('\n');
  assert.deepEqual(getTags(chunk), [ClaudeChunkTag.Chrome]);
});

test('a full-width rule and the bypass-permissions footer → chrome', () => {
  assert.deepEqual(getTags('────────────────────────'), [ClaudeChunkTag.Chrome]);
  assert.deepEqual(
    getTags('  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt'),
    [ClaudeChunkTag.Chrome],
  );
});

// ─── cross-poll fence context (mirrors the orphan-output fencing) ──────

test('cross-poll: a tool body opened in one chunk, its continuation in the next, both toolBody', () => {
  // Poll 1: only the header (Claude's diff drops the duplicate header on poll 2,
  // so the slow command's output arrives header-less in poll 2).
  const poll1 = classifyClaudeChunk('● *Bash*(yarn build)', createInitialChunkContext());
  assert.deepEqual(poll1.segments.map(s => s.tag), [ClaudeChunkTag.ToolHeader]);
  assert.equal(poll1.outgoingContext.toolKind, 'output', 'the output kind stays open across the poll');

  // Poll 2: fed the returned context → the orphan indented output is toolBody.
  const poll2 = classifyClaudeChunk(
    ['     tsc finished', '     0 errors'].join('\n'),
    poll1.outgoingContext,
  );
  assert.deepEqual(poll2.segments.map(s => s.tag), [ClaudeChunkTag.ToolBody]);
  assert.ok(poll2.segments[0].text.includes('0 errors'), 'orphan continuation body text intact');
});

test('cross-poll: a prose answer line closes the open tool kind', () => {
  const poll1 = classifyClaudeChunk('● *Bash*(ls)', createInitialChunkContext());
  assert.equal(poll1.outgoingContext.toolKind, 'output');
  const poll2 = classifyClaudeChunk('Here is the final answer.', poll1.outgoingContext);
  assert.deepEqual(poll2.segments.map(s => s.tag), [ClaudeChunkTag.Prose]);
  assert.equal(poll2.outgoingContext.toolKind, null, 'prose closes the kind');
});

// ─── a mixed chunk splits into the right ordered segments ──────────────

test('mixed chunk: prose + thinking + tool lines split into ordered segments, prose not mis-tagged', () => {
  const chunk = [
    '● Here is my plan for the refactor.',
    'Thinking for 32s…',
    '  ⎿  weighing the two options',
    '● *Bash*(ls -la)',
    '  ⎿  total 8',
    '     file.ts',
  ].join('\n');
  const { segments } = classifyClaudeChunk(chunk, createInitialChunkContext());

  assert.deepEqual(segments.map(s => s.tag), [
    ClaudeChunkTag.Prose,
    ClaudeChunkTag.ThinkingBlock,
    ClaudeChunkTag.ToolHeader,
    ClaudeChunkTag.ToolBody,
  ]);
  // The prose line is exactly the answer, never absorbed into a tool/thinking run.
  assert.equal(
    findSegment(segments, ClaudeChunkTag.Prose)?.text,
    '● Here is my plan for the refactor.',
  );
  const body = findSegment(segments, ClaudeChunkTag.ToolBody);
  assert.ok(body?.text.includes('file.ts'), 'the bash body is intact');
  assert.ok(!body?.text.includes('weighing'), 'thinking body never bleeds into the tool body');
});

// ─── a real tool ⎿ result is NOT mistaken for a panel preview ──────────

test('a genuine ⎿ stdout line (not a tool-header) under an open tool is toolBody, not panel preview', () => {
  const chunk = ['● *Bash*(echo hi)', '  ⎿  hi'].join('\n');
  const { segments } = classifyClaudeChunk(chunk, createInitialChunkContext());
  assert.deepEqual(segments.map(s => s.tag), [
    ClaudeChunkTag.ToolHeader,
    ClaudeChunkTag.ToolBody,
  ]);
  assert.equal(findSegment(segments, ClaudeChunkTag.SubagentPanelPreview), undefined);
});

// ─── orphan ⎿ tool result (header consumed by a prior poll's line-SET diff) ──

test('S1: an orphan ⎿ result (no open kind) → toolBody, NOT prose (minimal must fold it)', () => {
  // The real-world leak (thread -1001111111111:434): the `⏺ Bash(…)` header was
  // dropped by the per-poll line-SET diff, an interleaved prose sentence nulled
  // the cross-poll tool context, so the slow `⎿` output arrived header-less with
  // toolKind === null. Pre-fix it fell to Prose → router always keeps → leaked
  // into the topic despite minimal. Now a leading `⎿` opens a synthetic output
  // kind so the block (and its indented continuation) tags toolBody.
  const chunk = [
    '⎿  trace rows: 2199',
    '     first matching row at offset 12',
    '     last matching row at offset 2187',
    '     scan completed in 41ms',
  ].join('\n');
  const { segments, outgoingContext } = classifyClaudeChunk(chunk, createInitialChunkContext());

  assert.deepEqual(segments.map(s => s.tag), [ClaudeChunkTag.ToolBody]);
  assert.ok(
    segments[0].text.includes('trace rows: 2199'),
    'the ⎿ result line is part of the tool body',
  );
  assert.ok(
    segments[0].text.includes('scan completed in 41ms'),
    'the indented continuation lines stay in the same tool body',
  );
  assert.equal(outgoingContext.toolKind, 'output', 'a synthetic output kind is opened');
});

test('S1 cross-poll: header poll → interleaved prose nulls context → orphan ⎿ block folds', () => {
  // Poll 1: the header opens the kind, an assistant sentence then CLOSES it
  // (rule #10) — exactly the interleave that produced toolKind === null.
  const poll1 = classifyClaudeChunk(
    ['⏺ *Bash*(grep -c match trace.log)', 'Let me check how many rows matched.'].join('\n'),
    createInitialChunkContext(),
  );
  assert.equal(poll1.outgoingContext.toolKind, null, 'the interleaved prose nulled the tool kind');

  // Poll 2: the slow `⎿` output arrives header-less → still toolBody via the
  // synthetic open, so minimal folds it instead of leaking it as prose.
  const poll2 = classifyClaudeChunk(
    ['⎿  trace rows: 2199', '     done'].join('\n'),
    poll1.outgoingContext,
  );
  assert.deepEqual(poll2.segments.map(s => s.tag), [ClaudeChunkTag.ToolBody]);
});

test('S1 regression: a multi-line prose answer with NO ⎿ still classifies prose (never swallowed)', () => {
  const chunk = [
    'Here is the summary of what I found.',
    'The migration renames the field and remaps its values.',
    'No further action is required on your side.',
  ].join('\n');
  assert.deepEqual(getTags(chunk), [ClaudeChunkTag.Prose]);
});

// ─── file-DIFF gutter rows (S1, live leak topic 12238 2026-06-24) ───────

test('S1 diff: an orphan "NN +" change gutter run → toolBody, NOT prose (minimal must fold it)', () => {
  // Real leaked shapes (topic -1001111111111:12238, 2026-06-24): the Edit's
  // `⎿ Updated … with N additions` summary scrolled off and an interleaved prose
  // bullet nulled the tool kind, so the numbered gutters arrived header-less and
  // non-indented (the chunk's first line lost its gutter indent to the diff's
  // `.trim()`). Pre-fix they fell to Prose → router always kept → leaked into the
  // next message (`51 +  считает …`, a bare `40 +`). All real leaks are `+`-led.
  const chunk = [
    '51 +  считает полноценными инструментами, не только проверяемые факты.',
    '40 +',
    '42 +- * *Доходит до края поля.* * Ничего не принимает на веру',
  ].join('\n');
  const { segments } = classifyClaudeChunk(chunk, createInitialChunkContext());

  assert.deepEqual(segments.map(s => s.tag), [ClaudeChunkTag.ToolBody]);
  assert.ok(segments[0].text.includes('51 +  считает'), 'the long diff content row is tool body');
  assert.ok(segments[0].text.includes('40 +'), 'the bare "NN +" gutter is tool body');
  assert.ok(segments[0].text.includes('42 +-'), 'the "+-" change gutter is tool body');
});

test('S1 diff: each "NN +" gutter self-matches per poll (NO cross-poll diff state)', () => {
  // The gutters arrive one-per-poll (the per-poll diff emits only new lines). Each
  // is independently a `+`-led change gutter, so it tags toolBody on its own —
  // there is deliberately NO carried diff-block flag (that swallowed numbered
  // answers, the reviewed-out regression). The outgoing context is unchanged.
  const ctx = createInitialChunkContext();
  const poll1 = classifyClaudeChunk('40 +', ctx);
  assert.deepEqual(poll1.segments.map(s => s.tag), [ClaudeChunkTag.ToolBody]);
  assert.deepEqual(poll1.outgoingContext, ctx, 'a gutter does not mutate the cross-poll context');
  const poll2 = classifyClaudeChunk('51 +  считает полноценными', poll1.outgoingContext);
  assert.deepEqual(poll2.segments.map(s => s.tag), [ClaudeChunkTag.ToolBody]);
});

test('S1 diff: a re-surfaced echoed-user fragment that is a "NN +" gutter folds, not leaks as prose', () => {
  // The user quoted the leaked fragments back (`"51 +  ", " ы"`); a later re-scrape
  // re-surfaced the very `51 +` gutter. It must fold like any diff change row.
  const chunk = '51 +  считает полноценными инструментами';
  const { segments } = classifyClaudeChunk(chunk, createInitialChunkContext());
  assert.deepEqual(segments.map(s => s.tag), [ClaudeChunkTag.ToolBody]);
});

test('S1 diff regression: a numbered PROSE line (not a "+"-led gutter) stays prose', () => {
  // A real prose line that merely starts with a number must NOT fold — the anchor
  // requires a "+" change marker right after the line number.
  assert.deepEqual(getTags('1. Первый пункт плана — собрать требования.'), [ClaudeChunkTag.Prose]);
  assert.deepEqual(getTags('2024 was the year the project started.'), [ClaudeChunkTag.Prose]);
  // A numbered "context-shaped" line (no "+"/"-" marker) stays prose — we never
  // fold numbered context rows (`66  …`); folding them swallowed numbered answers.
  assert.deepEqual(getTags('66  заметка про структуру без диффа'), [ClaudeChunkTag.Prose]);
});

test('S1 diff regression: "-"-led numbered prose stays prose (the reviewed-out false positive)', () => {
  // The `+`-only anchor exists precisely so these common shapes are NOT folded.
  for (const prose of ['404 - Not Found', '200 - OK', '500 - Error', '2020 - 2024', '8 - bit architecture', '2 - yes']) {
    assert.deepEqual(getTags(prose), [ClaudeChunkTag.Prose], `"${prose}" must stay prose`);
  }
});

test('S1 diff regression: a multi-line NUMBERED answer is NEVER swallowed (the critical guard)', () => {
  // The reviewed-out bug: a change gutter in poll1 left a diff-block open, then a
  // numbered ANSWER in poll2 folded entirely at minimal. With no cross-poll state
  // a context-shaped numbered answer is always prose.
  const poll1 = classifyClaudeChunk(['● *Update*(budget.md)', '41 +  rent line updated'].join('\n'), createInitialChunkContext());
  const poll2 = classifyClaudeChunk(
    ['42  remaining budget after rent', '43  cut the gym membership', '44  total savings this month'].join('\n'),
    poll1.outgoingContext,
  );
  assert.deepEqual(poll2.segments.map(s => s.tag), [ClaudeChunkTag.Prose], 'the numbered answer survives as prose');
});

test('S1 diff regression: a multi-line prose answer is never swallowed by the diff branch', () => {
  const chunk = [
    'Записал — новый раздел про мировоззрение в CLAUDE.md.',
    'Это теперь грузится каждой сессией.',
  ].join('\n');
  assert.deepEqual(getTags(chunk), [ClaudeChunkTag.Prose]);
});

// ─── adjacent same-tag coalescing ──────────────────────────────────────

test('adjacent same-tag lines coalesce into one segment', () => {
  const chunk = ['First answer line.', 'Second answer line.', 'Third answer line.'].join('\n');
  const { segments } = classifyClaudeChunk(chunk, createInitialChunkContext());
  assert.equal(segments.length, 1, 'three prose lines coalesce into one segment');
  assert.equal(segments[0].text, chunk, 'order + content preserved');
});
