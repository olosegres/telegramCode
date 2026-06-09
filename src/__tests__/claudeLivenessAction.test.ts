/**
 * @description Unit tests for {@link getClaudeLivenessAction} — the pure state
 * machine the Claude liveness loop (`bot.ts`, bug #11) consults every tick.
 * Extracted so the create/tick/delete/noop rule is testable without the tmux /
 * Telegraf machinery (same pattern as `statusFlushDecision.test.ts`).
 *
 * Load-bearing cases mirror the plan's VERIFICATION block:
 *  - busy && no frame && not streaming → create (THE bug: a working agent with
 *    no on-screen indicator).
 *  - idle transition (or simply not busy) with a frame up → delete (idle-only
 *    removal).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getClaudeLivenessAction, getStatusFrameStoreDecision } from '../utils/claudeLivenessAction';

test('create: busy, no frame, not streaming — the #11 gap', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: true, hasStatusFrame: false, isOutputStreaming: false, idleTransition: false }),
    'create',
  );
});

test('tick: busy, frame already up, not streaming — keep it visibly alive', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: true, hasStatusFrame: true, isOutputStreaming: false, idleTransition: false }),
    'tick',
  );
});

test('delete: busy→idle edge with a frame still on screen', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: false, hasStatusFrame: true, isOutputStreaming: false, idleTransition: true }),
    'delete',
  );
});

test('delete: simply not busy with a frame still up (no explicit edge)', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: false, hasStatusFrame: true, isOutputStreaming: false, idleTransition: false }),
    'delete',
  );
});

test('delete: idleTransition removes the frame even if busy flickered back on', () => {
  // The explicit edge wins over a same-tick busy reading so a brief busy
  // flicker can't strand the frame past the user-visible idle.
  assert.equal(
    getClaudeLivenessAction({ isBusy: true, hasStatusFrame: true, isOutputStreaming: false, idleTransition: true }),
    'delete',
  );
});

test('noop: streaming output owns the message — never fight it (create suppressed)', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: true, hasStatusFrame: false, isOutputStreaming: true, idleTransition: false }),
    'noop',
  );
});

test('noop: streaming output owns the message — never fight it (delete suppressed)', () => {
  // Even on an idle edge, if output is streaming we leave the message to the
  // output path; the next non-streaming tick handles removal.
  assert.equal(
    getClaudeLivenessAction({ isBusy: false, hasStatusFrame: true, isOutputStreaming: true, idleTransition: true }),
    'noop',
  );
});

test('noop: idle with no frame — nothing to do, loop self-disarms', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: false, hasStatusFrame: false, isOutputStreaming: false, idleTransition: false }),
    'noop',
  );
});

// ── Status-frame store/discard generation guard (orphan/duplicate fix) ───────
//
// These cover the SECOND half of #11: a busy→idle (or busy→output→idle) cycle
// must leave ZERO leftover spinner frames. The guard makes a `deleteStatusMessage`
// that races an in-flight `sendStatusFrame` create WIN — the create discards its
// message instead of resurrecting `statusMessageId` as an on-screen orphan.

test('store: no delete raced the create (generation unchanged) → keep the id', () => {
  const generationAtStart = 7;
  assert.equal(getStatusFrameStoreDecision(generationAtStart, 7), 'store');
});

test('discard: a delete landed mid-create (generation bumped) → drop the orphan', () => {
  const generationAtStart = 7;
  // deleteStatusMessage bumped the generation while the create awaited the API.
  assert.equal(getStatusFrameStoreDecision(generationAtStart, 8), 'discard');
});

/**
 * Faithful in-memory model of the bot.ts status-frame lifecycle: a single
 * tracked `statusMessageId`, a monotonic `statusFrameGeneration` bumped on every
 * delete, and `sendStatusFrame`'s "create then store-or-discard after the await"
 * shape. Proves the END-STATE invariants without the Telegraf/tmux stack.
 */
