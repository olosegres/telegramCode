/**
 * @description Unit tests for the pure auto-retry decision module
 * {@link ../apiErrorRetry} (plan S1). Covers the classifier (including the
 * "(not your usage limit)" disambiguation trap and the greedy-regex guard),
 * the best-effort reset-time parser, and the backoff plan / give-up boundaries.
 *
 * A FIXED `now` is used everywhere (no `Date.now()`), so the relative/absolute
 * time math is deterministic.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyAgentApiError,
  parseResetAt,
  getRetryPlan,
  decideRetryAction,
  retryRecurrenceGraceMs,
  usageLimitDefaultMs,
  resetBufferMs,
} from '../apiErrorRetry';
import { maxTimeoutMs } from '../scheduler/engine';

/** Fixed clock: 2026-06-09T10:00:00.000Z. Used as `now` in every test. */
const fixedNow = Date.parse('2026-06-09T10:00:00.000Z');

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;

/** The verbatim live transient string from claude.exe (the disambiguation trap). */
const liveTransientString =
  'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';

test('classify: verbatim live transient string → transient, NOT usageLimit (the "not your usage limit" trap)', () => {
  const result = classifyAgentApiError(liveTransientString, fixedNow);
  assert.deepEqual(result, { kind: 'transient' });
  assert.notEqual(result?.kind, 'usageLimit');
});

test('classify: rate-limit / overloaded / status-code phrasings → transient', () => {
  for (const text of [
    'Error: rate limited, please retry',
    'The model is overloaded',
    'Too Many Requests',
    'HTTP 429 returned by provider',
    'upstream responded with 503',
    'got a 529 from the API',
  ]) {
    assert.deepEqual(classifyAgentApiError(text, fixedNow), { kind: 'transient' }, text);
  }
});

test('classify: usage / credit / quota phrasings → usageLimit', () => {
  assert.equal(classifyAgentApiError('Claude usage limit reached', fixedNow)?.kind, 'usageLimit');
  assert.equal(classifyAgentApiError('Credit balance is too low', fixedNow)?.kind, 'usageLimit');
  assert.equal(classifyAgentApiError('You are out of credits', fixedNow)?.kind, 'usageLimit');
  assert.equal(classifyAgentApiError('monthly quota exhausted', fixedNow)?.kind, 'usageLimit');
});

test('classify: auth / non-retryable strings → null (must never be retried)', () => {
  assert.equal(classifyAgentApiError('Please run /login to continue', fixedNow), null);
  assert.equal(classifyAgentApiError('Invalid authentication credentials', fixedNow), null);
  assert.equal(classifyAgentApiError('You are not logged in', fixedNow), null);
});

test('classify: ordinary sentence containing "limit" → null (load-bearing: regex must not be greedy)', () => {
  assert.equal(
    classifyAgentApiError('There is no limit to what we can build', fixedNow),
    null,
  );
  assert.equal(classifyAgentApiError('Let us discuss the rate of progress', fixedNow), null);
});

test('parseResetAt: "resets in 2h" → now + 2h', () => {
  assert.equal(parseResetAt('Your limit resets in 2h', fixedNow), fixedNow + 2 * hourMs);
});

test('parseResetAt: "in 45m" → now + 45m', () => {
  assert.equal(parseResetAt('try again in 45m', fixedNow), fixedNow + 45 * minuteMs);
});

test('parseResetAt: "resets at 3pm" → a sensible future epoch ms (after now, same day)', () => {
  const parsed = parseResetAt('quota resets at 3pm today', fixedNow);
  assert.ok(typeof parsed === 'number');
  assert.ok(parsed > fixedNow, 'reset must be in the future relative to now');
  // 3pm local on the same calendar day as `now` (10:00Z) — within 24h ahead.
  assert.ok(parsed - fixedNow < 24 * hourMs);
  const resetDate = new Date(parsed);
  assert.equal(resetDate.getHours(), 15);
  assert.equal(resetDate.getMinutes(), 0);
});

test('parseResetAt: message with no time → undefined', () => {
  assert.equal(parseResetAt('Claude usage limit reached', fixedNow), undefined);
});

test('getRetryPlan: transient attempts 1/2/3 → 5/10/20 min', () => {
  assert.deepEqual(getRetryPlan({ kind: 'transient', attempt: 1, now: fixedNow }), {
    delayMs: 5 * minuteMs,
  });
  assert.deepEqual(getRetryPlan({ kind: 'transient', attempt: 2, now: fixedNow }), {
    delayMs: 10 * minuteMs,
  });
  assert.deepEqual(getRetryPlan({ kind: 'transient', attempt: 3, now: fixedNow }), {
    delayMs: 20 * minuteMs,
  });
});

