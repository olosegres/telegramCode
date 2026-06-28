/**
 * @description Coverage for `utils/transientFrames` — the pure collector behind
 * the graceful-shutdown sweep and the boot reconciliation that delete orphaned
 * status frames. Load-bearing facts: only NON-null ids are returned, in the fixed
 * status → thinking → sub-agent order, and an all-null state yields an empty list
 * (so the sweep / boot loop does nothing).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getTransientFrameIds } from '../utils/transientFrames';

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
