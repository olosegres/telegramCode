/**
 * @description Unit coverage for `reconcileTransientFrames` — the boot-time
 * cleanup that deletes transient status frames orphaned by an UNGRACEFUL restart
 * (crash / SIGKILL, where the graceful shutdown sweep never ran), S2.
 *
 * Load-bearing regression guard: reconciliation consumes the `orphaned` SNAPSHOT
 * passed to it (captured in `startBot` BEFORE `reattachExistingSessions`), NOT a
 * live re-read of the store. This is the exact bug found in live testing: a
 * reattached session's first frame setter persists the fresh all-null in-memory
 * state and would clobber the live persisted set to empty before reconcile could
 * read it — so reconcile MUST act on the pre-captured argument. (The snapshot's
 * own immunity to that clobber is proven at the store layer in `state.test.ts`.)
 *
 * The side-effecting collaborators (`deleteMessage`, `persistFrames`) are
 * injected so the orchestration is observable without a real Telegram client /
 * StateStore. `./reattachRecapPost.testSetup` is imported FIRST as a shared,
 * side-effect-only shim that sets `bot.ts`'s boot-time env (token + WORK_ROOT)
 * before the module evaluates.
 *
 * Test case: N/A — TelegramCode has no Jira tracker. TODO: add a test-case key
 * if one is ever created.
 */
import './reattachRecapPost.testSetup';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileTransientFrames, type ReconcileTransientFramesDeps } from '../bot';
import { keyToString, type ThreadKey } from '../types';

const keyA: ThreadKey = { chatId: -1001111111111, threadId: 9085 };
const keyB: ThreadKey = { chatId: -1001111111111, threadId: 434 };

function makeDeps(): {
  deps: ReconcileTransientFramesDeps;
  deletes: Array<[number, number]>;
  persisted: string[];
} {
  const deletes: Array<[number, number]> = [];
  const persisted: string[] = [];
  const deps: ReconcileTransientFramesDeps = {
    // No `await` before the push → the record lands synchronously when the
    // fire-and-forget delete is invoked, so the assertions need no flush.
    deleteMessage: async (chatId, messageId) => {
      deletes.push([chatId, messageId]);
      return true;
    },
    persistFrames: (key) => {
      persisted.push(keyToString(key));
    },
  };
  return { deps, deletes, persisted };
}

describe('reconcileTransientFrames', () => {
  it('deletes every id in the snapshot, in order, and returns the count', () => {
    const { deps, deletes, persisted } = makeDeps();
    const orphaned = { [keyToString(keyA)]: [101, 202], [keyToString(keyB)]: [303] };

    const deleted = reconcileTransientFrames(orphaned, deps);

    assert.equal(deleted, 3, 'returns the number of stale ids deleted');
    assert.deepEqual(deletes, [
      [keyA.chatId, 101],
      [keyA.chatId, 202],
      [keyB.chatId, 303],
    ]);
    assert.deepEqual(
      persisted,
      [keyToString(keyA), keyToString(keyB)],
      're-syncs disk to live truth once per thread',
    );
  });

  it('acts on the PASSED snapshot — the boot-reconcile clobber guard', () => {
    // The whole point of the pre-reattach snapshot: reconcile must delete what it
    // was GIVEN, regardless of current live state (which reattach may have already
    // cleared). It has no other data source, so passing ids deletes exactly them.
    const { deps, deletes } = makeDeps();
    const orphaned = { [keyToString(keyA)]: [41197] };

    const deleted = reconcileTransientFrames(orphaned, deps);

    assert.equal(deleted, 1);
    assert.deepEqual(deletes, [[keyA.chatId, 41197]]);
  });

  it('skips a corrupt key but still deletes valid threads', () => {
    const { deps, deletes, persisted } = makeDeps();
    const orphaned = { 'not-a-key': [1, 2], [keyToString(keyA)]: [202] };

    const deleted = reconcileTransientFrames(orphaned, deps);

    assert.equal(deleted, 1, 'corrupt key contributes nothing');
    assert.deepEqual(deletes, [[keyA.chatId, 202]]);
    assert.deepEqual(persisted, [keyToString(keyA)], 'no persist for the skipped key');
  });

  it('an empty snapshot deletes nothing and returns 0', () => {
    const { deps, deletes, persisted } = makeDeps();

    const deleted = reconcileTransientFrames({}, deps);

    assert.equal(deleted, 0);
    assert.deepEqual(deletes, []);
    assert.deepEqual(persisted, []);
  });
});
