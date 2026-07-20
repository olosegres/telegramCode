/**
 * @description Pure collector for a thread's TRANSIENT status-frame message ids
 * — the three SEPARATE bot messages the turn lifecycle creates-then-deletes:
 *
 *   - `statusMessageId`          — the "✽ working…" liveness/spinner frame
 *   - `thinkingMessageId`        — the live "☁️ thinking …" chain-of-thought frame
 *   - `subagentStatusMessageId`  — the dedicated "🤖 sub-agent …" delegation frame
 *
 * Returns only the non-null ones, in that fixed order, so the graceful-shutdown
 * sweep and the boot reconciliation can delete exactly the frames currently on
 * screen. These ids live ONLY in volatile in-memory `ThreadMessageState`, so a
 * restart that doesn't clean them up orphans the messages forever in the topic.
 *
 * Deliberately absent: the pinned status banner (`pinnedStatusMessageId`, a
 * persistent-by-design message) and the native typing loader (a
 * `sendChatAction('typing')` with no message of its own) — neither is a
 * transient frame.
 */
export interface TransientFrameState {
  statusMessageId: number | null;
  thinkingMessageId: number | null;
  subagentStatusMessageId: number | null;
}

export function getTransientFrameIds(state: TransientFrameState): number[] {
  const ids: number[] = [];
  if (state.statusMessageId !== null) ids.push(state.statusMessageId);
  if (state.thinkingMessageId !== null) ids.push(state.thinkingMessageId);
  if (state.subagentStatusMessageId !== null) ids.push(state.subagentStatusMessageId);
  return ids;
}

/**
 * The frame-generation guards a shutdown sweep must bump. Both are captured by
 * an in-flight `sendStatusFrame` / thinking-frame create BEFORE its `await` and
 * re-checked after (`getStatusFrameStoreDecision`) to decide store-vs-discard.
 */
export interface ShutdownFrameState extends TransientFrameState {
  statusFrameGeneration: number;
  thinkingFrameGeneration: number;
}

/**
 * @description Graceful-shutdown clear of a thread's transient frames: returns the
 * ids currently on screen (for the caller to delete), then bumps BOTH frame
 * generations and nulls all three ids.
 *
 * The generation bump is the load-bearing part, and the reason this must run for
 * EVERY tracked thread — including one whose ids are all null right now. A
 * `sendStatusFrame` / thinking-frame create that is mid-`await` when the sweep
 * runs has NOT yet stored its id (so {@link getTransientFrameIds} is empty here),
 * but it captured the pre-bump generation and re-checks it after the await
 * (`getStatusFrameStoreDecision`). Bumping makes that racing create DISCARD
 * (delete) its just-sent message instead of storing an orphan that outlives the
 * restart — the leftover "🔧 <tool>…" / "✽ working…" frame stranded as a topic's
 * last message. Mirrors the bump `deleteStatusMessage` already does for the
 * mid-session delete; the shutdown path previously nulled the ids WITHOUT bumping,
 * so it sat outside that race protection.
 */
export function clearTransientFramesForShutdown(state: ShutdownFrameState): number[] {
  const ids = getTransientFrameIds(state);
  state.statusFrameGeneration += 1;
  state.thinkingFrameGeneration += 1;
  state.statusMessageId = null;
  state.thinkingMessageId = null;
  state.subagentStatusMessageId = null;
  return ids;
}
