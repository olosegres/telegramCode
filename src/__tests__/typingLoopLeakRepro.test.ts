/**
 * @description Reproduces the "typing indicator hangs forever" leak at the
 * output-queue level and proves BOTH the source fix and the loop-level backstop.
 *
 * ROOT CAUSE (live 2026-07-19, a json-stream GROUP topic). `bot.ts`'s
 * `checkIsOutputStreaming` reads `q.pendingOutput !== null || q.isProcessing ||
 * q.debounceTimer !== null`. `queueOutput` cleared the debounce timer on every
 * call but, on the `isFinal`/`isComplete` immediate-flush fast-path, RETURNED
 * without reassigning `q.debounceTimer` — so a bare `clearTimeout` left the field
 * holding a dead-but-non-null handle. After a turn's final flush the queue was
 * otherwise empty (`pendingOutput` null, `isProcessing` false) yet
 * `q.debounceTimer` stayed non-null → `checkIsOutputStreaming` stayed true →
 * `checkShouldKeepTyping` stayed true → the loader kept firing
 * `sendChatAction('typing')` every 4s indefinitely.
 *
 * This test models the LOAD-BEARING timer bookkeeping of `queueOutput` /
 * `processOutputQueue` (the immediate-flush path that leaked) and the
 * `checkIsOutputStreaming` queue predicate, parameterised by the fix, and drives
 * the exact sequence from the live trace: some streamed deltas, then an `isFinal`
 * flush at turn end.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkIsTypingStuckByLeak } from '../utils/typingLoopBackstop';

/** The three load-bearing fields of `bot.ts`'s `OutputQueueState`. */
interface QueueModel {
  pendingOutput: string | null;
  isProcessing: boolean;
  debounceTimer: NodeJS.Timeout | null;
}

function freshQueue(): QueueModel {
  return { pendingOutput: null, isProcessing: false, debounceTimer: null };
}

/** Mirror of the queue predicate inside `checkIsOutputStreaming` (group path:
 *  the transport's `checkIsStreaming` is always false). */
function isOutputStreaming(q: QueueModel): boolean {
  return q.pendingOutput !== null || q.isProcessing || q.debounceTimer !== null;
}

/**
 * Faithful model of `bot.ts`'s `queueOutput` timer bookkeeping. `nullOnClear`
 * toggles THE FIX: when false it reproduces the pre-fix bare `clearTimeout`
 * (leaks the handle on the isFinal path); when true it nulls the handle as the
 * fix does. On the isFinal path a synchronous `processOutputQueue` model runs
 * (take buffer → send → clear `isProcessing`; the finally re-arms only if
 * `pendingOutput` remains — which it doesn't for a fully-sent turn).
 */
function queueOutput(q: QueueModel, output: string, isFinal: boolean, nullOnClear: boolean): void {
  q.pendingOutput = (q.pendingOutput ?? '') + output;
  if (q.debounceTimer) {
    clearTimeout(q.debounceTimer);
    if (nullOnClear) q.debounceTimer = null; // THE FIX
  }
  if (isFinal) {
    // processOutputQueue (synchronous model of the immediate flush)
    q.isProcessing = true;
    q.pendingOutput = null; // snapshot taken + "sent"
    q.isProcessing = false;
    // finally: pendingOutput is null → debounceTimer is left as-is (the leak
    // window: pre-fix it is still the stale non-null handle).
    return;
  }
  q.debounceTimer = setTimeout(() => { q.debounceTimer = null; }, 3000);
  q.debounceTimer.unref?.();
}

/** Drive the live sequence: streamed deltas, then the turn-end `isFinal` flush. */
function runTurn(nullOnClear: boolean): QueueModel {
  const q = freshQueue();
  queueOutput(q, '#', false, nullOnClear);
  queueOutput(q, '24 внесена', false, nullOnClear);
  queueOutput(q, ' — жду VIN.', true, nullOnClear); // handleTurnEnd → flushAnswer(isFinal)
  return q;
}

test('PRE-FIX: the isFinal flush leaks a dead debounce handle → isOutputStreaming stuck true', () => {
  const q = runTurn(/* nullOnClear */ false);
  assert.equal(q.pendingOutput, null, 'the turn was fully sent — nothing queued');
  assert.equal(q.isProcessing, false, 'not actively sending');
  assert.notEqual(q.debounceTimer, null, 'BUG: the dead debounce handle lingers');
  assert.equal(isOutputStreaming(q), true, 'BUG: isOutputStreaming is pinned true by the stale handle');
  if (q.debounceTimer) clearTimeout(q.debounceTimer); // test hygiene
});

test('BACKSTOP catches the pre-fix leak and repair clears it', () => {
  const q = runTurn(/* nullOnClear */ false);
  const stuck = checkIsTypingStuckByLeak({
    isAdapterBusy: false,
    isTransportStreaming: false,
    hasPendingOutput: q.pendingOutput != null,
    isProcessing: q.isProcessing,
    hasDebounceTimer: q.debounceTimer != null,
  });
  assert.equal(stuck, true, 'the backstop must recognise the provable inconsistency');
  // Repair (as startTypingLoader does before stopping the loader).
  if (q.debounceTimer) { clearTimeout(q.debounceTimer); q.debounceTimer = null; }
  assert.equal(isOutputStreaming(q), false, 'after repair the queue is drained → loop self-stops');
});

test('POST-FIX: the isFinal flush leaves the queue fully drained → typing self-stops', () => {
  const q = runTurn(/* nullOnClear */ true);
  assert.equal(q.pendingOutput, null);
  assert.equal(q.isProcessing, false);
  assert.equal(q.debounceTimer, null, 'the fix nulls the handle on the isFinal path');
  assert.equal(isOutputStreaming(q), false, 'no leak → checkShouldKeepTyping goes false');
  // And with a drained queue the backstop is inert (nothing to force-stop).
  assert.equal(
    checkIsTypingStuckByLeak({
      isAdapterBusy: false,
      isTransportStreaming: false,
      hasPendingOutput: false,
      isProcessing: false,
      hasDebounceTimer: false,
    }),
    false,
  );
});

test('a legit long silent-tool turn (adapter busy, mid-stream) is NEVER force-stopped', () => {
  // Mid-turn: a delta was queued and its debounce is armed; the adapter is busy
  // on a long silent Bash. Both the "keep typing" signal AND the veto hold.
  const q = freshQueue();
  queueOutput(q, 'partial answer', false, /* nullOnClear */ true);
  assert.equal(isOutputStreaming(q), true, 'a real armed debounce with pending intent still streams');
  assert.equal(
    checkIsTypingStuckByLeak({
      isAdapterBusy: true, // long silent tool → genuinely working
      isTransportStreaming: false,
      hasPendingOutput: q.pendingOutput != null,
      isProcessing: q.isProcessing,
      hasDebounceTimer: q.debounceTimer != null,
    }),
    false,
    'a busy turn is never cut',
  );
  if (q.debounceTimer) clearTimeout(q.debounceTimer);
});
