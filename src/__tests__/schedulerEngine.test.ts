/**
 * @description Coverage for `scheduler/engine.ts` (S3) — the timer engine,
 * boot replay, no-overlap guard, and post-fire bookkeeping.
 *
 * Everything the engine touches is injected, so these run on a FAKE clock and a
 * FAKE timer queue (no real `setTimeout`, no wall-clock waits): `now()` returns
 * a mutable cursor, `setTimeoutFn` records {callback, dueAt} and `tick(ms)`
 * advances the cursor and fires every due timer. The store is a real
 * `StateStore` in an isolated dataDir under a fake HOME (scheduleStore.test.ts
 * idiom) so bookkeeping round-trips through actual persistence; the ledger and
 * `deliver` are captured fakes.
 *
 * Load-bearing assertions capture intermediate state (deliver call args, the
 * advanced nextRunAt, ledger kinds, timer presence) rather than "returned to
 * initial", so a no-op engine could never pass.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import { keyToString, type ThreadKey } from '../types';
import { createScheduleForThread } from '../scheduler/store';
import { createSchedulerEngine, maxTimeoutMs } from '../scheduler/engine';
import type { DeliveryOutcome, FireContext, ScheduleRecord, ScheduleSpec } from '../scheduler/types';
import type { ScheduleRunRecord } from '../scheduler/runLedger';

const threadA: ThreadKey = { chatId: -1001234567890, threadId: 11 };
const everyFiveMinutes: ScheduleSpec = { kind: 'cron', cronExpr: '*/5 * * * *' };

/** A controllable fake timer queue + clock, mirroring how the engine consumes them. */
function createFakeClock(startMs: number) {
  let nowMs = startMs;
  let nextId = 1;
  interface Pending {
    id: number;
    callback: () => void;
    dueAt: number;
    delayMs: number;
  }
  const pending = new Map<number, Pending>();
  const armedDelays: number[] = [];

  const setTimeoutFn = (callback: () => void, delayMs: number): NodeJS.Timeout => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { id, callback, dueAt: nowMs + delayMs, delayMs });
    armedDelays.push(delayMs);
    // The engine only calls .unref?.() on the handle; a numeric-ish stub is fine.
    return { unref() {}, [Symbol.toPrimitive]: () => id } as unknown as NodeJS.Timeout;
  };
  const clearTimeoutFn = (handle: NodeJS.Timeout): void => {
    const id = Number(handle as unknown as number);
    pending.delete(id);
  };

  /**
   * Advance the clock by `ms` and fire every timer that becomes due, in due
   * order. Each fired callback is awaited-via-microtask-drain by the caller's
   * own `await tick(...)`; the engine's async callbacks settle on the next
   * awaited tick or an explicit `drain()`.
   */
  function tick(ms: number): void {
    nowMs += ms;
    let fired = true;
    while (fired) {
      fired = false;
      const due = [...pending.values()].filter((p) => p.dueAt <= nowMs).sort((a, b) => a.dueAt - b.dueAt);
      for (const p of due) {
        if (!pending.has(p.id)) continue;
        pending.delete(p.id);
        p.callback();
        fired = true;
      }
    }
  }

  return {
    now: () => nowMs,
    setTimeoutFn,
    clearTimeoutFn,
    tick,
    get pendingCount() {
      return pending.size;
    },
    armedDelays,
    setNow(value: number) {
      nowMs = value;
    },
  };
}

