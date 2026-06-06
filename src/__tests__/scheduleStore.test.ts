/**
 * @description Coverage for `scheduler/store.ts` (S2) + the StateStore schedule
 * collection + the run ledger:
 *
 *   - slugify / generateScheduleId shape.
 *   - upsert / get / remove round-trip and per-thread filtering.
 *   - per-thread cap enforcement at maxSchedulesPerThread (typed result).
 *   - persistence across a StateStore reload (same dataDir, new instance).
 *   - RunLedger append + rotation trigger (tmp dir under ./agent/tmp/).
 *
 * StateStore tests reuse state.test.ts's isolation idiom: an isolated dataDir
 * under a fake HOME so the legacy-migration probe can't touch the real home.
 */

import { test, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import { keyToString, type ThreadKey } from '../types';
import {
  slugify,
  generateScheduleId,
  createScheduleRecord,
  createScheduleForThread,
  maxSchedulesPerThread,
} from '../scheduler/store';
import { RunLedger, maxLedgerBytes, type ScheduleRunRecord } from '../scheduler/runLedger';
import type { ScheduleSpec } from '../scheduler/types';

const threadA: ThreadKey = { chatId: -1001234567890, threadId: 11 };
const threadB: ThreadKey = { chatId: -1001234567890, threadId: 22 };
const dailySpec: ScheduleSpec = { kind: 'cron', cronExpr: '0 9 * * *' };
const nowMs = new Date(2026, 5, 6, 10, 0, 0).getTime();

describe('slugify', () => {
  it('lowercases and hyphenates a normal name', () => {
    assert.equal(slugify('Daily Standup Reminder'), 'daily-standup-reminder');
  });

  it('collapses runs of non-alphanumerics and trims edges', () => {
    assert.equal(slugify('  **Backup!! now**  '), 'backup-now');
  });

  it('falls back to "job" when nothing usable survives', () => {
    assert.equal(slugify('🔥🔥🔥'), 'job');
  });

  it('bounds the slug length', () => {
    const long = 'a'.repeat(100);
    assert.ok(slugify(long).length <= 40);
  });
});

describe('generateScheduleId', () => {
  it('is slug + 6-char lowercase alnum suffix and unique across calls', () => {
    const id = generateScheduleId('My Job');
    assert.match(id, /^my-job-[0-9a-z]{6}$/);
    const ids = new Set(Array.from({ length: 50 }, () => generateScheduleId('My Job')));
    assert.equal(ids.size, 50, 'ids should be unique');
  });
});

describe('createScheduleRecord', () => {
  it('computes nextRunAt and stamps deterministic timestamps', () => {
    const record = createScheduleRecord({
      threadKey: threadA,
      name: 'Standup',
      spec: dailySpec,
      prompt: 'remind the team',
      createdBy: 'user',
      nowMs,
      lastAdapterName: 'claude',
    });
    assert.equal(record.threadKey, keyToString(threadA));
    assert.equal(record.createdAt, new Date(nowMs).toISOString());
    assert.equal(record.updatedAt, record.createdAt);
    assert.equal(record.nextRunAt, new Date(2026, 5, 7, 9, 0, 0).getTime());
    assert.equal(record.lastAdapterName, 'claude');
    assert.equal(record.createdBy, 'user');
  });
});

describe('StateStore schedule collection', () => {
  let dataDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let createdStores: StateStore[] = [];

  /** Track every store so teardown can flush pending debounced saves first. */
  function trackStore(store: StateStore): StateStore {
    createdStores.push(store);
    return store;
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-sched-'));
    dataDir = path.join(fakeHome, '.telegramCode');
    fs.mkdirSync(dataDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    // Flush before removing the dir — a still-armed debounced save firing
    // after rmSync logs a harmless-but-noisy ENOENT from the background flush.
    for (const store of createdStores) await store.flush();
    createdStores = [];
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('upsert / get / remove round-trip', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();

    const created = await createScheduleForThread(store, {
      threadKey: threadA,
      name: 'Standup',
      spec: dailySpec,
      prompt: 'go',
      createdBy: 'user',
      nowMs,
    });
    assert.ok(created.ok);
    const id = created.record.id;

    const all = store.getSchedules();
    assert.deepEqual(Object.keys(all), [id]);
    assert.equal(store.getThreadSchedules(threadA).length, 1);

    await store.removeSchedule(id);
    assert.equal(Object.keys(store.getSchedules()).length, 0);
    assert.equal(store.getThreadSchedules(threadA).length, 0);
  });

  it('filters schedules per thread', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await createScheduleForThread(store, { threadKey: threadA, name: 'a1', spec: dailySpec, prompt: 'p', createdBy: 'user', nowMs });
    await createScheduleForThread(store, { threadKey: threadA, name: 'a2', spec: dailySpec, prompt: 'p', createdBy: 'agent', nowMs });
    await createScheduleForThread(store, { threadKey: threadB, name: 'b1', spec: dailySpec, prompt: 'p', createdBy: 'user', nowMs });

    assert.equal(store.getThreadSchedules(threadA).length, 2);
    assert.equal(store.getThreadSchedules(threadB).length, 1);
    assert.equal(Object.keys(store.getSchedules()).length, 3);
  });

  it('enforces the per-thread cap with a typed result, isolated per thread', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();

    for (let n = 0; n < maxSchedulesPerThread; n += 1) {
      const result = await createScheduleForThread(store, {
        threadKey: threadA, name: `job ${n}`, spec: dailySpec, prompt: 'p', createdBy: 'user', nowMs,
      });
      assert.ok(result.ok, `creation #${n} should succeed`);
    }
    assert.equal(store.getThreadSchedules(threadA).length, maxSchedulesPerThread);

    const overflow = await createScheduleForThread(store, {
      threadKey: threadA, name: 'one too many', spec: dailySpec, prompt: 'p', createdBy: 'user', nowMs,
    });
    assert.equal(overflow.ok, false);
    if (!overflow.ok) {
      assert.equal(overflow.reason, 'cap-reached');
      assert.equal(overflow.limit, maxSchedulesPerThread);
    }
    // Cap is per-thread: a different thread is unaffected.
    const otherThread = await createScheduleForThread(store, {
      threadKey: threadB, name: 'fresh', spec: dailySpec, prompt: 'p', createdBy: 'user', nowMs,
    });
    assert.ok(otherThread.ok);
  });

  it('setSchedulePaused toggles isPaused / pauseReason and clears cleanly', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'pausable', spec: dailySpec, prompt: 'p', createdBy: 'user', nowMs,
    });
    assert.ok(created.ok);
    const id = created.record.id;

    await store.setSchedulePaused(id, true, 'unbound');
    let record = store.getSchedules()[id];
    assert.equal(record.isPaused, true);
    assert.equal(record.pauseReason, 'unbound');

    await store.setSchedulePaused(id, false);
    record = store.getSchedules()[id];
    assert.equal(record.isPaused, undefined);
    assert.equal(record.pauseReason, undefined);
  });

  it('persists schedules across a StateStore reload', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    const created = await createScheduleForThread(store, {
      threadKey: threadA, name: 'Survives Restart', spec: dailySpec, prompt: 'keep me', createdBy: 'agent', nowMs,
    });
    assert.ok(created.ok);
    await store.flush();

    // Fresh instance reading the same dataDir — proves on-disk persistence,
    // not just in-memory state (load-bearing: a missing write would lose this).
    const reloaded = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await reloaded.init();
    const records = reloaded.getThreadSchedules(threadA);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, created.record.id);
    assert.equal(records[0].prompt, 'keep me');
    assert.equal(records[0].createdBy, 'agent');
    assert.equal(records[0].nextRunAt, created.record.nextRunAt);
  });
});

