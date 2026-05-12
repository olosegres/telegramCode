/**
 * @description Plan §11 Этап 7 / R7 — proactive token-bucket + reactive
 * 429-retry behaviour of `rateLimiter.ts`.
 *
 * The module is keyed by `chatId` with module-scoped maps for buckets,
 * queues, and 429-cooldown state. Tests pick distinct `chatId`s so they
 * don't contaminate each other (Telegram's real-world chat ids are
 * negative 13-digit numbers; the tests use small positive numbers picked
 * for visual readability — collisions with bot-side state aren't a
 * concern in the test process).
 *
 * Timing tests are short by design (only the 6-th send into the bucket
 * is awaited past the burst boundary, ~1 s) so the suite stays under
 * a few seconds total.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { enqueueSend, withRateLimitRetry, checkIsRateLimited, getRateLimitRemainingMs } from '../rateLimiter';

test('R7: enqueueSend runs back-to-back sends in queue order', async () => {
  const chatId = 7001;
  const order: number[] = [];

  // Five concurrent submissions; the per-chat queue must serialise them
  // and the result order has to match submission order.
  await Promise.all([1, 2, 3, 4, 5].map(i =>
    enqueueSend(chatId, async () => {
      order.push(i);
      return i;
    })
  ));

  assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test('R7: bucket allows a burst of 5 sends without delay, then paces', async () => {
  const chatId = 7002;
  const t0 = Date.now();
  // Burst of 5 — fits the bucket capacity.
  await Promise.all([1, 2, 3, 4, 5].map(i =>
    enqueueSend(chatId, async () => i)
  ));
  const burstMs = Date.now() - t0;

  // Burst should complete in well under a second — well below the 1
  // token/sec refill rate. Allow some slack for slow CI (200 ms).
  assert.ok(burstMs < 200, `burst of 5 took ${burstMs}ms, expected < 200ms`);

  // The 6-th send has to wait for a refill — at 1 token/sec it should
  // need ~1 s. Cap the upper bound generously (2 s) so a sluggish CI
  // host doesn't fail the test.
  const t1 = Date.now();
  await enqueueSend(chatId, async () => 'sixth');
  const sixthMs = Date.now() - t1;
  assert.ok(sixthMs >= 800, `6th send returned in ${sixthMs}ms, expected ≥ 800ms`);
  assert.ok(sixthMs < 2000, `6th send returned in ${sixthMs}ms, expected < 2000ms`);
});

test('R7: withRateLimitRetry retries once on 429 then succeeds', async () => {
  const chatId = 7003;
  let calls = 0;
  const fakeError = {
    response: { error_code: 429, parameters: { retry_after: 0 } },
  };

  const result = await withRateLimitRetry(chatId, async () => {
    calls += 1;
    if (calls === 1) throw fakeError;
    return 'ok';
  });

  assert.equal(calls, 2, 'must retry exactly once');
  assert.equal(result, 'ok');
  // The chat must NOT remain marked blocked after a successful retry.
  assert.equal(checkIsRateLimited(chatId), false);
});

test('R7: withRateLimitRetry surfaces a second 429 and leaves cooldown set', async () => {
  const chatId = 7004;
  let calls = 0;
  const fakeError = {
    response: { error_code: 429, parameters: { retry_after: 1 } },
  };

  await assert.rejects(
    () => withRateLimitRetry(chatId, async () => {
      calls += 1;
      throw fakeError;
    }),
    (e: unknown) => {
      // The thrown error is the same shape we passed in (or a wrapper);
      // we only care that the retry happened and the cooldown is set.
      return e !== null;
    },
  );

  assert.equal(calls, 2, 'must attempt twice');
  assert.equal(checkIsRateLimited(chatId), true, 'cooldown must be active');
  assert.ok(getRateLimitRemainingMs(chatId) > 0, 'remaining ms must be positive');
});

test('R7: non-429 errors propagate without retry', async () => {
  const chatId = 7005;
  let calls = 0;

  await assert.rejects(
    () => withRateLimitRetry(chatId, async () => {
      calls += 1;
      throw new Error('boom');
    }),
    /boom/,
  );

  assert.equal(calls, 1, 'non-429 errors must not retry');
  assert.equal(checkIsRateLimited(chatId), false);
});

test('R7: different chatIds maintain independent budgets', async () => {
  const chatA = 7006;
  const chatB = 7007;

  // Burst chatA to exhaust its bucket; chatB should still pass instantly.
  await Promise.all([1, 2, 3, 4, 5].map(i =>
    enqueueSend(chatA, async () => i)
  ));

  const t0 = Date.now();
  await enqueueSend(chatB, async () => 'first-on-B');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `B's first send took ${elapsed}ms (expected near-zero)`);
});
