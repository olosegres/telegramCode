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
import {
  enqueueSend,
  withRateLimitRetry,
  checkIsRateLimited,
  getRateLimitRemainingMs,
  TokenBucket,
  rateLimiterConstants,
  type BucketClock,
  type SendPriority,
} from '../rateLimiter';
import type { ThreadKey } from '../types';

const k = (chatId: number, threadId: number): ThreadKey => ({ chatId, threadId });

/**
 * A deterministic clock + timer for {@link TokenBucket}: time only advances
 * when the test calls `advance`, which both moves `now` and fires every timer
 * whose deadline has passed. No real `setTimeout`, so refill-math tests run
 * instantly instead of sleeping seconds of wall-clock.
 */
function createFakeClock(): BucketClock & { advance: (ms: number) => void } {
  let current = 0;
  let timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => current,
    setTimeout: (fn, ms) => { timers.push({ at: current + ms, fn }); },
    advance: (ms) => {
      current += ms;
      const due = timers.filter(t => t.at <= current).sort((a, b) => a.at - b.at);
      timers = timers.filter(t => t.at > current);
      for (const t of due) t.fn();
    },
  };
}

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

test('R7: bucket allows a full burst without delay, then paces at the group ceiling', async () => {
  const key = k(7002, 1);
  const burst = Array.from({ length: rateLimiterConstants.bucketCapacity }, (_, i) => i + 1);
  const t0 = Date.now();
  // Burst exactly fills the bucket capacity — no token waits.
  await Promise.all(burst.map(i => enqueueSend(key, async () => i)));
  const burstMs = Date.now() - t0;

  // Burst should complete near-instantly. Allow slack for slow CI (200 ms).
  assert.ok(burstMs < 200, `burst of ${burst.length} took ${burstMs}ms, expected < 200ms`);

  // The next send drains an empty bucket → must wait one refill interval.
  // At ~0.333 tokens/sec (group ceiling) that's ~3 s. Bound generously so a
  // sluggish CI host doesn't fail, but enough to prove pacing slowed below
  // the old 1 token/sec.
  const expectedWaitMs = 1000 / rateLimiterConstants.bucketRefillPerSec; // ≈ 3000
  const t1 = Date.now();
  await enqueueSend(key, async () => 'overflow');
  const overflowMs = Date.now() - t1;
  assert.ok(
    overflowMs >= expectedWaitMs * 0.8,
    `overflow send returned in ${overflowMs}ms, expected ≥ ${Math.round(expectedWaitMs * 0.8)}ms (paced below group ceiling)`,
  );
});

test('refill math: sustained rate ≈ groupMessagesPerMinute/60 (≈3s per token after drain)', () => {
  const clock = createFakeClock();
  const { bucketCapacity, bucketRefillPerSec } = rateLimiterConstants;
  const bucket = new TokenBucket(bucketCapacity, bucketRefillPerSec, clock);

  // Drain the whole burst capacity instantly (no time advance). The fast
  // path grants these immediately (a free token + no prior waiters).
  for (let i = 0; i < bucketCapacity; i++) void bucket.take('interactive');

  // Now the bucket is empty. Queue 3 more takers and prove each needs one
  // refill interval (~3s) — i.e. N tokens take ≈ N * (1000 / refillPerSec) ms.
  const msPerToken = 1000 / bucketRefillPerSec;
  assert.ok(Math.abs(msPerToken - 3000) < 1, `expected ~3000ms/token, got ${msPerToken}`);

  const order: number[] = [];
  bucket.take('interactive').then(() => order.push(1));
  bucket.take('interactive').then(() => order.push(2));
  bucket.take('interactive').then(() => order.push(3));

  return (async () => {
    // Before any time passes, none of the queued takers can be granted.
    await Promise.resolve();
    assert.deepEqual(order, [], 'no token should be granted before time advances');

    // Advance just under one interval → still none.
    clock.advance(msPerToken - 100);
    await Promise.resolve();
    assert.deepEqual(order, [], `nothing granted at ${msPerToken - 100}ms`);

    // Cross the first interval → exactly one token.
    clock.advance(200);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, [1], 'one token after ~one interval');

    // Two more intervals → the remaining two, in order.
    clock.advance(msPerToken);
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(msPerToken);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, [1, 2, 3], 'remaining tokens granted one per interval, in order');
  })();
});

test('priority: under congestion the bucket grants interactive → output → status', async () => {
  const clock = createFakeClock();
  // Capacity 1 so the very first take drains it and everything else queues.
  const bucket = new TokenBucket(1, rateLimiterConstants.bucketRefillPerSec, clock);

  // Drain the single burst token.
  await bucket.take('interactive');

  // Now enqueue waiters in the WORST order for priority: status first,
  // then output, then interactive. Correct behaviour grants them in the
  // reverse (priority) order regardless of submission order.
  const grantOrder: SendPriority[] = [];
  const waiters = [
    bucket.take('status').then(() => grantOrder.push('status')),
    bucket.take('output').then(() => grantOrder.push('output')),
    bucket.take('interactive').then(() => grantOrder.push('interactive')),
  ];

  // Hand out three tokens, one per refill interval.
  const msPerToken = 1000 / rateLimiterConstants.bucketRefillPerSec;
  for (let i = 0; i < 3; i++) {
    clock.advance(msPerToken);
    await Promise.resolve();
    await Promise.resolve();
  }
  await Promise.all(waiters);

  assert.deepEqual(grantOrder, ['interactive', 'output', 'status']);
});

test('priority: FIFO within a class (two output waiters granted in submission order)', async () => {
  const clock = createFakeClock();
  const bucket = new TokenBucket(1, rateLimiterConstants.bucketRefillPerSec, clock);
  await bucket.take('interactive'); // drain

  const order: string[] = [];
  const waiters = [
    bucket.take('output').then(() => order.push('output-1')),
    bucket.take('output').then(() => order.push('output-2')),
    bucket.take('output').then(() => order.push('output-3')),
  ];

  const msPerToken = 1000 / rateLimiterConstants.bucketRefillPerSec;
  for (let i = 0; i < 3; i++) {
    clock.advance(msPerToken);
    await Promise.resolve();
    await Promise.resolve();
  }
  await Promise.all(waiters);

  assert.deepEqual(order, ['output-1', 'output-2', 'output-3']);
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
