/**
 * @description Unit tests for `decideWedgeRecovery` — the 3-tier escalation for
 * recovering a WEDGED OpenCode session (accepted a prompt, ran no turn). Tiers
 * preserve the last dialog when possible and cap attempts so a persistently
 * wedging session cannot loop: resend(0) → fork(1) → restart(2) → giveUp.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideWedgeRecovery } from '../utils/wedgeRecovery';

describe('decideWedgeRecovery', () => {
  it('tier 0 → resend into the SAME session (transient stall, dialog intact)', () => {
    assert.equal(
      decideWedgeRecovery({ tier: 0, hasReplayPrompt: true, canFork: true }),
      'resend',
    );
  });

  it('tier 1 → fork when the adapter can fork (dialog preserved in a fresh session)', () => {
    assert.equal(
      decideWedgeRecovery({ tier: 1, hasReplayPrompt: true, canFork: true }),
      'fork',
    );
  });

  it('tier 1 → restart when the adapter cannot fork', () => {
    assert.equal(
      decideWedgeRecovery({ tier: 1, hasReplayPrompt: true, canFork: false }),
      'restart',
    );
  });

  it('tier 2 → restart (blank fresh session; the conversation itself is the poison)', () => {
    assert.equal(
      decideWedgeRecovery({ tier: 2, hasReplayPrompt: true, canFork: true }),
      'restart',
    );
  });

  it('tier 3 → giveUp (all tiers exhausted, no loop)', () => {
    assert.equal(
      decideWedgeRecovery({ tier: 3, hasReplayPrompt: true, canFork: true }),
      'giveUp',
    );
  });

  it('gives up at any tier when there is no cached prompt to replay', () => {
    for (const tier of [0, 1, 2]) {
      assert.equal(
        decideWedgeRecovery({ tier, hasReplayPrompt: false, canFork: true }),
        'giveUp',
        `tier ${tier} with no prompt must give up`,
      );
    }
  });

  it('full escalation path is resend → fork → restart → giveUp', () => {
    const path = [0, 1, 2, 3].map(tier =>
      decideWedgeRecovery({ tier, hasReplayPrompt: true, canFork: true }),
    );
    assert.deepEqual(path, ['resend', 'fork', 'restart', 'giveUp']);
  });
});
