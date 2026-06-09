/**
 * @description Coverage for the StateStore pending-question collection
 * (`setPendingQuestion` / `clearPendingQuestion` / `getPendingQuestions`),
 * the persistence layer behind the restart-survival fix: an interactive agent
 * question stored only in `bot.ts`'s in-memory map is lost on restart, leaving
 * the agent's question tool hung and the Telegram option buttons dead. These
 * tests prove the question round-trips to disk and back so boot can re-arm it.
 *
 *   - set → reload a FRESH StateStore on the same dataDir → restored verbatim
 *     (load-bearing: a fresh instance proves on-disk persistence, not memory).
 *   - the `messageId` patch (null → real id) round-trips the LATEST value.
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
import { keyToString, type PendingQuestionState, type ThreadKey } from '../types';

const threadA: ThreadKey = { chatId: -1001234567890, threadId: 11 };
const threadB: ThreadKey = { chatId: -1001234567890, threadId: 22 };

/** A representative pending question with nested questions / options / directory. */
const sampleQuestion = (messageId: number | null): PendingQuestionState => ({
  data: {
    requestId: 'req-abc123',
    directory: '/work/projectX',
    questions: [
      {
        question: 'Which database should I use?',
        header: 'Database choice',
        multiple: false,
        options: [
          { label: 'Postgres', description: 'relational' },
          { label: 'SQLite' },
        ],
      },
    ],
  },
  messageId,
  // S2 sequential-answer fields — persisted alongside the question so a restart
  // restores the in-progress collection state, not just the question text.
  answers: [null],
  currentIndex: 0,
});

describe('StateStore pending-question collection', () => {
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
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-pq-'));
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

  it('round-trips a pending question across a StateStore reload', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await store.setPendingQuestion(threadA, sampleQuestion(null));
    await store.flush();

    // Fresh instance reading the same dataDir — proves on-disk persistence,
    // not just in-memory state (load-bearing: a missing write would lose this).
    const reloaded = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await reloaded.init();
    const all = reloaded.getPendingQuestions();
    assert.deepEqual(Object.keys(all), [keyToString(threadA)]);

    const restored = all[keyToString(threadA)];
    assert.equal(restored.messageId, null);
    assert.equal(restored.data.requestId, 'req-abc123');
    assert.equal(restored.data.directory, '/work/projectX');
    assert.equal(restored.data.questions.length, 1);
    assert.equal(restored.data.questions[0].header, 'Database choice');
    assert.equal(restored.data.questions[0].options.length, 2);
    assert.equal(restored.data.questions[0].options[0].label, 'Postgres');
    assert.equal(restored.data.questions[0].options[0].description, 'relational');
    assert.equal(restored.data.questions[0].options[1].label, 'SQLite');
    // S2: the sequential-answer progress survives the reload too.
    assert.deepEqual(restored.answers, [null]);
    assert.equal(restored.currentIndex, 0);
  });

  it('persists the LATEST messageId patch (null → real id)', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    // Register first (messageId unknown), then patch the id once the button
    // message is sent — mirrors the bot's register-then-patch sequence.
    await store.setPendingQuestion(threadA, sampleQuestion(null));
    await store.setPendingQuestion(threadA, sampleQuestion(987654));
    await store.flush();

    const reloaded = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await reloaded.init();
    const restored = reloaded.getPendingQuestions()[keyToString(threadA)];
    // The persisted id is what lets the OLD buttons resolve after a restart.
    assert.equal(restored.messageId, 987654);
  });

  it('clear removes the entry and drops the map when empty', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await store.setPendingQuestion(threadA, sampleQuestion(111));
    await store.clearPendingQuestion(threadA);
    await store.flush();

    assert.equal(Object.keys(store.getPendingQuestions()).length, 0);

    const reloaded = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await reloaded.init();
    assert.equal(Object.keys(reloaded.getPendingQuestions()).length, 0);
    // Emptied map drops the field entirely — no stale `pendingQuestions: {}`.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf-8'));
    assert.equal('pendingQuestions' in onDisk, false);
  });

  it('isolates clears per thread', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await store.setPendingQuestion(threadA, sampleQuestion(1));
    await store.setPendingQuestion(threadB, sampleQuestion(2));

    await store.clearPendingQuestion(threadA);
    const remaining = store.getPendingQuestions();
    assert.deepEqual(Object.keys(remaining), [keyToString(threadB)]);
    assert.equal(remaining[keyToString(threadB)].messageId, 2);
  });

  it('getPendingQuestions returns a shallow copy callers cannot use to mutate state', async () => {
    const store = trackStore(new StateStore(dataDir, { saveDebounceMs: 20 }));
    await store.init();
    await store.setPendingQuestion(threadA, sampleQuestion(5));

    const snapshot = store.getPendingQuestions();
    delete snapshot[keyToString(threadA)];
    // The live store is unaffected by mutating the returned snapshot.
    assert.equal(Object.keys(store.getPendingQuestions()).length, 1);
  });
});
