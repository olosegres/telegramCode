/**
 * @description S2 — pure decision behind the GROUP output transport's
 * `finalizeInFlight` reconcile (`utils/groupFinalizePlan`). At a settle/teardown
 * boundary the bot must force-deliver the coalesced-but-unsent remainder (so the
 * agent's final answer is never discarded) but must NOT double-post a turn that
 * already fully landed.
 *
 * Load-bearing per `rules/tests.md`: the assertions prove the remainder
 * semantics (what text is sent, and its continuation flag), not just "no crash".
 * The group queue already separates landed (`lastMessageText`) from pending
 * (`pendingOutput`), so the remainder IS `pendingOutput` — these tests pin that a
 * pending buffer drains exactly once and a delivered turn is a no-op.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getGroupFinalizePlan } from '../utils/groupFinalizePlan';

test('fully-delivered turn (no pending remainder) → noop, no duplicate post', () => {
  assert.deepEqual(
    getGroupFinalizePlan({ pendingOutput: null, pendingIsContinuation: false }),
    { action: 'noop' },
  );
});

test('a whitespace-only buffer → noop (a blank send would only earn a Telegram error)', () => {
  assert.deepEqual(
    getGroupFinalizePlan({ pendingOutput: '   \n\t', pendingIsContinuation: false }),
    { action: 'noop' },
  );
});

test('a turn whose last landed text lags → finalize sends exactly the pending remainder', () => {
  const plan = getGroupFinalizePlan({
    pendingOutput: 'the tail that never flushed',
    pendingIsContinuation: true,
  });
  assert.deepEqual(plan, {
    action: 'send',
    text: 'the tail that never flushed',
    isContinuation: true,
  });
});

test('a fresh (non-continuation) remainder finalizes as a new message', () => {
  const plan = getGroupFinalizePlan({
    pendingOutput: 'the settled final answer',
    pendingIsContinuation: false,
  });
  assert.deepEqual(plan, {
    action: 'send',
    text: 'the settled final answer',
    isContinuation: false,
  });
});
