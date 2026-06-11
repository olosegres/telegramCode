/**
 * @description Unit tests for the `/verbosity` picker-state decision
 * (`utils/verbosityRender.ts`, plan 2026-06-11 S2): the ✓ marker shows a
 * level ONLY when all three display prefs equal it; ANY divergence is the
 * mixed ("custom") state — no marker, three values spelled out by the caller.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedThreadDisplayPrefs } from '../types';
import { displayVerbosityModeOptions } from '../utils/displayVerbosity';
import { getUniformVerbosityLevel } from '../utils/verbosityRender';

describe('getUniformVerbosityLevel — uniform prefs', () => {
  it('returns the shared level for each of the three modes', () => {
    for (const mode of displayVerbosityModeOptions) {
      const prefs: ResolvedThreadDisplayPrefs = {
        thinking: mode,
        toolResults: mode,
        subagent: mode,
      };
      assert.equal(getUniformVerbosityLevel(prefs), mode, `mode=${mode}`);
    }
  });
});

describe('getUniformVerbosityLevel — mixed prefs → null (custom)', () => {
  it('thinking diverging from the other two → null', () => {
    const prefs: ResolvedThreadDisplayPrefs = {
      thinking: 'full',
      toolResults: 'minimal',
      subagent: 'minimal',
    };
    assert.equal(getUniformVerbosityLevel(prefs), null);
  });

  it('toolResults diverging from the other two → null', () => {
    const prefs: ResolvedThreadDisplayPrefs = {
      thinking: 'short',
      toolResults: 'full',
      subagent: 'short',
    };
    assert.equal(getUniformVerbosityLevel(prefs), null);
  });

  it('subagent diverging from the other two → null', () => {
    const prefs: ResolvedThreadDisplayPrefs = {
      thinking: 'minimal',
      toolResults: 'minimal',
      subagent: 'full',
    };
    assert.equal(getUniformVerbosityLevel(prefs), null);
  });

  it('all three different → null', () => {
    const prefs: ResolvedThreadDisplayPrefs = {
      thinking: 'minimal',
      toolResults: 'short',
      subagent: 'full',
    };
    assert.equal(getUniformVerbosityLevel(prefs), null);
  });
});
