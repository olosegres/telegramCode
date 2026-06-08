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

test('non-final + rate-limited stretches the debounce', () => {
  assert.equal(
    getOutputFlushTiming({ isFinal: false, isRateLimited: true, normalDebounceMs }),
    rateLimitedOutputDebounceMs,
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