function createStatusFrameModel() {
  const onScreen = new Set<number>();
  let nextId = 1;
  const state = { statusMessageId: null as number | null, statusFrameGeneration: 0 };

  /** deleteStatusMessage: bump gen ALWAYS, remove the tracked frame if any. */
  const deleteFrame = () => {
    state.statusFrameGeneration += 1;
    if (state.statusMessageId !== null) {
      onScreen.delete(state.statusMessageId);
      state.statusMessageId = null;
    }
  };

  /**
   * sendStatusFrame's send path with an optional `duringAwait` hook that runs
   * BETWEEN the (synchronous, in this model) message creation and the
   * store-or-discard decision — i.e. exactly the await window the real bug
   * exploits. Mirrors the real function: when a frame is already tracked it
   * EDITS in place (no new message); otherwise it creates and applies the
   * generation guard. Returns whether a frame is tracked afterwards.
   */
  const sendFrame = (duringAwait?: () => void): boolean => {
    if (state.statusMessageId !== null) {
      // Edit in place — no second message spawned for a glyph tick.
      duringAwait?.();
      return state.statusMessageId !== null;
    }
    const generationAtStart = state.statusFrameGeneration;
    const createdId = nextId++;
    onScreen.add(createdId); // the API call created a real message
    duringAwait?.();
    if (getStatusFrameStoreDecision(generationAtStart, state.statusFrameGeneration) === 'discard') {
      onScreen.delete(createdId); // orphan cleanup — delete the just-created message
      return false;
    }
    state.statusMessageId = createdId;
    return true;
  };

  return { state, onScreen, deleteFrame, sendFrame };
}

test('lifecycle: create → output-delete → recreate yields ONE tracked id and no orphan', () => {
  const model = createStatusFrameModel();

  // Liveness creates the first frame.
  model.sendFrame();
  const firstId = model.state.statusMessageId;
  assert.notEqual(firstId, null);
  assert.equal(model.onScreen.size, 1);

  // Real output arrives → deletes the frame, then the agent keeps working so the
  // next liveness tick recreates one.
  model.deleteFrame();
  model.sendFrame();

  // Exactly one frame on screen, and it is the tracked id (the recreated one).
  assert.equal(model.onScreen.size, 1);
  assert.equal(model.state.statusMessageId !== null, true);
  assert.equal(model.onScreen.has(model.state.statusMessageId as number), true);
  assert.notEqual(model.state.statusMessageId, firstId);
});

test('lifecycle: output-delete that RACES an in-flight recreate leaves ZERO orphans', () => {
  const model = createStatusFrameModel();
  model.sendFrame();
  // Output deletes the visible frame; statusMessageId is now null.
  model.deleteFrame();
  assert.equal(model.onScreen.size, 0);

  // The liveness tick recreates a frame, but a SECOND output (delete) lands while
  // that create awaits the API. The generation bump makes the racing create
  // discard its just-made message instead of resurrecting it as an orphan — the
  // exact create→null→recreate-mid-delete sequence that left two stale frames.
  const stored = model.sendFrame(() => model.deleteFrame());
  assert.equal(stored, false);
  assert.equal(model.state.statusMessageId, null);
  assert.equal(model.onScreen.size, 0);
});

test('lifecycle: idle delete removes the on-screen frame (no leftover spinner)', () => {
  const model = createStatusFrameModel();
  model.sendFrame();
  assert.equal(model.onScreen.size, 1);

  // Session goes idle → liveness `delete` action.
  model.deleteFrame();
  assert.equal(model.state.statusMessageId, null);
  assert.equal(model.onScreen.size, 0);
});

test('lifecycle: rapid send/delete cycles never accumulate more than one frame', () => {
  const model = createStatusFrameModel();
  for (let i = 0; i < 25; i++) {
    // A send either creates (when none tracked) or edits in place (when one is).
    model.sendFrame();
    // The invariant: at most ONE spinner message is ever on screen.
    assert.ok(model.onScreen.size <= 1, `frame accumulation at i=${i}: ${model.onScreen.size}`);
    if (i % 2 === 0) model.deleteFrame();
  }
  // A final delete clears the tracked frame — zero leftovers after busy→idle.
  model.deleteFrame();
  assert.equal(model.state.statusMessageId, null);
  assert.equal(model.onScreen.size, 0);
});
