/**
 * @description Plan §11 Этап 7 / R7 — proactive token-bucket + reactive
 * 429-retry behaviour of `rateLimiter.ts`.
 *
 * The module is keyed:
 *  - FIFO queue by **ThreadKey** (`chatId+threadId`) so two threads in the
 *    same supergroup don't block each other (the per-thread parallelism
 *    fix);
 *  - token bucket + 429 cooldown by **chatId** (Telegram applies the
 *    per-chat limit to the whole supergroup, not per topic).
 *
 * Tests use module-scoped maps, so each test picks distinct `chatId`s /
 * `ThreadKey`s to stay independent (Telegram's real-world chat ids are
 * negative 13-digit numbers; the tests use small positive numbers for
 * readability — collisions with bot-side state aren't a concern in the
 * test process).
 *
 * Timing tests are short by design (only the 6-th send into the bucket
 * is awaited past the burst boundary, ~1 s) so the suite stays under
 * a few seconds total.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { enqueueSend, withRateLimitRetry, checkIsRateLimited, getRateLimitRemainingMs } from '../rateLimiter';
import type { ThreadKey } from '../types';

const k = (chatId: number, threadId: number): ThreadKey => ({ chatId, threadId });

test('R7: enqueueSend runs back-to-back sends in queue order', async () => {
  const key = k(7001, 1);
  const order: number[] = [];

  // Five concurrent submissions; the per-thread queue must serialise them
  // and the result order has to match submission order.
  await Promise.all([1, 2, 3, 4, 5].map(i =>
    enqueueSend(key, async () => {
      order.push(i);
      return i;
    })
  ));

  assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test('R7: bucket allows a burst of 5 sends without delay, then paces', async () => {
  const key = k(7002, 1);
  const t0 = Date.now();
  // Burst of 5 — fits the bucket capacity.
  await Promise.all([1, 2, 3, 4, 5].map(i =>
    enqueueSend(key, async () => i)
  ));
  const burstMs = Date.now() - t0;

  // Burst should complete in well under a second — well below the 1
  // token/sec refill rate. Allow some slack for slow CI (200 ms).
  assert.ok(burstMs < 200, `burst of 5 took ${burstMs}ms, expected < 200ms`);

  // The 6-th send has to wait for a refill — at 1 token/sec it should
  // need ~1 s. Cap the upper bound generously (2 s) so a sluggish CI
  // host doesn't fail the test.
  const t1 = Date.now();
  await enqueueSend(key, async () => 'sixth');
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
  const keyA = k(7006, 1);
  const keyB = k(7007, 1);

  // Burst chatA to exhaust its bucket; chatB should still pass instantly.
  await Promise.all([1, 2, 3, 4, 5].map(i =>
    enqueueSend(keyA, async () => i)
  ));

  const t0 = Date.now();
  await enqueueSend(keyB, async () => 'first-on-B');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `B's first send took ${elapsed}ms (expected near-zero)`);
});

test('parallel-threads: two threads in same chat do not block each other', async () => {
  // Same chat (supergroup), different topic ids. Previously the FIFO was
  // keyed by chatId alone — thread A's slow send held the queue tail and
  // thread B waited behind it. After the fix the queues are per-thread,
  // so B's send finishes promptly while A is still sleeping.
  const chatId = 7008;
  const threadA = k(chatId, 100);
  const threadB = k(chatId, 200);

  // 1) Drain both buckets so neither send sees a bucket wait that would
  //    confound the timing assertion.
  await enqueueSend(threadA, async () => 'warm-A');
  await enqueueSend(threadB, async () => 'warm-B');

  // 2) Submit a slow send on thread A (500 ms inside the work) then
  //    immediately submit a fast send on thread B. Without the fix, B
  //    would have to wait for A — measured ≥ 500 ms. With the fix, B's
  //    queue is independent and should resolve in well under 200 ms.
  const slowA = enqueueSend(threadA, async () => {
    await new Promise(res => setTimeout(res, 500));
    return 'slow-A';
  });

  const t0 = Date.now();
  const fastB = await enqueueSend(threadB, async () => 'fast-B');
  const fastMs = Date.now() - t0;

  assert.equal(fastB, 'fast-B');
  assert.ok(
    fastMs < 200,
    `thread B's send took ${fastMs}ms while thread A was busy — expected < 200ms (per-thread FIFO regression?)`,
  );

  // Let the slow send finish so we don't leave an in-flight promise.
  assert.equal(await slowA, 'slow-A');
});

test('parallel-threads: per-thread ordering preserved even with two threads in same chat', async () => {
  // Same chat, two threads. Submissions are interleaved but per-thread
  // order must be preserved: A1 < A2 < A3 and B1 < B2 < B3. The relative
  // order between A and B is *not* guaranteed (and shouldn't be).
  const chatId = 7009;
  const threadA = k(chatId, 100);
  const threadB = k(chatId, 200);

  const aOrder: number[] = [];
  const bOrder: number[] = [];

  await Promise.all([
    enqueueSend(threadA, async () => { aOrder.push(1); }),
    enqueueSend(threadB, async () => { bOrder.push(1); }),
    enqueueSend(threadA, async () => { aOrder.push(2); }),
    enqueueSend(threadB, async () => { bOrder.push(2); }),
    enqueueSend(threadA, async () => { aOrder.push(3); }),
    enqueueSend(threadB, async () => { bOrder.push(3); }),
  ]);

  assert.deepEqual(aOrder, [1, 2, 3], 'thread A order must be preserved');
  assert.deepEqual(bOrder, [1, 2, 3], 'thread B order must be preserved');
});
