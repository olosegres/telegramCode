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

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  enqueueSend,
  sendUnpaced,
  withRateLimitRetry,
  checkIsRateLimited,
  getRateLimitRemainingMs,
  checkIsRateLimitedError,
  RateLimitedError,
  GlobalSendPacer,
  __setGlobalPacerForTest,
  globalSendIntervalMs,
  enterShutdownDrain,
  drainPendingSends,
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
interface FakePacerClock extends PacerClock {
  advance: (ms: number) => void;
  advanceWithoutRunningTimers: (ms: number) => void;
  runDueTimers: () => void;
}

function createFakeClock(): FakePacerClock {
  let current = 0;
  let timers: Array<{ at: number; fn: () => void }> = [];
  const runDueTimers = () => {
    const due = timers.filter(t => t.at <= current).sort((a, b) => a.at - b.at);
    timers = timers.filter(t => t.at > current);
    for (const t of due) t.fn();
  };
  return {
    now: () => current,
    setTimeout: (fn, ms) => { timers.push({ at: current + ms, fn }); },
    advance: (ms) => {
      current += ms;
      runDueTimers();
    },
    advanceWithoutRunningTimers: (ms) => { current += ms; },
    runDueTimers,
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

test('S1: canceling a parked waiter removes only that waiter and preserves survivor order', async () => {
  const clock = createFakeClock();
  const pacer = new GlobalSendPacer(globalSendIntervalMs, clock);
  const canceledController = new AbortController();
  const granted: string[] = [];

  await pacer.acquire();
  const first = pacer.acquire().then(() => granted.push('first'));
  const canceled = pacer.acquire(canceledController.signal);
  const third = pacer.acquire().then(() => granted.push('third'));

  assert.equal(pacer.getPendingCount(), 3);
  canceledController.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
  assert.equal(pacer.getPendingCount(), 2, 'the canceled waiter must leave the pacer queue');

  clock.advance(globalSendIntervalMs);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(granted, ['first']);

  clock.advance(globalSendIntervalMs);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.all([first, third]);
  assert.deepEqual(granted, ['first', 'third'], 'the surviving waiter must not be overtaken');
});

test('S1: a canceled last waiter cannot leave a stale timer that grants a later waiter early', async () => {
  const clock = createFakeClock();
  const pacer = new GlobalSendPacer(globalSendIntervalMs, clock);
  const canceledController = new AbortController();

  await pacer.acquire();
  const canceled = pacer.acquire(canceledController.signal);
  canceledController.abort();
  await assert.rejects(canceled, { name: 'AbortError' });

  // Simulate an overdue timer callback whose event-loop turn has not run yet.
  clock.advanceWithoutRunningTimers(globalSendIntervalMs);
  await pacer.acquire();

  let survivorGranted = false;
  const survivor = pacer.acquire().then(() => { survivorGranted = true; });
  clock.runDueTimers();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    survivorGranted,
    false,
    'the canceled waiter\'s stale timer must not grant against the new pacing window',
  );

  clock.advance(globalSendIntervalMs);
  await survivor;
  assert.equal(survivorGranted, true);
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

test('enqueueSend rejects a canceled queued caller promptly without letting its successor overtake', async () => {
  const pacer = new GlobalSendPacer(1);
  pacer.enterShutdownDrain();
  __setGlobalPacerForTest(pacer);
  const key = k(7010, 100);
  const order: string[] = [];
  const canceledController = new AbortController();
  let markFirstStarted = () => {};
  let releaseFirst = () => {};
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  try {
    const first = enqueueSend(key, async () => {
      order.push('first');
      markFirstStarted();
      await firstGate;
    });
    await firstStarted;

    const canceled = enqueueSend(
      key,
      async () => { order.push('canceled'); },
      canceledController.signal,
    );
    const successor = enqueueSend(key, async () => { order.push('successor'); });

    canceledController.abort();
    await assert.rejects(canceled, { name: 'AbortError' });
    await Promise.resolve();
    assert.deepEqual(order, ['first'], 'the successor must remain chained behind the active send');

    releaseFirst();
    await Promise.all([first, successor]);
    assert.deepEqual(order, ['first', 'successor']);
  } finally {
    releaseFirst();
    __setGlobalPacerForTest(new GlobalSendPacer(1));
  }
});

test('enqueueSend waits for an already-started operation to settle after cancellation', async () => {
  const pacer = new GlobalSendPacer(1);
  pacer.enterShutdownDrain();
  __setGlobalPacerForTest(pacer);
  const controller = new AbortController();
  const key = k(7011, 100);
  let markOperationStarted = () => {};
  let releaseOperation = () => {};
  const operationStarted = new Promise<void>((resolve) => { markOperationStarted = resolve; });
  const operationGate = new Promise<void>((resolve) => { releaseOperation = resolve; });

  try {
    const send = enqueueSend(
      key,
      async () => {
        markOperationStarted();
        await operationGate;
        return 'settled-after-cleanup';
      },
      controller.signal,
    );
    let didSettle = false;
    void send.then(
      () => { didSettle = true; },
      () => { didSettle = true; },
    );

    await operationStarted;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      didSettle,
      false,
      'cancellation must not report completion while the started operation still owns cleanup',
    );

    releaseOperation();
    assert.equal(await send, 'settled-after-cleanup');
  } finally {
    releaseOperation();
    __setGlobalPacerForTest(new GlobalSendPacer(1));
  }
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

test('withRateLimitRetry aborts a retry-after wait without starting another attempt', async () => {
  const chatId = 7006;
  const controller = new AbortController();
  let calls = 0;
  let markFirstAttempt = () => {};
  const firstAttempt = new Promise<void>((resolve) => { markFirstAttempt = resolve; });
  const fakeError = {
    response: { error_code: 429, parameters: { retry_after: 60 } },
  };

  const result = withRateLimitRetry(
    chatId,
    async () => {
      calls += 1;
      markFirstAttempt();
      throw fakeError;
    },
    controller.signal,
  );
  await firstAttempt;
  controller.abort();

  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(calls, 1, 'cancellation during backoff must suppress the retry');
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

// ── sendUnpaced: skips the pacer, keeps 429 safety, paced path untouched ─────

test('sendUnpaced runs immediately while the global pacer is saturated; the paced enqueueSend stays gated', async () => {
  // Install a fake-clock pacer so we can hold it "saturated" (window closed +
  // a waiter parked) deterministically. Restore the fast process pacer after,
  // so the following enqueueSend tests (module-level 1 ms pacer) are unaffected.
  const clock = createFakeClock();
  const pacer = new GlobalSendPacer(globalSendIntervalMs, clock);
  __setGlobalPacerForTest(pacer);
  try {
    const key = k(7101, 5);

    // Saturate: drain the open window, then park a waiter → the next permit
    // now needs a full interval that only the clock can advance.
    await pacer.acquire();
    void pacer.acquire();

    // A PACED send cannot run yet — it is gated behind the saturated pacer.
    let pacedRan = false;
    const paced = enqueueSend(key, async () => { pacedRan = true; return 'paced'; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(pacedRan, false, 'enqueueSend is gated by the saturated pacer (paced path unchanged)');

    // The UNPACED send runs at once — it never asks the pacer for a permit.
    let unpacedRan = false;
    const unpaced = await sendUnpaced(key, async () => { unpacedRan = true; return 'unpaced'; });
    assert.equal(unpacedRan, true, 'sendUnpaced ran without waiting for a pacer permit');
    assert.equal(unpaced, 'unpaced');
    assert.equal(pacedRan, false, 'the paced send is STILL gated — proving the pacer really was saturated');

    // Drain the clock so the parked sends settle and nothing leaks.
    for (let i = 0; i < 3; i++) {
      clock.advance(globalSendIntervalMs);
      await Promise.resolve();
      await Promise.resolve();
    }
    assert.equal(await paced, 'paced', 'the paced send completes once the pacer window reopens');
  } finally {
    __setGlobalPacerForTest(new GlobalSendPacer(1));
  }
});

test('sendUnpaced still retries once on a 429 (429 safety preserved)', async () => {
  const key = k(7102, 9);
  let calls = 0;
  const fakeError = {
    response: { error_code: 429, parameters: { retry_after: 0 } },
  };

  const result = await sendUnpaced(key, async () => {
    calls += 1;
    if (calls === 1) throw fakeError;
    return 'ok';
  });

  assert.equal(calls, 2, 'sendUnpaced must retry exactly once on 429 (withRateLimitRetry still wraps it)');
  assert.equal(result, 'ok');
  assert.equal(checkIsRateLimited(key.chatId), false, 'not blocked after a successful retry');
});

// ── shutdown drain: immediate-release mode + FIFO drain at graceful exit ─────

test('shutdown drain: enterShutdownDrain releases parked waiters at once (FCFS) and un-gates future acquires', async () => {
  const clock = createFakeClock();
  const pacer = new GlobalSendPacer(globalSendIntervalMs, clock);
  const order: number[] = [];

  await pacer.acquire(); // close the window
  void pacer.acquire().then(() => order.push(1));
  void pacer.acquire().then(() => order.push(2));
  await Promise.resolve();
  assert.deepEqual(order, [], 'both waiters are parked behind the closed window');

  pacer.enterShutdownDrain();
  await Promise.resolve();
  assert.deepEqual(order, [1, 2], 'released immediately, in arrival order, without any clock advance');
  assert.equal(pacer.getPendingCount(), 0, 'nothing stays parked in drain mode');

  let grantedImmediately = false;
  await pacer.acquire().then(() => { grantedImmediately = true; });
  assert.equal(grantedImmediately, true, 'a later acquire is granted immediately in drain mode');
});

test('shutdown drain: saturated queued sends all run without waiting out the 2s spacing; drainPendingSends reports drained', async () => {
  // Fake-clock pacer: without the drain nothing would run until the clock
  // advances — proving the drain (not elapsed time) released the sends.
  const clock = createFakeClock();
  const pacer = new GlobalSendPacer(globalSendIntervalMs, clock);
  __setGlobalPacerForTest(pacer);
  try {
    const key = k(7201, 1);
    const ran: number[] = [];

    await pacer.acquire(); // close the window so every send below is gated
    const sends = [1, 2, 3].map((i) => enqueueSend(key, async () => { ran.push(i); }));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(ran, [], 'gated by the saturated pacer before the drain');

    enterShutdownDrain();
    const verdict = await drainPendingSends(1000);
    assert.equal(verdict, 'drained', 'the FIFOs emptied within the bound');
    assert.deepEqual(ran, [1, 2, 3], 'every queued send ran, in order, with zero clock advances');
    await Promise.all(sends);
  } finally {
    __setGlobalPacerForTest(new GlobalSendPacer(1));
  }
});

test('shutdown drain: a 429 during the drain still retries once (withRateLimitRetry preserved)', async () => {
  const clock = createFakeClock();
  const pacer = new GlobalSendPacer(globalSendIntervalMs, clock);
  __setGlobalPacerForTest(pacer);
  try {
    const key = k(7202, 1);
    let calls = 0;
    const fakeError = {
      response: { error_code: 429, parameters: { retry_after: 0 } },
    };

    await pacer.acquire(); // close the window so the send is genuinely parked
    const send = enqueueSend(key, async () => {
      calls += 1;
      if (calls === 1) throw fakeError;
      return 'ok';
    });

    enterShutdownDrain();
    const verdict = await drainPendingSends(2000);
    assert.equal(verdict, 'drained');
    assert.equal(await send, 'ok');
    assert.equal(calls, 2, 'the drained send retried exactly once on the 429');
    assert.equal(checkIsRateLimited(key.chatId), false, 'not blocked after a successful retry');
  } finally {
    __setGlobalPacerForTest(new GlobalSendPacer(1));
  }
});

test('shutdown drain: drainPendingSends reports timeout when a send outlives the bound, then drains once it settles', async () => {
  __setGlobalPacerForTest(new GlobalSendPacer(1));
  const key = k(7203, 1);

  // drainPendingSends unref's its bound timer (correct at shutdown — the drain
  // must never keep the exiting process alive), so with only a hung promise
  // pending the test's event loop would empty and node:test would cancel the
  // await. Keep a ref'd interval alive for the duration of the test.
  const keepEventLoopAlive = setInterval(() => {}, 20);
  try {
    let releaseHungSend: () => void = () => {};
    const hungSend = enqueueSend(
      key,
      () => new Promise<void>((resolve) => { releaseHungSend = resolve; }),
    );

    const verdict = await drainPendingSends(50);
    assert.equal(verdict, 'timeout', 'the bound elapsed with the send still in flight');

    // Let the hung send settle and clean its queue entry, so the verdict flips.
    releaseHungSend();
    await hungSend;
    assert.equal(await drainPendingSends(1000), 'drained', 'an emptied FIFO reports drained');
  } finally {
    clearInterval(keepEventLoopAlive);
  }
});
