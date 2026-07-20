/**
 * @description Idle-watchdog decision for the `claude-json-stream` adapter's
 * `isBusy` flag (`utils/jsonStreamBusyWatchdog`). `isBusy` clears in exactly one
 * place — a processed terminal `result` — so a single missed `result` hangs the
 * native "typing…" indicator forever (live: an idle topic firing
 * `sendChatAction('typing')` every 4s for an hour+). The watchdog is the bounded
 * safety net.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`): the watchdog fires ONLY on
 * genuine silence-with-nothing-in-flight, and EVERY in-flight signal (tool /
 * sub-agent / question / batched answer) vetoes it, so a legitimately long turn
 * (a long silent Bash, a long delegation, extended thinking, an unanswered
 * question) is never truncated. Silence — not wall-clock since turn start — is
 * the trigger.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkShouldClearBusyOnIdle, busyIdleWatchdogMs, type BusyIdleWatchdogInput } from '../utils/jsonStreamBusyWatchdog';

/** A busy, silent, nothing-in-flight session — the exact stuck-busy case. */
function stuck(overrides: Partial<BusyIdleWatchdogInput> = {}): BusyIdleWatchdogInput {
  return {
    isBusy: true,
    msSinceStdoutActivity: busyIdleWatchdogMs + 1,
    idleTimeoutMs: busyIdleWatchdogMs,
    outstandingToolCount: 0,
    subagentActive: false,
    hasPendingQuestion: false,
    hasUnflushedAnswer: false,
    ...overrides,
  };
}

test('fires: busy + silent past threshold + nothing in flight (the stuck-busy / missed-result case)', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck()), true);
});

test('does NOT fire while the session is not busy (nothing to clear)', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ isBusy: false })), false);
});

test('does NOT fire before the silence threshold (a brief inter-token gap)', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ msSinceStdoutActivity: busyIdleWatchdogMs - 1 })), false);
});

test('VETO: an outstanding tool (long silent Bash) keeps the turn alive', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ outstandingToolCount: 1 })), false);
});

test('VETO: an active sub-agent delegation keeps the turn alive', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ subagentActive: true })), false);
});

test('VETO: a pending user question keeps the turn alive (user just hasn\'t answered yet)', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ hasPendingQuestion: true })), false);
});

test('VETO: answer text still un-emitted in the batch is not "idle"', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ hasUnflushedAnswer: true })), false);
});

test('exactly at the threshold is treated as reached (>=)', () => {
  assert.equal(checkShouldClearBusyOnIdle(stuck({ msSinceStdoutActivity: busyIdleWatchdogMs })), true);
});

test('the default threshold is bounded well under the reported hour+ hang', () => {
  assert.ok(busyIdleWatchdogMs >= 30_000 && busyIdleWatchdogMs <= 5 * 60_000, `unexpected threshold: ${busyIdleWatchdogMs}`);
});
