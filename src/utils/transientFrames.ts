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
