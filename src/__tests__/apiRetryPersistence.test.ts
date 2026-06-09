/**
 * @description Coverage for the StateStore armed-retry collection
 * (`setApiRetry` / `clearApiRetry` / `getApiRetries`), the persistence layer
 * behind restart-survival of an auto-retry after a provider-side API error: an
 * armed retry stored only in `bot.ts`'s in-memory map is lost on restart, so an
 * agent that died on a rate-limit / usage-limit error would never get its
 * scheduled nudge (worst case a multi-hour usage-limit wait). These tests prove
 * the record round-trips to disk and back so boot can re-arm the timer.
 *
 *   - set → reload a FRESH StateStore on the same dataDir → restored verbatim
 *     (load-bearing: a fresh instance proves on-disk persistence, not memory).
 *   - the re-arm (attempt+1, new fireAt) round-trips the LATEST value.
 *   - clear → gone, and an emptied map drops the field for a clean `state.json`.
 *   - per-thread isolation: clearing one thread leaves the other intact.
 *
 * Reuses scheduleStore.test.ts's isolation idiom: an isolated dataDir under a
 * fake HOME so the legacy-migration probe can't touch the developer's home.
 */

import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateStore } from '../state';
import { keyToString, type ApiRetryState, type ThreadKey } from '../types';

const threadA: ThreadKey = { chatId: -1001234567890, threadId: 11 };
const threadB: ThreadKey = { chatId: -1001234567890, threadId: 22 };

/** A representative armed retry; `attempt`/`fireAt` overridable to test re-arms. */
const sampleRetry = (
  attempt: number,
  fireAt: number,
  kind: ApiRetryState['kind'] = 'transient',
): ApiRetryState => ({ kind, attempt, fireAt });

describe('StateStore api-retry collection', () => {
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
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-ar-'));
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

  it('round-trips an armed retry across a StateStore reload', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    const armed = sampleRetry(1, 1_717_000_000_000, 'usageLimit');
    await store.setApiRetry(threadA, armed);
    await store.flush();

    // Fresh instance reading the same dataDir — proves on-disk persistence,
    // not just in-memory state (load-bearing: a missing write would lose this).
    const reloaded = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await reloaded.init();
    const all = reloaded.getApiRetries();
    assert.deepEqual(Object.keys(all), [keyToString(threadA)]);

    const restored = all[keyToString(threadA)];
    // Load-bearing: the round-tripped VALUE must match what was set, not just
    // key presence — a wrong fireAt would re-arm the timer at the wrong moment.
    assert.equal(restored.kind, 'usageLimit');
    assert.equal(restored.attempt, 1);
    assert.equal(restored.fireAt, 1_717_000_000_000);
  });

  it('persists the LATEST re-arm (attempt+1, new fireAt)', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    // Arm attempt 1, then re-arm with the next attempt — mirrors the bot's
    // re-arm on a repeated apiError for the same thread.
    await store.setApiRetry(threadA, sampleRetry(1, 1_717_000_000_000));
    await store.setApiRetry(threadA, sampleRetry(2, 1_717_000_600_000));
    await store.flush();

    const reloaded = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await reloaded.init();
    const restored = reloaded.getApiRetries()[keyToString(threadA)];
    // The persisted attempt/fireAt is what lets boot re-arm the RIGHT timer.
    assert.equal(restored.attempt, 2);
    assert.equal(restored.fireAt, 1_717_000_600_000);
  });

  it('clear removes the entry and drops the map when empty', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await store.setApiRetry(threadA, sampleRetry(1, 1_717_000_000_000));
    await store.clearApiRetry(threadA);
    await store.flush();

    assert.equal(Object.keys(store.getApiRetries()).length, 0);

    const reloaded = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await reloaded.init();
    assert.equal(Object.keys(reloaded.getApiRetries()).length, 0);
    // Emptied map drops the field entirely — no stale `apiRetries: {}`.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf-8'));
    assert.equal('apiRetries' in onDisk, false);
  });

  it('isolates clears per thread', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await store.setApiRetry(threadA, sampleRetry(1, 1_717_000_000_000));
    await store.setApiRetry(threadB, sampleRetry(3, 1_717_000_900_000, 'usageLimit'));

    await store.clearApiRetry(threadA);
    const remaining = store.getApiRetries();
    assert.deepEqual(Object.keys(remaining), [keyToString(threadB)]);
    assert.equal(remaining[keyToString(threadB)].attempt, 3);
    assert.equal(remaining[keyToString(threadB)].fireAt, 1_717_000_900_000);
  });

  it('getApiRetries returns a shallow copy callers cannot use to mutate state', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await store.setApiRetry(threadA, sampleRetry(1, 1_717_000_000_000));

    const snapshot = store.getApiRetries();
    delete snapshot[keyToString(threadA)];
    // The live store is unaffected by mutating the returned snapshot.
    assert.equal(Object.keys(store.getApiRetries()).length, 1);
  });
});
