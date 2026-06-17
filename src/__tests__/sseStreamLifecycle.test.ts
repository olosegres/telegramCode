/**
 * @description Pure decision logic for the OpenCode adapter's single
 * `/global/event` stream (plan 2026-06-17). `getSseStreamTransition` keys on the
 * TOTAL active-session count: the one global stream opens when the first session
 * ANYWHERE appears and closes when the last one (any folder) goes away. Each case
 * below proves one rule so a regression fails loudly; the adapter wiring that
 * consumes it is exercised separately in `openCodeSseStreamLifecycle.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getSseStreamTransition } from '../utils/sseStreamLifecycle';

// getSseStreamTransition — the open/close edge detector, driven by the TOTAL
// active-session count (open on first session anywhere, close on last).

test('zero → one total active session opens the global stream', () => {
  assert.equal(getSseStreamTransition(0, 1), 'open');
});

test('one → zero total active sessions closes the global stream', () => {
  assert.equal(getSseStreamTransition(1, 0), 'close');
});

test('one → two (a second session in any folder joins) is a no-op — stream already open', () => {
  assert.equal(getSseStreamTransition(1, 2), 'none');
});

test('two → one (one session anywhere leaves, one remains) is a no-op — stream stays open', () => {
  assert.equal(getSseStreamTransition(2, 1), 'none');
});

test('a larger total (3 → 2) is still a no-op — sessions across folders share the one stream', () => {
  assert.equal(getSseStreamTransition(3, 2), 'none');
});

test('zero → zero is a no-op', () => {
  assert.equal(getSseStreamTransition(0, 0), 'none');
});