/** A capturing fake deliver + ledger, with a programmable outcome / hang. */
function createCaptures() {
  const deliverCalls: Array<{ job: ScheduleRecord; fireContext: FireContext }> = [];
  const ledgerRecords: ScheduleRunRecord[] = [];
  let nextOutcome: DeliveryOutcome = { status: 'delivered' };
  let pendingResolve: ((outcome: DeliveryOutcome) => void) | null = null;
  let shouldThrow = false;

  const deliver = (job: ScheduleRecord, fireContext: FireContext): Promise<DeliveryOutcome> => {
    deliverCalls.push({ job: { ...job }, fireContext: { ...fireContext } });
    if (shouldThrow) return Promise.reject(new Error('deliver boom'));
    if (pendingResolve === null && hangNext) {
      return new Promise<DeliveryOutcome>((resolve) => {
        pendingResolve = resolve;
      });
    }
    return Promise.resolve(nextOutcome);
  };
  let hangNext = false;

  return {
    deliver,
    ledger: { append: (r: ScheduleRunRecord) => ledgerRecords.push(r) },
    deliverCalls,
    ledgerRecords,
    setOutcome(outcome: DeliveryOutcome) {
      nextOutcome = outcome;
    },
    setShouldThrow(value: boolean) {
      shouldThrow = value;
    },
    hangNextDelivery() {
      hangNext = true;
    },
    resolveHanging(outcome: DeliveryOutcome = { status: 'delivered' }) {
      hangNext = false;
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve?.(outcome);
    },
  };
}

/**
 * Yield the event loop a few macrotask rounds WITHOUT waiting for a fire chain
 * to complete. Used only for the overlap test, whose first delivery is rigged
 * to hang: `engine.whenIdle()` would deadlock there, but the begin-ledger +
 * deliver-call happen synchronously up to the suspended `await deliver`, so a
 * handful of `setImmediate` rounds is enough to observe them.
 */
