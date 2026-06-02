/**
 * @description For OpenCode (HTTP+SSE, not keystroke-driven — no Escape, single
 * or double), a new prompt to a busy session aborts the current generation via
 * `POST /session/:id/abort` so it starts fresh — EXCEPT while a sub-agent
 * (child session) runs or context is compacting, where aborting would kill the
 * child / discard the summary, so the prompt must queue instead.
 * `getOpenCodeInterruptAction` is the pure decision driving that.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getOpenCodeInterruptAction,
  applyOpenCodeStatusEvent,
  type OpenCodeBusyTracking,
} from '../adapters/openCodeAdapter';

const own = 'ses_own';
const child = 'ses_child';
const freshTracking = (): OpenCodeBusyTracking => ({ isBusy: false, busyChildSessionIds: new Set() });

test('busy generation → abort before new prompt', () => {
  assert.equal(
    getOpenCodeInterruptAction({ isBusy: true, isCompacting: false, busyChildCount: 0 }),
    'abort',
  );
});

test('idle session → no interrupt needed', () => {
  assert.equal(
    getOpenCodeInterruptAction({ isBusy: false, isCompacting: false, busyChildCount: 0 }),
    'skip-idle',
  );
});

test('compaction in flight → queue, never abort (even if also flagged busy)', () => {
  assert.equal(
    getOpenCodeInterruptAction({ isBusy: true, isCompacting: true, busyChildCount: 0 }),
    'queue-compacting',
  );
});

test('sub-agent child running → queue, never abort', () => {
  assert.equal(
    getOpenCodeInterruptAction({ isBusy: true, isCompacting: false, busyChildCount: 1 }),
    'queue-subagent',
  );
});

test('compaction takes priority over a busy sub-agent (most-protective wins)', () => {
  assert.equal(
    getOpenCodeInterruptAction({ isBusy: true, isCompacting: true, busyChildCount: 2 }),
    'queue-compacting',
  );
});

test('own-session status drives isBusy (busy then idle)', () => {
  const t = freshTracking();
  applyOpenCodeStatusEvent(t, own, own, true);
  assert.equal(t.isBusy, true);
  assert.equal(t.busyChildSessionIds.size, 0);
  applyOpenCodeStatusEvent(t, own, own, false);
  assert.equal(t.isBusy, false);
});

test('a null sessionID (own session.idle fallback) clears own isBusy', () => {
  const t: OpenCodeBusyTracking = { isBusy: true, busyChildSessionIds: new Set() };
  applyOpenCodeStatusEvent(t, own, null, false);
  assert.equal(t.isBusy, false);
});

test('child (sub-agent) status maintains busyChildSessionIds, never own isBusy', () => {
  const t = freshTracking();
  applyOpenCodeStatusEvent(t, own, child, true); // sub-agent starts
  assert.equal(t.isBusy, false, 'a busy child must not mark the parent busy');
  assert.deepEqual([...t.busyChildSessionIds], [child]);
  applyOpenCodeStatusEvent(t, own, child, false); // sub-agent ends
  assert.equal(t.busyChildSessionIds.size, 0);
});

test('a child going idle must NOT clear the parent isBusy', () => {
  const t: OpenCodeBusyTracking = { isBusy: true, busyChildSessionIds: new Set([child]) };
  applyOpenCodeStatusEvent(t, own, child, false);
  assert.equal(t.isBusy, true, 'parent stays busy when only the child idled');
  assert.equal(t.busyChildSessionIds.size, 0);
});
