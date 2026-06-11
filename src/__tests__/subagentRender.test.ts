/**
 * @description Unit tests for the sub-agent render helpers
 * (`utils/subagentRender.ts`, S4). The mode×part-kind matrix is what the
 * OpenCode adapter consults on its SSE hot path for CHILD-session events, so
 * every cell is load-bearing: a wrong cell either dumps the child transcript
 * inline again (the original bug) or silently mutes it in `full` mode.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSubagentPartAction,
  buildSubagentStatusText,
  buildDelegatingStatusText,
  buildSubagentOutputPrefix,
} from '../utils/subagentRender';
import { displayVerbosityModeOptions } from '../utils/displayVerbosity';

describe('getSubagentPartAction — mode×part-kind matrix', () => {
  it('short + text → status (child text never streams, only the rolling status)', () => {
    assert.equal(getSubagentPartAction('short', 'text'), 'status');
  });

  it('minimal behaves EXACTLY like short (v1 equivalence: status-only, indicator never hidden)', () => {
    for (const partKind of ['text', 'tool', 'reasoning'] as const) {
      assert.equal(
        getSubagentPartAction('minimal', partKind),
        getSubagentPartAction('short', partKind),
        `partKind=${partKind}`,
      );
    }
  });

  it('full + text → stream (marked output via the separate child accumulator)', () => {
    assert.equal(getSubagentPartAction('full', 'text'), 'stream');
  });

  it('reasoning → ignore in EVERY mode (child chain-of-thought is never rendered)', () => {
    for (const mode of displayVerbosityModeOptions) {
      assert.equal(getSubagentPartAction(mode, 'reasoning'), 'ignore', `mode=${mode}`);
    }
  });

  it('short + tool → ignore (a generic 🔧 status would overwrite the sub-agent status)', () => {
    assert.equal(getSubagentPartAction('short', 'tool'), 'ignore');
  });

  it('full + tool → status (transient 🔧 flows; toolResult bodies stay suppressed elsewhere)', () => {
    assert.equal(getSubagentPartAction('full', 'tool'), 'status');
  });
});

describe('buildSubagentStatusText — status-only-mode rolling status line', () => {
  it('embeds the delegation title and the sub-agent marker', () => {
    const status = buildSubagentStatusText('Count TS files in src/utils');
    assert.ok(status.includes('Count TS files in src/utils'), 'title embedded');
    assert.ok(status.includes('🤖'), 'sub-agent marker present');
  });

  it('null title falls back to a non-empty generic label (never "null")', () => {
    const status = buildSubagentStatusText(null);
    assert.ok(!status.includes('null'));
    assert.ok(status.includes('🤖'));
    assert.ok(status.length > '🤖 '.length, 'fallback label is non-empty');
  });
});

describe('buildDelegatingStatusText — parent-side "Delegating" activity status (S5)', () => {
  it('embeds the delegation title and the sub-agent marker', () => {
    const status = buildDelegatingStatusText('Count TS files in src/utils');
    assert.ok(status.includes('Count TS files in src/utils'), 'title embedded');
    assert.ok(status.includes('🤖'), 'sub-agent marker present');
  });

  it('null title falls back to a non-empty generic label (never "null")', () => {
    const status = buildDelegatingStatusText(null);
    assert.ok(!status.includes('null'));
    assert.ok(status.includes('🤖'));
    assert.ok(status.length > '🤖 '.length, 'fallback label is non-empty');
  });

  it('is distinct from the status-only sub-agent status for the same title', () => {
    // The two statuses cover different phases (parent's task tool in flight vs
    // child streaming) — identical strings would mean the dedicated
    // "Delegating" label silently collapsed into the generic one.
    assert.notEqual(buildDelegatingStatusText('t'), buildSubagentStatusText('t'));
  });
});

describe('buildSubagentOutputPrefix — full-mode chunk marker', () => {
  it('is a non-empty marked prefix', () => {
    const prefix = buildSubagentOutputPrefix();
    assert.ok(prefix.includes('🤖'));
    assert.ok(prefix.trim().length > 0);
  });
});
