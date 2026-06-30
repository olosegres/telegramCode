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
import {
  buildClaudeLivenessFrameText,
  checkShouldForceIdleRemoval,
  getClaudeLivenessAction,
  getClaudeLivenessShouldStop,
  getStatusFrameStoreDecision,
} from '../utils/claudeLivenessAction';

test('create: busy, no frame, not streaming — the #11 gap', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: true, hasStatusFrame: false, isOutputStreaming: false, idleTransition: false, isSuppressed: false }),
    'create',
  );
});

test('tick: busy, frame already up, not streaming — keep it visibly alive', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: true, hasStatusFrame: true, isOutputStreaming: false, idleTransition: false, isSuppressed: false }),
    'tick',
  );
});

test('delete: busy→idle edge with a frame still on screen', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: false, hasStatusFrame: true, isOutputStreaming: false, idleTransition: true, isSuppressed: false }),
    'delete',
  );
});

test('delete: simply not busy with a frame still up (no explicit edge)', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: false, hasStatusFrame: true, isOutputStreaming: false, idleTransition: false, isSuppressed: false }),
    'delete',
  );
});

test('delete: idleTransition removes the frame even if busy flickered back on', () => {
  // The explicit edge wins over a same-tick busy reading so a brief busy
  // flicker can't strand the frame past the user-visible idle.
  assert.equal(
    getClaudeLivenessAction({ isBusy: true, hasStatusFrame: true, isOutputStreaming: false, idleTransition: true, isSuppressed: false }),
    'delete',
  );
});

test('noop: streaming output owns the message — never fight it (create suppressed)', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: true, hasStatusFrame: false, isOutputStreaming: true, idleTransition: false, isSuppressed: false }),
    'noop',
  );
});

test('noop: streaming output owns the message — never fight it (delete suppressed)', () => {
  // Even on an idle edge, if output is streaming we leave the message to the
  // output path; the next non-streaming tick handles removal.
  assert.equal(
    getClaudeLivenessAction({ isBusy: false, hasStatusFrame: true, isOutputStreaming: true, idleTransition: true, isSuppressed: false }),
    'noop',
  );
});

test('noop: idle with no frame — nothing to do, loop self-disarms', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: false, hasStatusFrame: false, isOutputStreaming: false, idleTransition: false, isSuppressed: false }),
    'noop',
  );
});

// ── S2 idle-suppress latch: no fresh frame after a pane-static force-removal ──

test('noop: busy + no frame but SUPPRESSED — never recreate the force-removed frame', () => {
  // After the 30s pane-static net removed the frame, a busy footer reading must
  // NOT resurrect it; only the next prompt (which clears the latch) re-arms.
  assert.equal(
    getClaudeLivenessAction({ isBusy: true, hasStatusFrame: false, isOutputStreaming: false, idleTransition: false, isSuppressed: true }),
    'noop',
  );
});

test('delete: SUPPRESSED with a stray frame still tracked — clean it up, never tick', () => {
  assert.equal(
    getClaudeLivenessAction({ isBusy: true, hasStatusFrame: true, isOutputStreaming: false, idleTransition: false, isSuppressed: true }),
    'delete',
  );
});

// ── S2 force-idle removal: pane static ≥ threshold ───────────────────────────

test('force-remove: pane static for exactly the threshold → true', () => {
  assert.equal(checkShouldForceIdleRemoval({ msSincePaneChange: 30000, idlePaneThresholdMs: 30000 }), true);
});

test('force-remove: pane static beyond the threshold → true', () => {
  assert.equal(checkShouldForceIdleRemoval({ msSincePaneChange: 45000, idlePaneThresholdMs: 30000 }), true);
});

test('keep: pane changed recently (under threshold) — a genuine think never trips it', () => {
  // A working agent repaints the pane every second, so msSincePaneChange stays
  // tiny; this is the non-regression guard for a long xhigh thinking phase.
  assert.equal(checkShouldForceIdleRemoval({ msSincePaneChange: 1200, idlePaneThresholdMs: 30000 }), false);
});

test('keep: no live session (null age) is never treated as idle', () => {
  assert.equal(checkShouldForceIdleRemoval({ msSincePaneChange: null, idlePaneThresholdMs: 30000 }), false);
});

// ── S1 working-frame text: a live elapsed survives the dedup glyph-strip ──────

test('frame text: scraped activity word + advancing m:ss tail (the un-freeze)', () => {
  const base = 1_000_000;
  const at42 = buildClaudeLivenessFrameText({
    glyph: '✻',
    activityText: '🔧 working on it',
    fallbackText: '✻ working…',
    workingSince: base,
    nowMs: base + 42000,
  });
  assert.equal(at42, '✻ 🔧 working on it · 0:42');
  // 3s later the elapsed advances even though the activity word is unchanged.
  const at45 = buildClaudeLivenessFrameText({
    glyph: '✽',
    activityText: '🔧 working on it',
    fallbackText: '✽ working…',
    workingSince: base,
    nowMs: base + 45000,
  });
  assert.equal(at45, '✽ 🔧 working on it · 0:45');
});

