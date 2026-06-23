/**
 * @description Load-bearing tests for the S4 Claude verbosity relay decision
 * layer (`utils/claudeRelayRouting.ts`). The relay has caused flood
 * regressions before, so these assert the REAL routing per segment×pref AND a
 * byte-identity regression anchor (full-prefs chunk → the pre-S4 strip output),
 * not just "no crash".
 *
 * The fixtures are classified via the real `classifyClaudeChunk` so the test
 * exercises the same tags the live relay sees, then routed through the pure
 * decision. The regression anchor additionally runs the FULL fast-path the
 * adapter takes (classify → fast-path predicate → strip the ORIGINAL chunk) and
 * compares it to `stripTuiElementsWithContext` on the same input.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyClaudeChunk,
  createInitialChunkContext,
  ClaudeChunkTag,
  type ClaudeChunkSegment,
} from '../utils/claudeChunkClassifier';
import {
  routeClaudeChunkSegments,
  checkIsClaudeRelayFastPath,
  getToolActivityLabel,
} from '../utils/claudeRelayRouting';
import { getTruncatedToolResult } from '../utils/toolResultRender';
import { stripTuiElementsWithContext } from '../adapters/claudeCliAdapter';
import type { DisplayVerbosityMode } from '../types';

/** Stand-ins for the i18n builders the live relay passes — kept simple and
 * distinctive so the assertions can detect them in the routed output. */
const buildToolActivity = (label: string): string => `ACTIVITY:${label || 'TOOL'}`;
const buildPanelActivity = (): string => 'PANEL_ACTIVITY';
const buildThinkingActivity = (): string => 'THINKING_ACTIVITY';
const buildThoughtCollapsed = (seconds: number): string => `THOUGHT:${seconds}`;
/** Stand-in for the i18n `toolResults.truncated_footer` the live relay passes. */
const truncationFooter = 'TRUNCATED_FOOTER';

/** Classify a chunk from a fresh context and route it at the given mode. The
 * tool-results and thinking prefs default to the SAME mode unless overridden,
 * matching the macro `/verbosity` behavior the existing tests assume. */
function routeAtMode(
  chunkText: string,
  mode: DisplayVerbosityMode,
  thinkingMode: DisplayVerbosityMode = mode,
) {
  const { segments } = classifyClaudeChunk(chunkText, createInitialChunkContext());
  return routeSegmentsAtMode(segments, mode, thinkingMode);
}

/** Route an explicit segment array (for cases the classifier can't synthesise
 * from a single chunk, e.g. a thinking body whose header streamed earlier). */
function routeSegmentsAtMode(
  segments: ClaudeChunkSegment[],
  mode: DisplayVerbosityMode,
  thinkingMode: DisplayVerbosityMode = mode,
) {
  return routeClaudeChunkSegments(
    segments,
    mode,
    thinkingMode,
    buildToolActivity,
    buildPanelActivity,
    buildThinkingActivity,
    buildThoughtCollapsed,
    truncationFooter,
  );
}

const toolHeader = '● *Bash*(yarn test)';
const toolBodyLong = [
  '  ⎿  line 1',
  '     line 2',
  '     line 3',
  '     line 4',
  '     line 5',
  '     line 6',
  '     line 7',
  '     line 8',
  '     line 9',
  '     line 10',
  '     line 11',
  '     line 12',
  '     line 13',
  '     line 14',
  '     line 15',
  '     line 16',
  '     line 17',
].join('\n');

describe('routeClaudeChunkSegments — prose is never swallowed', () => {
  it('prose is kept verbatim at every mode', () => {
    const prose = 'Here is the answer the user asked for.';
    for (const mode of ['minimal', 'short', 'full'] as DisplayVerbosityMode[]) {
      const routed = routeAtMode(prose, mode);
      assert.ok(routed.keptText.includes(prose), `prose kept at ${mode}`);
    }
  });

  it('prose between two tool calls survives a minimal fold', () => {
    const chunk = [toolHeader, '  ⎿  done', 'The real answer.', '● *Read*(a.ts)', '  ⎿  contents'].join('\n');
    const routed = routeAtMode(chunk, 'minimal');
    assert.ok(routed.keptText.includes('The real answer.'), 'prose survives the fold');
    assert.ok(!routed.keptText.includes('⎿'), 'no tool body leaked into permanent text');
  });
});

