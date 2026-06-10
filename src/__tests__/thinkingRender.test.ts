/**
 * @description Unit tests for the pure thinking-render decision helpers
 * (`utils/thinkingRender.ts`) consumed by `bot.ts`'s `handleAgentThinking`
 * (S2). The mode×phase matrix, the answer-start removal rule, and the
 * "thought for {N}s" duration formatter are unit-testable without the Telegraf
 * machinery (same pattern as `statusFlushDecision.test.ts`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getThinkingEventAction,
  getThinkingAnswerStartAction,
  formatThinkingDurationSeconds,
  checkIsThinkingMode,
  thinkingModeOptions,
} from '../utils/thinkingRender';
import type { ThinkingMode } from '../types';

describe('getThinkingEventAction — mode × phase matrix', () => {
  // The live indicator is shown in ALL three modes while reasoning; the mode
  // only controls what remains after reasoning ends. These assertions are the
  // load-bearing proof of that contract.

  it('detailed/live → editLiveDetailed (full reasoning text appended)', () => {
    assert.equal(getThinkingEventAction('detailed', 'live'), 'editLiveDetailed');
  });
  it('detailed/done → keep (message persists, id detaches)', () => {
    assert.equal(getThinkingEventAction('detailed', 'done'), 'keep');
  });

  it('brief/live → editLiveLabel (label only, no body)', () => {
    assert.equal(getThinkingEventAction('brief', 'live'), 'editLiveLabel');
  });
  it('brief/done → collapseToDuration ("thought for Ns")', () => {
    assert.equal(getThinkingEventAction('brief', 'done'), 'collapseToDuration');
  });

  it('hide/live → editLiveLabel (live indicator still shown, never suppressed)', () => {
    assert.equal(getThinkingEventAction('hide', 'live'), 'editLiveLabel');
  });
  it('hide/done → holdForAnswer (indicator stays, id kept for answer-start delete)', () => {
    // CRITICAL: hide+done must NOT collapse or detach — removal happens on the
    // separate answer-start trigger. If this returned `keep`, the id would
    // detach and the answer-start delete could never find the message.
    assert.equal(getThinkingEventAction('hide', 'done'), 'holdForAnswer');
  });
});

describe('getThinkingAnswerStartAction — only hide removes the message', () => {
  it('hide → delete (nothing remains once the answer starts)', () => {
    assert.equal(getThinkingAnswerStartAction('hide'), 'delete');
  });
  it('brief → noop (collapsed "thought for Ns" line persists)', () => {
    assert.equal(getThinkingAnswerStartAction('brief'), 'noop');
  });
  it('detailed → noop (full reasoning persists)', () => {
    assert.equal(getThinkingAnswerStartAction('detailed'), 'noop');
  });

  it('only hide ever deletes — exhaustive over all modes', () => {
    const modes: ThinkingMode[] = ['detailed', 'brief', 'hide'];
    for (const mode of modes) {
      const action = getThinkingAnswerStartAction(mode);
      assert.equal(action === 'delete', mode === 'hide', `mode=${mode}`);
    }
  });
});

describe('checkIsThinkingMode — narrows /thinking <arg> without a cast', () => {
  it('accepts every valid mode', () => {
    for (const mode of thinkingModeOptions) {
      assert.equal(checkIsThinkingMode(mode), true, `mode=${mode}`);
    }
  });
  it('rejects unknown / empty / wrong-case input', () => {
    assert.equal(checkIsThinkingMode('verbose'), false);
    assert.equal(checkIsThinkingMode(''), false);
    assert.equal(checkIsThinkingMode('Brief'), false);
  });
});

describe('formatThinkingDurationSeconds — ms → whole seconds', () => {
  it('rounds to the nearest second', () => {
    assert.equal(formatThinkingDurationSeconds(2400), 2);
    assert.equal(formatThinkingDurationSeconds(2600), 3);
    assert.equal(formatThinkingDurationSeconds(12_000), 12);
  });

  it('floors at 1s — a sub-second burst never reads "thought for 0s"', () => {
    assert.equal(formatThinkingDurationSeconds(400), 1);
    assert.equal(formatThinkingDurationSeconds(1), 1);
  });

  it('guards against non-positive / non-finite input', () => {
    assert.equal(formatThinkingDurationSeconds(0), 1);
    assert.equal(formatThinkingDurationSeconds(-500), 1);
    assert.equal(formatThinkingDurationSeconds(Number.NaN), 1);
  });
});
