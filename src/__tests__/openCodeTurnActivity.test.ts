/**
 * @description Unit tests for `checkIsWedgedTurn` — the OpenCode "prompt
 * delivered but the agent never ran a turn" detector. This backs the fix for
 * the silent-hang bug (live 2026-08-15, the my-news digest schedule): a bloated
 * session accepted every prompt (HTTP 204) but its agent loop exited at step 0
 * with no assistant activity, so `session.idle` arrived with zero output and the
 * topic looked dead. Each guard is load-bearing: a false positive fires the
 * scary "session stuck" notice on a healthy turn, a false negative brings the
 * silent hang back.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkIsReplacementTurnMissing,
  checkIsWedgedTurn,
  type OpenCodeReplacementTurnState,
  type OpenCodeTurnActivityState,
} from '../utils/openCodeTurnActivity';

const base: OpenCodeTurnActivityState = {
  awaitingResponse: true,
  sawActivity: false,
  wasCompacting: false,
  hadPendingProviderRetry: false,
};

const replacementBase: OpenCodeReplacementTurnState = {
  isSessionActive: true,
  isAwaitingReplacementStart: true,
  sawActivity: false,
};

describe('checkIsWedgedTurn', () => {
  it('flags a delivered prompt that produced NO assistant activity (the wedge)', () => {
    assert.equal(checkIsWedgedTurn(base), true);
  });

  it('does not flag when the turn produced assistant activity', () => {
    assert.equal(checkIsWedgedTurn({ ...base, sawActivity: true }), false);
  });

  it('does not flag an idle with no pending prompt (resume / spurious idle)', () => {
    assert.equal(checkIsWedgedTurn({ ...base, awaitingResponse: false }), false);
  });

  it('does not flag a compaction cycle (legitimately idles with no text)', () => {
    assert.equal(checkIsWedgedTurn({ ...base, wasCompacting: true }), false);
  });

  it('does not flag while a provider retry is still pending (turn stays alive)', () => {
    assert.equal(checkIsWedgedTurn({ ...base, hadPendingProviderRetry: true }), false);
  });

  it('activity wins even if a prompt was awaited (sub-agent-only delegation still counts)', () => {
    assert.equal(
      checkIsWedgedTurn({ ...base, sawActivity: true, awaitingResponse: true }),
      false,
    );
  });
});

/**
 * @description Unit tests for `checkIsReplacementTurnMissing` — the bound on how
 * long a post-provider-retry REPLACEMENT prompt may take to start its turn.
 *
 * `session.status` carries no turn identifier, so after aborting a stale
 * provider-managed retry the adapter waits for the next `busy` to mark the
 * replacement turn's start. A wedged session accepts the replacement (HTTP 204)
 * and never runs it, so that `busy` never arrives — the boundary latched
 * forever, the topic reported busy indefinitely, every later idle was swallowed,
 * and the wedged-turn detector stayed disarmed because this path defers arming
 * it to that same `busy`. Each guard is load-bearing: reporting when the turn
 * DID start restarts a healthy conversation, and not reporting restores the
 * permanent hang.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */
describe('checkIsReplacementTurnMissing', () => {
  it('flags a replacement prompt whose turn never started (the permanent hang)', () => {
    assert.equal(checkIsReplacementTurnMissing(replacementBase), true);
  });

  it('does not flag once the boundary was released by an observed busy', () => {
    assert.equal(
      checkIsReplacementTurnMissing({ ...replacementBase, isAwaitingReplacementStart: false }),
      false,
    );
  });

  it('does not flag a torn-down session (its thread was stopped, not hung)', () => {
    assert.equal(
      checkIsReplacementTurnMissing({ ...replacementBase, isSessionActive: false }),
      false,
    );
  });

  it('does not flag when assistant activity proves the turn ran despite a missed busy', () => {
    assert.equal(
      checkIsReplacementTurnMissing({ ...replacementBase, sawActivity: true }),
      false,
    );
  });
});
