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

test('a tool header + ⎿ body → toolHeader then toolBody, body text intact', () => {
  const chunk = [
    '● *Bash*(yarn test)',
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
  assert.equal(
    findSegment(segments, ClaudeChunkTag.ToolHeader)?.text,
    '● *Bash*(yarn test)',
  );
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

// ─── adjacent same-tag coalescing ──────────────────────────────────────

test('adjacent same-tag lines coalesce into one segment', () => {
  const chunk = ['First answer line.', 'Second answer line.', 'Third answer line.'].join('\n');
  const { segments } = classifyClaudeChunk(chunk, createInitialChunkContext());
  assert.equal(segments.length, 1, 'three prose lines coalesce into one segment');
  assert.equal(segments[0].text, chunk, 'order + content preserved');
});
