/**
 * @description OpenCode never interrupts a running turn for a new prompt:
 * `prompt_async` queues the message and the agent reads it promptly, so unlike
 * the Claude TUI (which ignores typed input mid-turn and needs Escape first)
 * aborting would only lose live work (user decision 2026-06-06). The contract
 * tests lock that asymmetry on the adapter prototypes; the tracking tests cover
 * `applyOpenCodeStatusEvent`, the SSE-driven busy state behind
 * `checkIsOpenCodeSessionBusy` (the scheduler's wait-for-idle probe).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  OpenCodeAdapter,
  applyOpenCodeStatusEvent,
  type OpenCodeBusyTracking,
} from '../adapters/openCodeAdapter';
import { ClaudeCliAdapter } from '../adapters/claudeCliAdapter';

const own = 'ses_own';
const child = 'ses_child';
const freshTracking = (): OpenCodeBusyTracking => ({ isBusy: false, busyChildSessionIds: new Set() });

// ── interrupt-before-prompt contract ──

test('opencode adapter does NOT implement interruptAndWaitIdle — a new prompt queues, never aborts', () => {
  assert.equal(
    'interruptAndWaitIdle' in OpenCodeAdapter.prototype,
    false,
    'forwardPromptToAgent must forward directly for OpenCode',
  );
});

test('claude adapter DOES implement interruptAndWaitIdle — its TUI ignores input mid-turn without Escape', () => {
  assert.equal(typeof ClaudeCliAdapter.prototype.interruptAndWaitIdle, 'function');
});

// ── SSE busy tracking ──

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