test('getRetryPlan: transient attempt 4 → giveUp', () => {
  assert.deepEqual(getRetryPlan({ kind: 'transient', attempt: 4, now: fixedNow }), {
    giveUp: true,
  });
});

test('getRetryPlan: usageLimit with resetAt → delay to reset + buffer', () => {
  const resetAt = fixedNow + 3 * hourMs;
  assert.deepEqual(getRetryPlan({ kind: 'usageLimit', attempt: 1, resetAt, now: fixedNow }), {
    delayMs: 3 * hourMs + resetBufferMs,
  });
});

test('getRetryPlan: usageLimit without resetAt → 60m default', () => {
  assert.deepEqual(getRetryPlan({ kind: 'usageLimit', attempt: 1, now: fixedNow }), {
    delayMs: usageLimitDefaultMs,
  });
  assert.equal(usageLimitDefaultMs, 60 * minuteMs);
});

test('getRetryPlan: usageLimit attempt 7 → giveUp (max 6)', () => {
  assert.deepEqual(getRetryPlan({ kind: 'usageLimit', attempt: 7, now: fixedNow }), {
    giveUp: true,
  });
});

test('getRetryPlan: a far-future resetAt delay is clamped to maxTimeoutMs', () => {
  const resetAt = fixedNow + 1000 * 24 * hourMs; // ~1000 days out, well over the 24.8-day cap
  const plan = getRetryPlan({ kind: 'usageLimit', attempt: 1, resetAt, now: fixedNow });
  assert.ok('delayMs' in plan);
  assert.equal(plan.delayMs, maxTimeoutMs);
});

test('getRetryPlan: a resetAt already in the past clamps to 0 (never negative)', () => {
  const resetAt = fixedNow - 10 * minuteMs;
  const plan = getRetryPlan({ kind: 'usageLimit', attempt: 1, resetAt, now: fixedNow });
  assert.ok('delayMs' in plan);
  assert.equal(plan.delayMs, 0);
});

test('decideRetryAction: no prior record → arm attempt 1 at the first transient delay', () => {
  const result = decideRetryAction({ kind: 'transient', now: fixedNow, prev: null });
  assert.deepEqual(result, {
    action: 'arm',
    attempt: 1,
    delayMs: 5 * minuteMs,
    fireAt: fixedNow + 5 * minuteMs,
  });
});

test('decideRetryAction: a retry already pending → ignore (dedup the same error episode)', () => {
  const result = decideRetryAction({
    kind: 'transient',
    now: fixedNow,
    prev: { attempt: 1, firedAt: null, pending: true },
  });
  assert.deepEqual(result, { action: 'ignore' });
});

test('decideRetryAction: a prior fire WITHIN the grace window → escalate to attempt 2 (longer delay)', () => {
  const result = decideRetryAction({
    kind: 'transient',
    now: fixedNow,
    prev: { attempt: 1, firedAt: fixedNow - retryRecurrenceGraceMs, pending: false },
  });
  assert.deepEqual(result, {
    action: 'arm',
    attempt: 2,
    delayMs: 10 * minuteMs,
    fireAt: fixedNow + 10 * minuteMs,
  });
});

test('decideRetryAction: a prior fire BEYOND the grace window → fresh episode, back to attempt 1', () => {
  const result = decideRetryAction({
    kind: 'transient',
    now: fixedNow,
    prev: { attempt: 3, firedAt: fixedNow - retryRecurrenceGraceMs - 1, pending: false },
  });
  assert.deepEqual(result, {
    action: 'arm',
    attempt: 1,
    delayMs: 5 * minuteMs,
    fireAt: fixedNow + 5 * minuteMs,
  });
});

test('decideRetryAction: transient escalation past the cap → giveUp with attempts=3', () => {
  const result = decideRetryAction({
    kind: 'transient',
    now: fixedNow,
    // attempt 3 fired inside grace → next attempt is 4 → over the cap of 3.
    prev: { attempt: 3, firedAt: fixedNow - 1, pending: false },
  });
  assert.deepEqual(result, { action: 'giveUp', attempts: 3 });
});

test('decideRetryAction: usageLimit escalation past the cap → giveUp with attempts=6', () => {
  const result = decideRetryAction({
    kind: 'usageLimit',
    now: fixedNow,
    // attempt 6 fired inside grace → next attempt is 7 → over the cap of 6.
    prev: { attempt: 6, firedAt: fixedNow - 1, pending: false },
  });
  assert.deepEqual(result, { action: 'giveUp', attempts: 6 });
});
