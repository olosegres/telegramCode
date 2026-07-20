/**
 * @description Loop-level backstop decision for the native "agent is typing…"
 * indicator (`utils/typingLoopBackstop`). The typing loop self-stops only when
 * `checkShouldKeepTyping` (`isOutputStreaming || isAdapterBusy`) goes false and
 * has NO absolute bound. `jsonStreamBusyWatchdog` covers a stuck `isBusy`; this
 * backstop covers the OTHER input — a leaked `debounceTimer` that pins
 * `isOutputStreaming` true forever (live 2026-07-19: a json-stream group topic
 * fired `sendChatAction('typing')` every 4s for an hour+ after a clean turn end
 * because the `isFinal` fast-path in `queueOutput` cleared the debounce timer but
 * left the handle non-null).
 *
 * Load-bearing intent (per `.claude/rules/tests.md`): the backstop fires ONLY on
 * a PROVABLE inconsistency — an armed debounce handle over an otherwise-empty,
 * not-busy queue — and EVERY genuine in-flight signal (adapter busy / DM draft /
 * pending text / active send) vetoes it. So it truncates a leak, never a
 * legitimately long turn (a long silent Bash/Task tool keeps the adapter busy).
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkIsTypingStuckByLeak, type TypingLoopBackstopInput } from '../utils/typingLoopBackstop';

/** The exact leak: idle adapter, empty queue, but a dead debounce handle lingers. */
function leaked(overrides: Partial<TypingLoopBackstopInput> = {}): TypingLoopBackstopInput {
  return {
    isAdapterBusy: false,
    isTransportStreaming: false,
    hasPendingOutput: false,
    isProcessing: false,
    hasDebounceTimer: true,
    ...overrides,
  };
}

test('fires: idle adapter + empty queue + a lingering debounce handle (the isFinal leak)', () => {
  assert.equal(checkIsTypingStuckByLeak(leaked()), true);
});

test('does NOT fire when no debounce handle lingers (the queue is truly drained → loop self-stops)', () => {
  assert.equal(checkIsTypingStuckByLeak(leaked({ hasDebounceTimer: false })), false);
});

test('VETO: a genuinely busy adapter (a long silent Bash/Task tool) is never cut', () => {
  assert.equal(checkIsTypingStuckByLeak(leaked({ isAdapterBusy: true })), false);
});

test('VETO: a live DM draft cursor is a legitimate stream, not this leak', () => {
  assert.equal(checkIsTypingStuckByLeak(leaked({ isTransportStreaming: true })), false);
});

test('VETO: real text still waiting to send is genuine streaming', () => {
  assert.equal(checkIsTypingStuckByLeak(leaked({ hasPendingOutput: true })), false);
});

test('VETO: an in-flight send (possibly a slow API call) is not a provable leak', () => {
  assert.equal(checkIsTypingStuckByLeak(leaked({ isProcessing: true })), false);
});

test('a busy turn that also happens to have a debounce armed is never cut (busy wins)', () => {
  assert.equal(
    checkIsTypingStuckByLeak(leaked({ isAdapterBusy: true, hasPendingOutput: true })),
    false,
  );
});