describe('routeClaudeChunkSegments — tool body by mode', () => {
  it('full → the whole body is kept', () => {
    const routed = routeAtMode([toolHeader, toolBodyLong].join('\n'), 'full');
    assert.ok(routed.keptText.includes(toolHeader), 'header kept');
    assert.ok(routed.keptText.includes('line 17'), 'the 17th body line is kept (no cap)');
    assert.equal(routed.activityLine, null, 'nothing folded at full');
  });

  it('short → body truncated via getTruncatedToolResult (15-line cap bites) + footer appended', () => {
    const { segments } = classifyClaudeChunk([toolHeader, toolBodyLong].join('\n'), createInitialChunkContext());
    const routed = routeClaudeChunkSegments(
      segments,
      'short',
      'short',
      buildToolActivity,
      buildPanelActivity,
      buildThinkingActivity,
      buildThoughtCollapsed,
      truncationFooter,
    );

    // The body segment is what the helper truncates; prove the routed kept text
    // equals header + the helper's truncation of that exact body segment.
    const bodySegment = segments.find(s => s.text.includes('line 1'));
    assert.ok(bodySegment, 'a body segment exists');
    const expectedBody = getTruncatedToolResult(bodySegment.text).text;

    assert.ok(routed.keptText.includes(toolHeader), 'header kept at short');
    assert.ok(routed.keptText.includes(expectedBody), 'body equals getTruncatedToolResult output');
    assert.ok(!routed.keptText.includes('line 17'), 'the 17th line is dropped by the 15-line cap');
    // Parity with OpenCode short mode: a capped body carries the footer hint.
    assert.ok(routed.keptText.includes(truncationFooter), 'truncation footer appended when the cap bites');
  });

  it('short → a SHORT body that fits the cap gets NO footer', () => {
    const routed = routeAtMode([toolHeader, '  ⎿  one short line'].join('\n'), 'short');
    assert.ok(!routed.keptText.includes(truncationFooter), 'no footer when the body was not capped');
  });

  it('minimal → body dropped, header folds into a 🔧 activity line', () => {
    const routed = routeAtMode([toolHeader, toolBodyLong].join('\n'), 'minimal');
    assert.equal(routed.keptText, '', 'nothing permanent at minimal');
    assert.equal(routed.activityLine, 'ACTIVITY:Bash', 'the Bash header folded into the activity line');
  });
});

describe('routeClaudeChunkSegments — orphan ⎿ tool result (S1)', () => {
  // The header was consumed by a prior poll's line-SET diff and an interleaved
  // prose sentence nulled the tool context, so the `⎿` output arrives with no
  // open kind. The classifier now opens a synthetic output kind → the router
  // must fold it at minimal exactly like a header-bearing body.
  const orphanResult = [
    '⎿  trace rows: 2199',
    '     first matching row at offset 12',
    '     scan completed in 41ms',
  ].join('\n');

  it('minimal → the orphan ⎿ block is FOLDED, never leaked into permanent text', () => {
    const routed = routeAtMode(orphanResult, 'minimal');
    assert.equal(routed.keptText, '', 'nothing permanent — the result is folded at minimal');
    assert.ok(!routed.keptText.includes('⎿'), 'the ⎿ marker never leaks as permanent output');
    assert.ok(!routed.keptText.includes('trace rows: 2199'), 'the result content never leaks');
    assert.ok(routed.activityLine?.startsWith('ACTIVITY:'), 'it folds into a 🔧 tool activity line');
  });

  it('full → the orphan ⎿ block is kept verbatim (tool body still visible)', () => {
    const routed = routeAtMode(orphanResult, 'full');
    assert.ok(routed.keptText.includes('trace rows: 2199'), 'the result line is kept at full');
    assert.ok(routed.keptText.includes('scan completed in 41ms'), 'the continuation is kept at full');
    assert.equal(routed.activityLine, null, 'nothing folded at full');
  });
});

describe('routeClaudeChunkSegments — thinking block by mode (S5)', () => {
  // A finished reasoning block: the duration-bearing header + a `⎿` summary
  // body, classified together into one ThinkingBlock segment.
  const thinkingBlock = ['Thinking for *1m 6s*…', '  ⎿  Weighing the cache trade-offs'].join('\n');

  it('full → the thinking block is kept verbatim, nothing folded', () => {
    const routed = routeAtMode(thinkingBlock, 'full');
    assert.ok(routed.keptText.includes('Thinking for'), 'thinking header kept at full');
    assert.ok(routed.keptText.includes('Weighing the cache trade-offs'), 'thinking body kept at full');
    assert.equal(routed.activityLine, null, 'nothing folded at full');
  });

  it('short WITH a parseable duration → single "💭 thought for {N}s" line, nothing folded', () => {
    // tool-results mode 'full' so only the thinking pref drives the branch.
    const routed = routeAtMode(thinkingBlock, 'full', 'short');
    // 1m 6s = 66s → the builder stub renders `THOUGHT:66`.
    assert.equal(routed.keptText, 'THOUGHT:66', 'collapsed to the single thought-for line');
    assert.ok(!routed.keptText.includes('Weighing'), 'the reasoning body is dropped at short');
    assert.equal(routed.activityLine, null, 'short-with-duration collapses permanently, folds nothing');
  });

  it('short WITHOUT a parseable duration → nothing permanent, live thinking folds to status', () => {
    // A thinking block whose duration header streamed in a PRIOR poll, so this
    // chunk carries only the reasoning body — no `for …s` clause to parse. short
    // cannot collapse it, so it folds the live status instead of dropping it.
    const bodyOnlyThinking: ClaudeChunkSegment[] = [
      { tag: ClaudeChunkTag.ThinkingBlock, text: '  ⎿  Considering the cache trade-offs' },
    ];
    const routed = routeSegmentsAtMode(bodyOnlyThinking, 'full', 'short');
    assert.equal(routed.keptText, '', 'nothing permanent when short cannot parse a duration');
    assert.equal(routed.activityLine, 'THINKING_ACTIVITY', 'live thinking folded to status instead');
  });

  it('minimal (even WITH a duration) → nothing permanent, live thinking folds to status', () => {
    const routed = routeAtMode(thinkingBlock, 'full', 'minimal');
    assert.equal(routed.keptText, '', 'nothing permanent at minimal');
    assert.equal(routed.activityLine, 'THINKING_ACTIVITY', 'live thinking folded to status at minimal');
  });
});

