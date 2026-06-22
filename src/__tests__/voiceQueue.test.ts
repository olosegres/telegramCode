/**
 * @description The voice handler must ENQUEUE the slow transcription job onto a
 * per-thread FIFO queue and RETURN immediately, so a slow Groq transcription
 * can never stall telegraf's update loop (which awaits every handler in a batch
 * before the next getUpdates). These tests pin the three load-bearing
 * properties of the queue registry `getVoiceTranscriptionQueue`:
 *
 *  1. enqueue returns BEFORE a slow job resolves (the non-block proof);
 *  2. two jobs on the SAME key run in arrival order;
 *  3. jobs on DIFFERENT keys are NOT serialized against each other (a slow job
 *     on key A does not delay a job on key B).
 *
 * The registry holds the new logic; processVoiceJob itself is bot-coupled and
 * exercised live (per the plan's on-host step), not here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadKey } from '../types';
import { getVoiceTranscriptionQueue } from '../voiceQueue';

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Distinct keys per test so the module-level registry (shared across this
// file's tests) never couples one test's queue state into another.
const keyNonBlock: ThreadKey = { chatId: -100, threadId: 1 };
const keyOrderA: ThreadKey = { chatId: -100, threadId: 2 };
const keyParallelA: ThreadKey = { chatId: -100, threadId: 3 };
const keyParallelB: ThreadKey = { chatId: -100, threadId: 4 };
const keyIdentityA: ThreadKey = { chatId: -100, threadId: 5 };
const keyIdentityB: ThreadKey = { chatId: -100, threadId: 6 };

describe('getVoiceTranscriptionQueue', () => {
  it('enqueues without awaiting — the call site returns before the slow job resolves', async () => {
    const deferred = createDeferred<void>();
    let jobResolved = false;

    // The handler does this: enqueue, then return. We must observe the enqueue
    // call having returned while the job is still pending.
    const runPromise = getVoiceTranscriptionQueue(keyNonBlock).run(async () => {
      await deferred.promise;
      jobResolved = true;
    });

    // Synchronously after the enqueue call: the job has NOT run to completion.
    assert.equal(jobResolved, false, 'job must still be pending right after enqueue');

    // Let any already-scheduled microtasks drain — still pending (the deferred
    // is unresolved), proving the enqueue truly did not block on the job.
    await Promise.resolve();
    assert.equal(jobResolved, false, 'job must still be pending after a microtask tick');

    // Now release the slow job and confirm it eventually completes.
    deferred.resolve();
    await runPromise;
    assert.equal(jobResolved, true);
  });

  it('runs two jobs on the same key in arrival order', async () => {
    const order: number[] = [];
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    const queue = getVoiceTranscriptionQueue(keyOrderA);

    const first = queue.run(async () => {
      firstStarted.resolve();
      await releaseFirst.promise; // hold the first job open
      order.push(1);
    });
    const second = queue.run(async () => {
      order.push(2);
    });

    // The second job must not run while the first is still in flight.
    await firstStarted.promise;
    await Promise.resolve();
    assert.deepEqual(order, [], 'second job must wait for the first to finish');

    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, [1, 2], 'jobs ran in arrival order');
  });

  it('does not serialize jobs across different keys — a slow job on A never blocks B', async () => {
    const releaseSlow = createDeferred<void>();
    let slowAdone = false;
    let fastBdone = false;

    // A slow job on key A, deliberately held open.
    const slowA = getVoiceTranscriptionQueue(keyParallelA).run(async () => {
      await releaseSlow.promise;
      slowAdone = true;
    });

    // A fast job on key B must complete while A is still stuck.
    const fastB = getVoiceTranscriptionQueue(keyParallelB).run(async () => {
      fastBdone = true;
    });

    await fastB;
    assert.equal(fastBdone, true, "key B's job completed");
    assert.equal(slowAdone, false, "key A's job is still blocked — B was not serialized behind A");

    // Clean up: release A so the test does not leak a pending job.
    releaseSlow.resolve();
    await slowA;
    assert.equal(slowAdone, true);
  });

  it('returns the same queue instance for the same key (create-on-miss registry)', () => {
    const q1 = getVoiceTranscriptionQueue(keyIdentityA);
    const q2 = getVoiceTranscriptionQueue(keyIdentityA);
    assert.equal(q1, q2, 'same key maps to one queue');
    assert.notEqual(getVoiceTranscriptionQueue(keyIdentityB), q1, 'different key maps to a different queue');
  });
});
