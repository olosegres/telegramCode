/**
 * @description Plan §2026-05-28 / V1 — `checkIsProgressChunk` must
 * accept every Claude-CLI progress-line variant seen in production
 * and reject anything that even slightly resembles real assistant
 * output.
 *
 * Failure modes that the negative cases guard against:
 *
 *  - A real prose line that happens to contain `…` would have been a
 *    false positive under a looser regex.
 *  - A tool-call result (`✓ Bash(…)`) or tree line (`├─ src/…`) would
 *    silently collapse into the rolling status message, losing actual
 *    information.
 *  - A line with token stats but no glyph (a future Claude TUI change)
 *    must NOT match — staying on the safe side until we observe and
 *    explicitly support the new format.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PROGRESS_LINE_RE, checkIsProgressChunk, spinnerGlyphClass } from '../progressLine';

// ─── S1 drift-lock: the shared spinner glyph class is the SAME one PROGRESS_LINE_RE uses ──

test('spinnerGlyphClass is the exact glyph class PROGRESS_LINE_RE anchors on (no drift with normalizeForComparison)', () => {
  // `normalizeForComparison` (utils/recentRelayWindow) builds its leading-glyph
  // strip from `spinnerGlyphClass`. If someone edits PROGRESS_LINE_RE's class
  // without updating the constant (or vice versa), the two dedup domains drift and
  // a re-animated line leaks again — this lock fails loudly instead.
  assert.ok(
    PROGRESS_LINE_RE.source.includes(`[${spinnerGlyphClass}]`),
    `PROGRESS_LINE_RE must anchor on [${spinnerGlyphClass}]; got ${PROGRESS_LINE_RE.source}`,
  );
});

// ─── Positive: must be classified as progress ──────────────────────────

const POSITIVE_LINES: ReadonlyArray<string> = [
  // Baseline glyphs and verbs observed across Claude versions.
  '✽ Smooshing… (1m 49s · ↑ 3.3k tokens)',
  '* Actioning… (2m 35s · ↑ 7.0k tokens · thought for 9s)',
  '· Coalescing… (5m 14s · ↓ 17.5k tokens)',
  '✻ Newspapering… (3m 34s · ↑ 11.0k tokens)',
  // Optional `· <thinking-note>` suffix variants — each one was seen in
  // a real session and must keep matching as Claude wording shifts.
  '✢ Newspapering… (3m 59s · ↓ 12.0k tokens · thinking with xhigh effort)',
  '· Newspapering… (3m 50s · ↓ 11.0k tokens · still thinking with xhigh effort)',
  // Leading whitespace from TUI indentation (the actual repro from the
  // user's bug log — the tick was indented by one space before the glyph).
  ' * Smooshing… (1m 2s · ↓ 1.6k tokens · thinking more with xhigh effort)',
  // Multi-word activity text: the TUI shows the ACTIVE TASK TITLE instead of
  // a single verb when a task list is in use (live flood repro 2026-06-05 —
  // these ticks failed the old single-token `\S+…` verb pattern).
  '✽ Fixing streaming output overwrite… (4m 35s · ↓ 11.2k tokens)',
  // Seconds-only elapsed time (fresh turn, no minutes yet) + unsuffixed
  // token count — both failed the old `\d+m \d+s` / `k`-only patterns.
  '✶ Fixing streaming output overwrite… (13s · ↓ 176 tokens · thinking with xhigh effort)',
  // Hours-long session tick.
  '· Reviewing the adapter contract… (1h 2m 3s · ↑ 49.0k tokens)',
  // Parenthesised suffix INSIDE the activity title: the TUI appends
  // "(sub-agent)" while a Task sub-agent runs (live flood repro 2026-06-11,
  // topic 15812 — the old `[^()]` text part rejected these ticks, so every
  // poll diff landed as a new permanent message for an hour).
  '✽ Fixing relations add flow (sub-agent)… (59m 35s · ↓ 134.5k tokens)',
  // A task title can carry its own parens too — same widening covers it.
  '✻ Fix bug (part 2)… (4s · ↓ 14 tokens)',
];

for (const line of POSITIVE_LINES) {
  test(`PROGRESS_LINE_RE positive: ${JSON.stringify(line)}`, () => {
    assert.ok(
      PROGRESS_LINE_RE.test(line),
      `expected line to match PROGRESS_LINE_RE, got false`,
    );
    assert.equal(checkIsProgressChunk(line), true);
  });
}

test('checkIsProgressChunk: multi-line block of progress lines only', () => {
  // The exact failure mode from the plan: 4 ticks in one poll diff.
  // The adapter's `checkIsStatusOutput` rejects this (> 3 non-empty
  // lines), so it would have hit `handleAgentOutput` and flooded the
  // thread with a wall of spinner messages. The bot-side redirect must
  // collapse it to the coalescer.
  const block = [
    '✽ Smooshing… (1m 49s · ↑ 3.3k tokens)',
    '* Smooshing… (1m 50s · ↑ 3.3k tokens)',
    '· Smooshing… (1m 51s · ↑ 3.3k tokens)',
    '✻ Smooshing… (1m 52s · ↑ 3.3k tokens)',
  ].join('\n');
  assert.equal(checkIsProgressChunk(block), true);
});

test('checkIsProgressChunk: verb transition block stays one chunk', () => {
  // Newspapering → Coalescing → Booping inside one diff. Each line
  // independently matches, so the whole block is progress; the user
  // sees the latest verb on the rolling line instead of three new
  // messages.
  const block = [
    '✻ Newspapering… (3m 34s · ↑ 11.0k tokens)',
    '✽ Coalescing… (3m 35s · ↑ 11.1k tokens)',
    '· Booping… (3m 36s · ↑ 11.2k tokens · thought for 3s)',
  ].join('\n');
  assert.equal(checkIsProgressChunk(block), true);
});

test('checkIsProgressChunk: tolerates blank lines around progress ticks', () => {
  // Polled diffs occasionally bring blank trailing lines from terminal
  // reflow. They must not turn a pure progress chunk into a "mixed"
  // chunk — `filter(l => l.trim())` in `checkIsProgressChunk` is what
  // protects this case.
  const block = '\n\n✽ Smooshing… (1m 49s · ↑ 3.3k tokens)\n\n';
  assert.equal(checkIsProgressChunk(block), true);
});

// ─── Negative: must NOT be classified as progress ──────────────────────

test('checkIsProgressChunk: empty string', () => {
  assert.equal(checkIsProgressChunk(''), false);
});

test('checkIsProgressChunk: whitespace only', () => {
  assert.equal(checkIsProgressChunk('   \n\t\n  '), false);
});

test('checkIsProgressChunk: real prose response', () => {
  // The literal type of response Claude sends after thinking. A loose
  // regex could match because of the ellipsis, so this is the canary
  // for ellipsis-driven false positives.
  const prose = 'Sure, here\'s the answer: the bug is in `bot.ts`…';
  assert.equal(checkIsProgressChunk(prose), false);
});

test('checkIsProgressChunk: progress line followed by real content', () => {
  // Mixed chunk: tick line + assistant prose. Must fall back to the
  // normal output path so the prose is delivered as a permanent message.
  const mixed = [
    '✽ Smooshing… (1m 49s · ↑ 3.3k tokens)',
    'Sure, here is the answer.',
  ].join('\n');
  assert.equal(checkIsProgressChunk(mixed), false);
});

test('checkIsProgressChunk: tool-call result line', () => {
  // `✓` is intentionally NOT in the progress-glyph set; tool-call
  // results must keep their permanent-output status.
  assert.equal(checkIsProgressChunk('✓ Bash(ls -la)'), false);
});

test('checkIsProgressChunk: tree-output line', () => {
  // `├─` / `└─` belong to tool tree output (subagent progress, file
  // listings) and must reach the user as content.
  assert.equal(checkIsProgressChunk('├─ src/bot.ts'), false);
});

test('checkIsProgressChunk: line with ellipsis but no token stats', () => {
  // The user's bug log included this shape during the "Compacted"
  // banner — a line with `…` but no `(Xm Ys · ↑/↓ X.Xk tokens)` stats
  // parenthesis. Must NOT collapse: the regex requires the stats block.
  assert.equal(checkIsProgressChunk('✻ Conversation compacted…'), false);
});

test('checkIsProgressChunk: line with token stats but no glyph', () => {
  // Future Claude UI change: tick reformatted without a leading glyph.
  // Stay conservative — treat as content until explicitly supported.
  assert.equal(checkIsProgressChunk('3m 5s · ↑ 1.0k tokens'), false);
});

test('checkIsProgressChunk: line with closing paren only at end-of-string', () => {
  // Trailing whitespace after `)` is allowed; trailing extra content
  // is not. Guards the `\)\s*$` anchor.
  const withTrailingContent =
    '✽ Smooshing… (1m 49s · ↑ 3.3k tokens) more stuff';
  assert.equal(checkIsProgressChunk(withTrailingContent), false);
});

test('checkIsProgressChunk: nested parens inside the thinking-note', () => {
  // `[^()]*` in the thinking-note explicitly forbids nested parens.
  // This guards against a real prose sentence with parentheticals
  // being mistaken for a tick by stretching the stats block.
  const withNestedParen =
    '✽ Smooshing… (1m 49s · ↑ 3.3k tokens · (oops nested))';
  assert.equal(checkIsProgressChunk(withNestedParen), false);
});

test('checkIsProgressChunk: glyph-led prose with a parenthetical is NOT progress', () => {
  // The 2026-06-11 paren widening must not admit real prose: no ellipsis
  // and no trailing `(time · tokens)` stats anchor here.
  assert.equal(checkIsProgressChunk('● Done (all tests pass).'), false);
});

test('checkIsProgressChunk: prose ending in ellipsis with a non-stats paren is NOT progress', () => {
  // Carries a parenthetical AND ends in `…`, but the end-anchored stats
  // parenthesis is missing — the widened title part must not stretch to
  // admit it, with or without a leading glyph.
  assert.equal(checkIsProgressChunk('Fixed the bug (see notes)…'), false);
  assert.equal(checkIsProgressChunk('✻ Fixed the bug (see notes)…'), false);
});
