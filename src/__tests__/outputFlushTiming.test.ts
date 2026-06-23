/**
 * @description Unit tests for {@link getOutputFlushTiming} — the pure decision
 * the output queue in `bot.ts` consults to choose WHEN to flush a queued frame
 * (plan S3). Extracted so the final-frame / cooldown-stretch rule is testable
 * without the Telegraf / queue machinery (same pattern as
 * `statusFlushDecision.test.ts`).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getOutputFlushTiming, rateLimitedOutputDebounceMs } from '../utils/outputFlushTiming';

const normalDebounceMs = 1000;

test("final frame flushes now even while rate-limited (turn never hangs behind a cooldown)", () => {
  assert.equal(
    getOutputFlushTiming({ isFinal: true, isRateLimited: true, normalDebounceMs }),
    'now',
  );
});

test('final frame flushes now when not rate-limited', () => {
  assert.equal(
    getOutputFlushTiming({ isFinal: true, isRateLimited: false, normalDebounceMs }),
    'now',
  );
});

test('non-final + rate-limited (no/short cooldown) holds the 5s floor', () => {
  assert.equal(
    getOutputFlushTiming({ isFinal: false, isRateLimited: true, normalDebounceMs }),
    rateLimitedOutputDebounceMs,
    'omitted remaining cooldown → at least the floor',
  );
  assert.equal(
    getOutputFlushTiming({ isFinal: false, isRateLimited: true, normalDebounceMs, remainingCooldownMs: 1000 }),
    rateLimitedOutputDebounceMs,
    'a cooldown shorter than the floor still gets the floor',
  );
});

test('S3: non-final + rate-limited scales the debounce to a longer live cooldown', () => {
  const remainingCooldownMs = rateLimitedOutputDebounceMs + 20_000;
  assert.equal(
    getOutputFlushTiming({ isFinal: false, isRateLimited: true, normalDebounceMs, remainingCooldownMs }),
    remainingCooldownMs,
    'a long cooldown coalesces into one larger edit instead of a backlog of tiny ones',
  );
});

test('S3: the cooldown scaling is ignored when not rate-limited (no spurious stretch)', () => {
  assert.equal(
    getOutputFlushTiming({ isFinal: false, isRateLimited: false, normalDebounceMs, remainingCooldownMs: 30_000 }),
    normalDebounceMs,
    'not in cooldown → normal debounce regardless of a stale remaining value',
  );
});

test('S3: isFinal still flushes now even with a long remaining cooldown', () => {
  assert.equal(
    getOutputFlushTiming({ isFinal: true, isRateLimited: true, normalDebounceMs, remainingCooldownMs: 60_000 }),
    'now',
    'the final frame never waits out the cooldown, no matter how long',
  );
});

test('non-final + normal uses the normal debounce', () => {
  assert.equal(
    getOutputFlushTiming({ isFinal: false, isRateLimited: false, normalDebounceMs }),
    normalDebounceMs,
  );
});

test('rate-limited stretch never shortens an already-longer normal debounce', () => {
  const longDebounceMs = rateLimitedOutputDebounceMs + 1000;
  assert.equal(
    getOutputFlushTiming({ isFinal: false, isRateLimited: true, normalDebounceMs: longDebounceMs }),
    longDebounceMs,
  );
});
