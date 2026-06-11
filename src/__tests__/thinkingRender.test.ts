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
} from '../utils/thinkingRender';
import { displayVerbosityModeOptions } from '../utils/displayVerbosity';

describe('getThinkingEventAction — mode × phase matrix', () => {
  // The live indicator is shown in ALL three modes while reasoning; the mode
  // only controls what remains after reasoning ends. These assertions are the
  // load-bearing proof of that contract.

  it('full/live → editLiveDetailed (full reasoning text appended)', () => {
    assert.equal(getThinkingEventAction('full', 'live'), 'editLiveDetailed');
  });
  it('full/done → keep (message persists, id detaches)', () => {
    assert.equal(getThinkingEventAction('full', 'done'), 'keep');
  });

  it('short/live → editLiveLabel (label only, no body)', () => {
    assert.equal(getThinkingEventAction('short', 'live'), 'editLiveLabel');
  });
  it('short/done → collapseToDuration ("thought for Ns")', () => {
    assert.equal(getThinkingEventAction('short', 'done'), 'collapseToDuration');
  });

  it('minimal/live → editLiveLabel (live indicator still shown, never suppressed)', () => {
    assert.equal(getThinkingEventAction('minimal', 'live'), 'editLiveLabel');
  });
  it('minimal/done → holdForAnswer (indicator stays, id kept for answer-start delete)', () => {
    // CRITICAL: minimal+done must NOT collapse or detach — removal happens on
    // the separate answer-start trigger. If this returned `keep`, the id would
    // detach and the answer-start delete could never find the message.
    assert.equal(getThinkingEventAction('minimal', 'done'), 'holdForAnswer');
  });
});

describe('getThinkingAnswerStartAction — only minimal removes the message', () => {
  it('minimal → delete (nothing remains once the answer starts)', () => {
    assert.equal(getThinkingAnswerStartAction('minimal'), 'delete');
  });
  it('short → noop (collapsed "thought for Ns" line persists)', () => {
    assert.equal(getThinkingAnswerStartAction('short'), 'noop');
  });
  it('full → noop (full reasoning persists)', () => {
    assert.equal(getThinkingAnswerStartAction('full'), 'noop');
  });

  it('only minimal ever deletes — exhaustive over all modes', () => {
    for (const mode of displayVerbosityModeOptions) {
      const action = getThinkingAnswerStartAction(mode);
      assert.equal(action === 'delete', mode === 'minimal', `mode=${mode}`);
    }
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