test('frame text: swaps the scrape’s OWN leading spinner glyph for the rotating one', () => {
  const text = buildClaudeLivenessFrameText({
    glyph: '✶',
    activityText: '✻ Clauding…',
    fallbackText: '✶ working…',
    workingSince: 0,
    nowMs: 8000,
  });
  assert.equal(text, '✶ Clauding… · 0:08');
});

test('frame text: no activity → neutral fallback + elapsed tail', () => {
  const text = buildClaudeLivenessFrameText({
    glyph: '✢',
    activityText: null,
    fallbackText: '✢ working…',
    workingSince: 0,
    nowMs: 63000,
  });
  assert.equal(text, '✢ working… · 1:03');
});

test('frame text: workingSince null → no tail (defensive)', () => {
  const text = buildClaudeLivenessFrameText({
    glyph: '✻',
    activityText: '🔧 tool',
    fallbackText: '✻ working…',
    workingSince: null,
    nowMs: 5000,
  });
  assert.equal(text, '✻ 🔧 tool');
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

// ── Stop decision (orphan-on-idle race, live 2026-06-29) ─────────────────────
//
// The loop must NOT stop while a status-frame send is still pending in the
// coalescer: `sendStatusFrame` stores `statusMessageId` only AFTER its network
// await, so stopping on a tick that reads `hasStatusFrame === false` would
// strand the just-landed frame with no loop to delete it on idle — a hung
// "☁️ thinking …" that lingers until the next message.

test('stop: idle, no frame, coalescer drained → loop stops', () => {
  assert.equal(
    getClaudeLivenessShouldStop({ isBusy: false, hasStatusFrame: false, statusSendPending: false, withinArmingGrace: false }),
    true,
  );
});

test('no-stop: still busy → keep ticking', () => {
  assert.equal(
    getClaudeLivenessShouldStop({ isBusy: true, hasStatusFrame: false, statusSendPending: false, withinArmingGrace: false }),
    false,
  );
});

test('no-stop: a tracked frame is still up → keep ticking so idle can delete it', () => {
  assert.equal(
    getClaudeLivenessShouldStop({ isBusy: false, hasStatusFrame: true, statusSendPending: false, withinArmingGrace: false }),
    false,
  );
});

test('no-stop: idle + no frame BUT a status send is pending → keep ticking (THE race)', () => {
  // The final frame is mid-create (id not yet stored). The OLD rule
  // (`statusMessageId === null`) stopped here and the landing send orphaned the
  // frame; the coalescer-aware rule keeps the loop alive until the send lands.
  assert.equal(
    getClaudeLivenessShouldStop({ isBusy: false, hasStatusFrame: false, statusSendPending: true, withinArmingGrace: false }),
    false,
  );
});

// ── S2 busy-onset arming grace ────────────────────────────────────────────────
//
// A prompt was just forwarded so the loop is armed, but Claude's footer busy
// signal has not flipped yet → the first tick reads idle/no-frame/nothing-pending.
// Without the grace that is the STOP condition and the loop dies before the think
// even starts (the muted-topic "looks hung" bug). While in grace, never stop.

test('no-stop: idle within the arming grace → keep ticking until Claude goes busy', () => {
  assert.equal(
    getClaudeLivenessShouldStop({ isBusy: false, hasStatusFrame: false, statusSendPending: false, withinArmingGrace: true }),
    false,
  );
});

test('stop: idle AFTER the arming grace expired → the normal idle stop applies', () => {
  // Grace lapsed and Claude never went busy (e.g. a no-op slash) → stop cleanly.
  assert.equal(
    getClaudeLivenessShouldStop({ isBusy: false, hasStatusFrame: false, statusSendPending: false, withinArmingGrace: false }),
    true,
  );
});

test('grace short-circuits regardless of frame/pending state (always keep ticking)', () => {
  assert.equal(
    getClaudeLivenessShouldStop({ isBusy: false, hasStatusFrame: true, statusSendPending: true, withinArmingGrace: true }),
    false,
  );
});

test('lifecycle: a frame landing AS the loop reaches idle is NOT orphaned (race fix)', () => {
  const model = createStatusFrameModel();

  // The final thinking frame's coalescer send is in flight: statusMessageId is
  // still null, but a message WILL appear. Old loop stopped here (orphan); the
  // new rule refuses to stop while the send is pending.
  assert.equal(
    getClaudeLivenessShouldStop({
      isBusy: false,
      hasStatusFrame: model.state.statusMessageId !== null,
      statusSendPending: true,
      withinArmingGrace: false,
    }),
    false,
    'must not stop while a send is in flight',
  );

  // The send lands → a frame is now tracked and on screen.
  model.sendFrame();
  assert.equal(model.onScreen.size, 1);
  assert.notEqual(model.state.statusMessageId, null);

  // The loop is still alive; the next idle tick deletes the landed frame.
  model.deleteFrame();
  assert.equal(model.onScreen.size, 0, 'idle tick removed the landed frame — no orphan');
  assert.equal(model.state.statusMessageId, null);

  // Nothing pending now → loop stops cleanly.
  assert.equal(
    getClaudeLivenessShouldStop({ isBusy: false, hasStatusFrame: false, statusSendPending: false, withinArmingGrace: false }),
    true,
  );
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