describe('routeClaudeChunkSegments — panel preview & chrome', () => {
  it('a sub-agent panel preview is ALWAYS folded (even at full)', () => {
    // A `⎿ Tool(…)` preview under a running ◯ panel — the overview-2 flood.
    const chunk = [
      '  ◯ general-purpose  Implement fix                          26m 9s',
      '⎿  Bash(cd /repo && yarn build)',
      '… +80 tool uses',
    ].join('\n');
    for (const mode of ['minimal', 'short', 'full'] as DisplayVerbosityMode[]) {
      const routed = routeAtMode(chunk, mode);
      assert.ok(!routed.keptText.includes('+80 tool uses'), `panel preview not permanent at ${mode}`);
      assert.equal(routed.activityLine, 'PANEL_ACTIVITY', `panel folded to activity at ${mode}`);
    }
  });

  it('chrome is dropped, contributes no activity', () => {
    const routed = routeAtMode('╭─────────╮', 'full');
    assert.equal(routed.keptText, '', 'chrome produces no permanent text');
    assert.equal(routed.activityLine, null, 'chrome produces no activity');
  });
});

describe('getToolActivityLabel', () => {
  it('extracts the tool name from a header line', () => {
    assert.equal(getToolActivityLabel('● *Bash*(yarn test)'), 'Bash');
    assert.equal(getToolActivityLabel('✓ Read(/a/b.ts)'), 'Read');
  });
  it('falls back to the trimmed first line for an unrecognised header', () => {
    assert.equal(getToolActivityLabel('  weird header  '), 'weird header');
  });
});

describe('checkIsClaudeRelayFastPath — the regression-anchor predicate', () => {
  it('all-full prefs + no panel preview → fast path', () => {
    const { segments } = classifyClaudeChunk([toolHeader, toolBodyLong, 'prose'].join('\n'), createInitialChunkContext());
    assert.equal(checkIsClaudeRelayFastPath(segments, 'full', 'full'), true);
  });
  it('a panel preview disables the fast path even at all-full', () => {
    const { segments } = classifyClaudeChunk(['  ◯ agent  task  1s', '⎿  Bash(x)', '… +3 tool uses'].join('\n'), createInitialChunkContext());
    assert.equal(checkIsClaudeRelayFastPath(segments, 'full', 'full'), false);
  });
  it('any non-full pref disables the fast path', () => {
    const { segments } = classifyClaudeChunk(toolHeader, createInitialChunkContext());
    assert.equal(checkIsClaudeRelayFastPath(segments, 'short', 'full'), false);
    assert.equal(checkIsClaudeRelayFastPath(segments, 'full', 'short'), false);
    assert.equal(checkIsClaudeRelayFastPath(segments, 'minimal', 'minimal'), false);
  });
});

describe('REGRESSION ANCHOR — full-prefs chunk emits byte-identically to pre-S4', () => {
  it('tool header + body + prose, no panel → fast path feeds the ORIGINAL chunk to the stripper', () => {
    // A realistic mixed chunk WITHOUT a sub-agent panel preview.
    const chunk = [
      '● *Bash*(yarn lint)',
      '  ⎿  0 problems',
      '     done',
      'The lint passed, here is what I changed.',
    ].join('\n');

    const { segments } = classifyClaudeChunk(chunk, createInitialChunkContext());

    // Property 1: at all-full prefs with no panel preview, the relay takes the
    // fast path — whose strip INPUT is the original chunk unchanged. The pre-S4
    // emit was exactly `stripTuiElementsWithContext(chunk).text`, so the fast
    // path is byte-identical by construction.
    assert.equal(checkIsClaudeRelayFastPath(segments, 'full', 'full'), true, 'fast path taken');

    // Property 2 (defence in depth): even the QUIET path's reassembly is a
    // no-op for this chunk — routing at full prefs keeps every non-chrome line,
    // so `stripTuiElementsWithContext(keptText)` equals the direct strip of the
    // original. This proves the two paths converge here, not just that one call
    // equals itself.
    const directStrip = stripTuiElementsWithContext(chunk, null).text;
    const routed = routeClaudeChunkSegments(
      segments,
      'full',
      'full',
      buildToolActivity,
      buildPanelActivity,
      buildThinkingActivity,
      buildThoughtCollapsed,
      truncationFooter,
    );
    const quietPathStrip = stripTuiElementsWithContext(routed.keptText, null).text;
    assert.equal(quietPathStrip, directStrip, 'full-prefs routed strip == pre-S4 direct strip (byte-identical)');
    assert.equal(routed.activityLine, null, 'no activity folded at full prefs');
  });
});