async function yieldMacrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('schedulerEngine', () => {
  let dataDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let stores: StateStore[] = [];

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-engine-'));
    dataDir = path.join(fakeHome, '.telegramCode');
    fs.mkdirSync(dataDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    for (const store of stores) await store.flush();
    stores = [];
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  async function newStore(): Promise<StateStore> {
    const store = new StateStore(dataDir, { saveDebounceMs: 5 });
    stores.push(store);
    await store.init();
    return store;
  }

  it('arms a job, fires it on time, records bookkeeping and re-arms', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'tick', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;
    const dueAt = job.nextRunAt;
    assert.ok(dueAt !== null);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(job);
    assert.equal(clock.pendingCount, 1, 'one timer armed');

    clock.tick(dueAt - startMs);
    await engine.whenIdle();

    assert.equal(caps.deliverCalls.length, 1, 'delivered once');
    assert.equal(caps.deliverCalls[0].fireContext.kind, 'on-time');

    const fresh = store.getSchedules()[job.id];
    assert.ok(fresh, 'recurring record persists');
    assert.equal(fresh.lastRunStatus, 'delivered');
    assert.equal(fresh.lastRunAt, dueAt, 'lastRunAt stamped at fire time');
    assert.ok(fresh.nextRunAt !== null && fresh.nextRunAt > dueAt, 'nextRunAt advanced into the future');
    assert.equal(clock.pendingCount, 1, 're-armed for the next occurrence');

    const onTimeEntries = caps.ledgerRecords.filter((r) => r.kind === 'on-time');
    assert.equal(onTimeEntries.length, 2, 'begin + end ledger records');
    assert.ok(onTimeEntries.some((r) => r.deliveredAt !== undefined), 'end record carries deliveredAt');
  });

  it('boot rearmAll fires a catch-up with missedAtMs, then re-arms in the future', async () => {
    const store = await newStore();
    // Created in the past, so by boot its nextRunAt has already elapsed.
    const createdAtMs = new Date(2026, 5, 6, 9, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'missed', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: createdAtMs,
    });
    assert.ok(created.ok);
    const missedDueAt = created.record.nextRunAt;
    assert.ok(missedDueAt !== null);

    // Boot "now" is well past the missed due instant.
    const bootNow = missedDueAt + 60 * 60 * 1000;
    const clock = createFakeClock(bootNow);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    await engine.rearmAll();
    await engine.whenIdle();

    assert.equal(caps.deliverCalls.length, 1, 'catch-up fired once');
    assert.equal(caps.deliverCalls[0].fireContext.kind, 'catch-up');
    assert.equal(caps.deliverCalls[0].fireContext.missedAtMs, missedDueAt, 'missedAtMs is the original due instant');

    const fresh = store.getSchedules()[created.record.id];
    assert.ok(fresh.nextRunAt !== null && fresh.nextRunAt > bootNow, 'recomputed from boot now, into the future');
    assert.equal(clock.pendingCount, 1, 're-armed after catch-up');
    assert.ok(caps.ledgerRecords.some((r) => r.kind === 'catch-up'), 'catch-up ledger record written');
  });

  it('skips an overlapping fire while delivery is in flight (no second deliver)', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'overlap', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;
    const firstDueAt = job.nextRunAt;
    assert.ok(firstDueAt !== null);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    caps.hangNextDelivery();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(job);
    clock.tick(firstDueAt - startMs);
    await yieldMacrotasks();
    assert.equal(caps.deliverCalls.length, 1, 'first fire began delivering (and is hanging)');
    assert.equal(clock.pendingCount, 0, 'no timer armed while in flight (re-arm happens after delivery)');

    // Manually re-arm a timer at the same instant to simulate the overlap race
    // (a re-arm would normally come from bookkeeping, but here delivery hangs).
    engine.armJob({ ...job, nextRunAt: clock.now() });
    clock.tick(0);
    await yieldMacrotasks();

    assert.equal(caps.deliverCalls.length, 1, 'overlap did NOT trigger a second deliver');
    const skipEntries = caps.ledgerRecords.filter((r) => r.kind === 'skipped-overlap');
    assert.equal(skipEntries.length, 1, 'one skipped-overlap ledger record');
    assert.ok(clock.pendingCount >= 1, 'job re-armed after the skip');

    caps.resolveHanging();
    await engine.whenIdle();
  });

  it('N-times: removes the record and disarms after remainingRuns hits zero', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '*/5 * * * *', remainingRuns: 2 };
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'twice', spec, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(job);

    // First fire: decrements to 1, re-armed.
    let due = store.getSchedules()[job.id].nextRunAt;
    assert.ok(due !== null);
    clock.tick(due - clock.now());
    await engine.whenIdle();
    assert.equal(caps.deliverCalls.length, 1);
    const afterFirst = store.getSchedules()[job.id];
    assert.ok(afterFirst, 'record survives first of two runs');
    assert.equal(afterFirst.spec.kind, 'cron', 'N-times spec stays cron-kind');
    if (afterFirst.spec.kind === 'cron') {
      assert.equal(afterFirst.spec.remainingRuns, 1, 'decremented to 1');
    }
    assert.equal(clock.pendingCount, 1, 're-armed for the second run');

    // Second fire: decrements to 0 → record removed, no timer.
    due = store.getSchedules()[job.id].nextRunAt;
    assert.ok(due !== null);
    clock.tick(due - clock.now());
    await engine.whenIdle();
    assert.equal(caps.deliverCalls.length, 2, 'fired both runs');
    assert.equal(store.getSchedules()[job.id], undefined, 'record removed after the 2nd run');
    assert.equal(clock.pendingCount, 0, 'timer gone');
  });

  it('once: removes the record after the single fire', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const onceAt = new Date(startMs + 10 * 60 * 1000).toISOString();
    const spec: ScheduleSpec = { kind: 'once', onceAtIso: onceAt };
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'oneshot', spec, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;
    assert.ok(job.nextRunAt !== null);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(job);
    clock.tick(job.nextRunAt - startMs);
    await engine.whenIdle();

    assert.equal(caps.deliverCalls.length, 1, 'one-shot delivered once');
    assert.equal(store.getSchedules()[job.id], undefined, 'one-shot record removed after the fire');
    assert.equal(clock.pendingCount, 0, 'no timer left');
  });

  it('paused job: rearmAll skips arming; a fire racing a pause yields paused-skip with no deliver', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'paused', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;
    const dueAt = job.nextRunAt;
    assert.ok(dueAt !== null);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    // rearmAll on an already-paused record arms nothing.
    await store.setSchedulePaused(job.id, true, 'unbound');
    await engine.rearmAll();
    assert.equal(clock.pendingCount, 0, 'paused job is not armed at boot');
    assert.equal(caps.deliverCalls.length, 0, 'paused job does not fire at boot');
    assert.equal(caps.ledgerRecords.length, 0, 'paused boot skip writes NO ledger entry');

    // Race: a timer was armed before the pause, then the pause lands; the fire
    // sees the fresh (paused) record → paused-skip, no deliver, stays disarmed.
    await store.setSchedulePaused(job.id, false); // unpause to arm
    engine.armJob(store.getSchedules()[job.id]);
    assert.equal(clock.pendingCount, 1);
    await store.setSchedulePaused(job.id, true, 'unbound'); // pause races the armed timer
    clock.tick(dueAt - startMs);
    await engine.whenIdle();

    assert.equal(caps.deliverCalls.length, 0, 'paused fire did not deliver');
    const pausedSkips = caps.ledgerRecords.filter((r) => r.kind === 'paused-skip');
    assert.equal(pausedSkips.length, 1, 'one paused-skip ledger record');
    assert.equal(clock.pendingCount, 0, 'paused-skip does NOT re-arm');
  });

  it('failed deliver: records lastRunStatus failed, re-arms, no unhandled rejection', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'fails', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;
    const dueAt = job.nextRunAt;
    assert.ok(dueAt !== null);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    caps.setShouldThrow(true); // deliver rejects
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(job);
    clock.tick(dueAt - startMs);
    await engine.whenIdle();

    const fresh = store.getSchedules()[job.id];
    assert.ok(fresh, 'recurring record survives a failed delivery');
    assert.equal(fresh.lastRunStatus, 'failed', 'failure classified, not swallowed silently');
    assert.ok(fresh.nextRunAt !== null && fresh.nextRunAt > dueAt, 're-armed despite failure');
    assert.equal(clock.pendingCount, 1, 'timer re-armed after a failed deliver');
    const endWithError = caps.ledgerRecords.find((r) => r.error !== undefined);
    assert.ok(endWithError, 'failure recorded in the ledger end entry');
  });

  it('long-delay clamp: a far-future nextRunAt arms an intermediate cap-sized timer', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'far', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(created.ok);
    const job = created.record;

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    // Force a due time well beyond the setTimeout cap (~40 days out).
    const farDueAt = startMs + maxTimeoutMs + 60 * 60 * 1000;
    engine.armJob({ ...job, nextRunAt: farDueAt });

    assert.equal(clock.armedDelays.length, 1);
    assert.equal(clock.armedDelays[0], maxTimeoutMs, 'first hop is clamped to the cap, not the full delay');
    assert.equal(caps.deliverCalls.length, 0, 'does not fire early');

    // Advancing the cap fires the intermediate hop, which re-arms for the rest.
    clock.tick(maxTimeoutMs);
    await engine.whenIdle();
    assert.equal(caps.deliverCalls.length, 0, 'still not fired after one hop');
    const lastDelay = clock.armedDelays[clock.armedDelays.length - 1];
    assert.equal(lastDelay, farDueAt - (startMs + maxTimeoutMs), 'second hop is the remaining delay');
    assert.ok(lastDelay <= maxTimeoutMs, 'remaining delay now fits under the cap');
  });

  it('shutdown clears all armed timers', async () => {
    const store = await newStore();
    const startMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
    const a = await createScheduleForThread(store, {
      threadKey: threadA, name: 'a', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    const b = await createScheduleForThread(store, {
      threadKey: threadA, name: 'b', spec: everyFiveMinutes, prompt: 'go', createdBy: 'user', nowMs: startMs,
    });
    assert.ok(a.ok && b.ok);

    const clock = createFakeClock(startMs);
    const caps = createCaptures();
    const engine = createSchedulerEngine({
      store, ledger: caps.ledger, deliver: caps.deliver,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });

    engine.armJob(a.record);
    engine.armJob(b.record);
    assert.equal(clock.pendingCount, 2, 'two timers armed');

    engine.shutdown();
    assert.equal(clock.pendingCount, 0, 'shutdown cleared every timer');
  });
});
