/**
 * @description Coverage for `utils/transientFrames` — the pure collector behind
 * the graceful-shutdown sweep and the boot reconciliation that delete orphaned
 * status frames. Load-bearing facts: only NON-null ids are returned, in the fixed
 * status → thinking → sub-agent order, and an all-null state yields an empty list
 * (so the sweep / boot loop does nothing).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getTransientFrameIds,
  clearTransientFramesForShutdown,
  type ShutdownFrameState,
} from '../utils/transientFrames';
import { getStatusFrameStoreDecision } from '../utils/claudeLivenessAction';

function makeShutdownState(overrides: Partial<ShutdownFrameState> = {}): ShutdownFrameState {
  return {
    statusMessageId: null,
    thinkingMessageId: null,
    subagentStatusMessageId: null,
    statusFrameGeneration: 0,
    thinkingFrameGeneration: 0,
    ...overrides,
  };
}

test('collects all three non-null frame ids in status → thinking → sub-agent order', () => {
  assert.deepEqual(
    getTransientFrameIds({
      statusMessageId: 10,
      thinkingMessageId: 20,
      subagentStatusMessageId: 30,
    }),
    [10, 20, 30],
  );
});

test('skips null frame ids, keeping the rest in order', () => {
  assert.deepEqual(
    getTransientFrameIds({
      statusMessageId: null,
      thinkingMessageId: 20,
      subagentStatusMessageId: null,
    }),
    [20],
  );
  assert.deepEqual(
    getTransientFrameIds({
      statusMessageId: 5,
      thinkingMessageId: null,
      subagentStatusMessageId: 7,
    }),
    [5, 7],
  );
});

test('returns an empty list when every frame id is null', () => {
  assert.deepEqual(
    getTransientFrameIds({
      statusMessageId: null,
      thinkingMessageId: null,
      subagentStatusMessageId: null,
    }),
    [],
  );
});

test('clearTransientFramesForShutdown returns on-screen ids, then nulls them and bumps both generations', () => {
  const state = makeShutdownState({
    statusMessageId: 10,
    thinkingMessageId: 20,
    subagentStatusMessageId: 30,
    statusFrameGeneration: 4,
    thinkingFrameGeneration: 7,
  });
  const ids = clearTransientFramesForShutdown(state);
  assert.deepEqual(ids, [10, 20, 30]);
  assert.equal(state.statusMessageId, null);
  assert.equal(state.thinkingMessageId, null);
  assert.equal(state.subagentStatusMessageId, null);
  assert.equal(state.statusFrameGeneration, 5);
  assert.equal(state.thinkingFrameGeneration, 8);
});

test('bumps generations EVEN when every id is null (the racing-create case)', () => {
  // The bug: a `sendStatusFrame` create mid-`await` at sweep time has stored no
  // id yet, so the old sweep (gated on `ids.length === 0`) skipped the thread and
  // never bumped — the create then stored an orphan that survived the restart.
  const state = makeShutdownState({ statusFrameGeneration: 2, thinkingFrameGeneration: 2 });
  const ids = clearTransientFramesForShutdown(state);
  assert.deepEqual(ids, [], 'nothing on screen to delete');
  assert.equal(state.statusFrameGeneration, 3, 'status generation still bumped');
  assert.equal(state.thinkingFrameGeneration, 3, 'thinking generation still bumped');
});

test('a status create that captured the pre-sweep generation now DISCARDS (no orphan)', () => {
  // End-to-end of the fix: the in-flight create snapshots the generation before
  // its await; the sweep bumps it; `getStatusFrameStoreDecision` then says discard.
  const state = makeShutdownState({ statusFrameGeneration: 9 });
  const generationAtCreateStart = state.statusFrameGeneration; // create begins pre-sweep
  clearTransientFramesForShutdown(state); // sweep runs during the create's await
  assert.equal(
    getStatusFrameStoreDecision(generationAtCreateStart, state.statusFrameGeneration),
    'discard',
  );
});