describe('RunLedger', () => {
  let ledgerDir: string;

  beforeEach(() => {
    // Project-local tmp per the repo rule: never the global /tmp.
    const base = path.join(process.cwd(), 'agent', 'tmp');
    fs.mkdirSync(base, { recursive: true });
    ledgerDir = fs.mkdtempSync(path.join(base, 'ledger-'));
  });

  afterEach(() => {
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  });

  const sampleRecord = (overrides: Partial<ScheduleRunRecord> = {}): ScheduleRunRecord => ({
    runId: 'run-1',
    jobId: 'standup-abc123',
    threadKey: keyToString(threadA),
    firedAt: nowMs,
    kind: 'on-time',
    ...overrides,
  });

  it('appends one JSONL line per record, parseable round-trip', () => {
    const ledgerPath = path.join(ledgerDir, 'scheduler-runs.jsonl');
    const ledger = new RunLedger(ledgerPath);
    ledger.append(sampleRecord());
    ledger.append(sampleRecord({ runId: 'run-2', kind: 'catch-up', deliveredAt: nowMs + 500 }));

    const lines = fs.readFileSync(ledgerPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]) as ScheduleRunRecord;
    const second = JSON.parse(lines[1]) as ScheduleRunRecord;
    assert.equal(first.kind, 'on-time');
    assert.equal(second.kind, 'catch-up');
    assert.equal(second.deliveredAt, nowMs + 500);
  });

  it('rotates to .1 once the file exceeds maxLedgerBytes', () => {
    const ledgerPath = path.join(ledgerDir, 'scheduler-runs.jsonl');
    // Seed the file just over the cap so the NEXT append triggers rotation.
    fs.writeFileSync(ledgerPath, 'x'.repeat(maxLedgerBytes + 1));
    const ledger = new RunLedger(ledgerPath);

    ledger.append(sampleRecord({ runId: 'after-rotate' }));

    assert.ok(fs.existsSync(`${ledgerPath}.1`), '.1 backup should exist after rotation');
    // The live file now holds only the post-rotation record.
    const liveLines = fs.readFileSync(ledgerPath, 'utf-8').trim().split('\n');
    assert.equal(liveLines.length, 1);
    assert.equal((JSON.parse(liveLines[0]) as ScheduleRunRecord).runId, 'after-rotate');
  });
});

test('maxSchedulesPerThread is a sane named constant', () => {
  assert.equal(maxSchedulesPerThread, 30);
});
