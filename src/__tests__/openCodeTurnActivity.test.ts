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
  checkIsWedgedTurn,
  type OpenCodeTurnActivityState,
} from '../utils/openCodeTurnActivity';

const base: OpenCodeTurnActivityState = {
  awaitingResponse: true,
  sawActivity: false,
  wasCompacting: false,
  hadPendingProviderRetry: false,
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
