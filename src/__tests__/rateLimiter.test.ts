/**
 * @description Rate limiter: the process-wide FCFS {@link GlobalSendPacer}
 * (S1) and the reactive 429 retry (`withRateLimitRetry`).
 *
 * The module keys:
 *  - a per-thread FIFO queue by **ThreadKey** so two threads in the same
 *    supergroup don't block each other;
 *  - a single GLOBAL send pacer (≤1 send / {@link globalSendIntervalMs} across
 *    ALL chats, FCFS, clock-based → no head-of-line from a stuck send);
 *  - a per-chat 429 cooldown (Telegram applies the limit per chat).
 *
 * The pacer tests construct their own {@link GlobalSendPacer} on a FAKE clock so
 * pacing is deterministic and instant. The `enqueueSend` integration tests swap
 * the process pacer for one with a tiny 1 ms interval so ordering is exercised
 * without waiting real 2 s windows.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  enqueueSend,
  withRateLimitRetry,
  checkIsRateLimited,
  getRateLimitRemainingMs,
  checkIsRateLimitedError,
  RateLimitedError,
  GlobalSendPacer,
  __setGlobalPacerForTest,
  globalSendIntervalMs,
  type PacerClock,
} from '../rateLimiter';
import type { ThreadKey } from '../types';

const k = (chatId: number, threadId: number): ThreadKey => ({ chatId, threadId });

// The enqueueSend integration tests only care about ORDER + per-thread
// independence, not the real 2 s cadence — pace at 1 ms so they run fast.
__setGlobalPacerForTest(new GlobalSendPacer(1));

/**
 * A deterministic clock + timer for {@link GlobalSendPacer}: time only advances
 * when the test calls `advance`, which both moves `now` and fires every timer
 * whose deadline has passed. No real `setTimeout`, so pacing tests run instantly.
 */
function createFakeClock(): PacerClock & { advance: (ms: number) => void } {
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

// ── S1: the global FCFS frequency gate ─────────────────────────────────────

test('S1: the pacer grants the first send immediately, then paces ≤1 / interval', async () => {
  const clock = createFakeClock();
  const pacer = new GlobalSendPacer(globalSendIntervalMs, clock);
  const granted: number[] = [];

  // Three waiters submitted at t=0. The first (window open) is granted at once;
  // the rest must wait one interval each.
  void pacer.acquire().then(() => granted.push(1));
  void pacer.acquire().then(() => granted.push(2));
  void pacer.acquire().then(() => granted.push(3));

  await Promise.resolve();
  assert.deepEqual(granted, [1], 'only the first send is granted while the window is open');

  clock.advance(globalSendIntervalMs - 1);
  await Promise.resolve();
  assert.deepEqual(granted, [1], 'nothing extra before a full interval elapses');

  clock.advance(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(granted, [1, 2], 'one more send after one interval');

  clock.advance(globalSendIntervalMs);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(granted, [1, 2, 3], 'and the third after the next interval');
});

test('S1: waiters are granted FCFS regardless of submission interleaving', async () => {
  const clock = createFakeClock();
  const pacer = new GlobalSendPacer(globalSendIntervalMs, clock);
  const order: string[] = [];

  // First take drains the open window.
  await pacer.acquire();
  order.push('open');

  const waiters = [
    pacer.acquire().then(() => order.push('a')),
    pacer.acquire().then(() => order.push('b')),
    pacer.acquire().then(() => order.push('c')),
  ];

  for (let i = 0; i < 3; i++) {
    clock.advance(globalSendIntervalMs);
    await Promise.resolve();
    await Promise.resolve();
  }
  await Promise.all(waiters);

  assert.deepEqual(order, ['open', 'a', 'b', 'c'], 'granted in strict arrival order (FCFS)');
});

test('S1: a stuck send does NOT delay the clock (no head-of-line blocking)', async () => {
  const clock = createFakeClock();
  const pacer = new GlobalSendPacer(globalSendIntervalMs, clock);
  const granted: number[] = [];

  // #1 grabs the open window and then "hangs" forever (its work never resolves).
  await pacer.acquire();
  granted.push(1);
  const neverResolves = new Promise<void>(() => { /* simulate a stuck send */ });
  void neverResolves;

  // #2 and #3 queue behind it. Because permits are granted on the CLOCK — not on
  // #1's work finishing — advancing time releases them regardless of the stall.
  void pacer.acquire().then(() => granted.push(2));
  void pacer.acquire().then(() => granted.push(3));

  clock.advance(globalSendIntervalMs);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(granted, [1, 2], 'the second send is released even though the first never completed');

  clock.advance(globalSendIntervalMs);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(granted, [1, 2, 3], 'and the third — the stuck send blocks nobody');
});

test('S1: a send after a long idle is granted immediately (window already open)', async () => {
  const clock = createFakeClock();
  const pacer = new GlobalSendPacer(globalSendIntervalMs, clock);

  await pacer.acquire(); // opens the window: nextAllowed = interval
  clock.advance(globalSendIntervalMs * 5); // long idle

  let grantedImmediately = false;
  const p = pacer.acquire().then(() => { grantedImmediately = true; });
  await Promise.resolve();
  assert.equal(grantedImmediately, true, 'no needless wait after the window has long reopened');
  await p;
});

test('S1: pending count reflects parked waiters', async () => {
  const clock = createFakeClock();
  const pacer = new GlobalSendPacer(globalSendIntervalMs, clock);
  await pacer.acquire();
  assert.equal(pacer.getPendingCount(), 0, 'nothing parked after the open-window grant');
  void pacer.acquire();
  void pacer.acquire();
  assert.equal(pacer.getPendingCount(), 2, 'two sends parked behind the gate');
});

// ── enqueueSend: per-thread FIFO ordering + cross-thread independence ───────

test('enqueueSend runs a thread\'s sends in queue order', async () => {
  const key = k(7001, 1);
  const order: number[] = [];

  await Promise.all([1, 2, 3, 4, 5].map(i =>
    enqueueSend(key, async () => {
      order.push(i);
      return i;
    })
  ));

  assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test('parallel-threads: two threads in same chat do not block each other', async () => {
  // Per-thread FIFO + a clock-based global pacer: thread A's slow send holds
  // only A's own queue tail; thread B's permit is granted on the clock, so B
  // finishes promptly while A is still sleeping.
  const chatId = 7008;
  const threadA = k(chatId, 100);
  const threadB = k(chatId, 200);

  await enqueueSend(threadA, async () => 'warm-A');
  await enqueueSend(threadB, async () => 'warm-B');

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

  assert.equal(await slowA, 'slow-A');
});

test('parallel-threads: per-thread ordering preserved even with two threads in same chat', async () => {
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

// ── reactive 429 retry ──────────────────────────────────────────────────────

test('withRateLimitRetry retries once on 429 then succeeds', async () => {
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
  assert.equal(checkIsRateLimited(chatId), false, 'not blocked after a successful retry');
});

test('withRateLimitRetry surfaces a second 429 as a typed RateLimitedError and leaves cooldown set', async () => {
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
      assert.ok(checkIsRateLimitedError(e), 'must be a RateLimitedError');
      const rle = e as RateLimitedError;
      assert.equal(rle.chatId, chatId);
      assert.ok(rle.retryAfterMs > 0, 'retryAfterMs must be positive');
      return true;
    },
  );

  assert.equal(calls, 2, 'must attempt twice');
  assert.equal(checkIsRateLimited(chatId), true, 'cooldown must be active');
  assert.ok(getRateLimitRemainingMs(chatId) > 0, 'remaining ms must be positive');
});

test('non-429 errors propagate without retry', async () => {
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
