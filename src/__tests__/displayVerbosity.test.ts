/**
 * @description Unit tests for the shared display-verbosity vocabulary
 * (`utils/displayVerbosity.ts`, plan 2026-06-11 S1): the unified option set,
 * the locked `minimal` default, the type guard, and — load-bearing for every
 * `state.json` written before the unification — the legacy-name normalization
 * (`detailed`/`brief`/`hide`/`compact` must keep meaning what they meant).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkIsDisplayVerbosityMode,
  defaultDisplayVerbosityMode,
  displayVerbosityModeOptions,
  normalizeDisplayVerbosityMode,
} from '../utils/displayVerbosity';

describe('displayVerbosityModeOptions + default', () => {
  it('exactly three modes in picker order: minimal, short, full', () => {
    assert.deepEqual([...displayVerbosityModeOptions], ['minimal', 'short', 'full']);
  });

  it('the locked default is minimal (user decision: quiet by default)', () => {
    assert.equal(defaultDisplayVerbosityMode, 'minimal');
  });
});

describe('checkIsDisplayVerbosityMode — narrows without a cast', () => {
  it('accepts every valid mode', () => {
    for (const mode of displayVerbosityModeOptions) {
      assert.equal(checkIsDisplayVerbosityMode(mode), true, `mode=${mode}`);
    }
  });

  it('rejects unknown / empty / wrong-case input AND legacy names (guard ≠ normalizer)', () => {
    assert.equal(checkIsDisplayVerbosityMode('verbose'), false);
    assert.equal(checkIsDisplayVerbosityMode(''), false);
    assert.equal(checkIsDisplayVerbosityMode('Minimal'), false);
    // Legacy names are NOT part of the new vocabulary — only the normalizer
    // maps them; the guard must reject so they never persist as-is.
    assert.equal(checkIsDisplayVerbosityMode('brief'), false);
    assert.equal(checkIsDisplayVerbosityMode('compact'), false);
  });
});

describe('normalizeDisplayVerbosityMode — legacy names keep their behavior', () => {
  it('new names pass through unchanged', () => {
    for (const mode of displayVerbosityModeOptions) {
      assert.equal(normalizeDisplayVerbosityMode(mode), mode, `mode=${mode}`);
    }
  });

  it('each legacy name maps to the mode with the SAME behavior', () => {
    // thinking: keep the full streamed reasoning
    assert.equal(normalizeDisplayVerbosityMode('detailed'), 'full');
    // thinking: collapse to "thought for {N}s"
    assert.equal(normalizeDisplayVerbosityMode('brief'), 'short');
    // thinking/tool-results: nothing permanent remains
    assert.equal(normalizeDisplayVerbosityMode('hide'), 'minimal');
    // subagent: status-only
    assert.equal(normalizeDisplayVerbosityMode('compact'), 'short');
  });

  it('unknown / empty / wrong-case / undefined → null (caller picks default vs reject)', () => {
    assert.equal(normalizeDisplayVerbosityMode('verbose'), null);
    assert.equal(normalizeDisplayVerbosityMode(''), null);
    assert.equal(normalizeDisplayVerbosityMode('Brief'), null);
    assert.equal(normalizeDisplayVerbosityMode(undefined), null);
  });
});
