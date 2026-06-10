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
  checkIsSubagentMode,
  subagentModeOptions,
  fallbackSubagentMode,
  buildSubagentStatusText,
  buildSubagentOutputPrefix,
} from '../utils/subagentRender';

describe('getSubagentPartAction — mode×part-kind matrix', () => {
  it('compact + text → status (child text never streams, only the rolling status)', () => {
    assert.equal(getSubagentPartAction('compact', 'text'), 'status');
  });

  it('full + text → stream (marked output via the separate child accumulator)', () => {
    assert.equal(getSubagentPartAction('full', 'text'), 'stream');
  });

  it('reasoning → ignore in EVERY mode (child chain-of-thought is never rendered)', () => {
    for (const mode of subagentModeOptions) {
      assert.equal(getSubagentPartAction(mode, 'reasoning'), 'ignore', `mode=${mode}`);
    }
  });

  it('compact + tool → ignore (a generic 🔧 status would overwrite the sub-agent status)', () => {
    assert.equal(getSubagentPartAction('compact', 'tool'), 'ignore');
  });

  it('full + tool → status (transient 🔧 flows; toolResult bodies stay suppressed elsewhere)', () => {
    assert.equal(getSubagentPartAction('full', 'tool'), 'status');
  });
});

describe('checkIsSubagentMode — narrows /subagent <arg> without a cast', () => {
  it('accepts every valid mode', () => {
    for (const mode of subagentModeOptions) {
      assert.equal(checkIsSubagentMode(mode), true, `mode=${mode}`);
    }
  });

  it('rejects unknown / empty / wrong-case input — incl. the locked-out "hide"', () => {
    assert.equal(checkIsSubagentMode('hide'), false, '/subagent is 2-state by design');
    assert.equal(checkIsSubagentMode(''), false);
    assert.equal(checkIsSubagentMode('Compact'), false);
  });
});

describe('mode options + fallback', () => {
  it('exactly two modes, compact first (the default)', () => {
    assert.deepEqual([...subagentModeOptions], ['compact', 'full']);
  });

  it('the pre-wiring fallback is the locked default (compact)', () => {
    assert.equal(fallbackSubagentMode, 'compact');
  });
});

describe('buildSubagentStatusText — compact-mode rolling status line', () => {
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

describe('buildSubagentOutputPrefix — full-mode chunk marker', () => {
  it('is a non-empty marked prefix', () => {
    const prefix = buildSubagentOutputPrefix();
    assert.ok(prefix.includes('🤖'));
    assert.ok(prefix.trim().length > 0);
  });
});
