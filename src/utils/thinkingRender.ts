/**
 * @description Pure decision + formatting helpers for the OpenCode "thinking"
 * (chain-of-thought) rendering lifecycle. The adapter emits a mode-AGNOSTIC
 * {@link ThinkingEvent}; the bot's `handleAgentThinking` consults
 * {@link getThinkingEventAction} per emit and {@link getThinkingAnswerStartAction}
 * when the answer begins. Extracted from `bot.ts` so the mode×phase matrix is
 * unit-testable without the Telegraf / token-bucket machinery (same pattern as
 * `statusFlushDecision.ts`).
 *
 * The mode only controls what REMAINS after reasoning ends — the live
 * "thinking …" indicator is shown in ALL three modes while the agent reasons.
 */
import type { DisplayVerbosityMode, ThinkingPhase } from '../types';

// Mode options / type guard / normalization live in the shared
// `utils/displayVerbosity.ts` — the vocabulary is unified across the three
// display commands; this module owns only the thinking-specific semantics.

/**
 * @name ThinkingMessageAction
 * @description What the bot should do with the thread's thinking message.
 *
 * - `editLiveLabel`     — show / refresh the live "☁️ thinking …" indicator
 *   (label only, no reasoning body). Used by `short` + `minimal` while reasoning.
 * - `editLiveDetailed`  — show / refresh the live indicator WITH the full
 *   accumulated reasoning text appended under it. Used by `full` while
 *   reasoning.
 * - `collapseToDuration`— replace the body with the collapsed
 *   "💭 thought for {N}s" line and persist (clear the tracked id). `short` done.
 * - `keep`              — leave the message exactly as-is and persist (clear the
 *   tracked id so the next response starts a fresh message). `full` done.
 * - `holdForAnswer`     — leave the message as-is but KEEP tracking its id, so
 *   the answer-start trigger can delete it. `minimal` done — the live indicator
 *   stays until the answer begins.
 * - `delete`            — remove the thinking message entirely (clear the id).
 *   `minimal` when the answer starts.
 * - `noop`              — do nothing. (`full`/`short` need no special
 *   handling when the answer starts — their message already persists.)
 */
export type ThinkingMessageAction =
  | 'editLiveLabel'
  | 'editLiveDetailed'
  | 'collapseToDuration'
  | 'keep'
  | 'holdForAnswer'
  | 'delete'
  | 'noop';

/**
 * @description Decide what the bot does for a `thinking` event in `mode` at
 * `phase`. Pure — depends only on the mode and phase, never on Telegram state.
 *
 * Matrix:
 * ```
 *            phase=live          phase=done
 * full       editLiveDetailed    keep
 * short      editLiveLabel       collapseToDuration
 * minimal    editLiveLabel       holdForAnswer
 * ```
 * `minimal`+done resolves to `holdForAnswer` (not `delete`): the live indicator
 * stays AND its id stays tracked until the ANSWER starts, which is a separate
 * trigger ({@link getThinkingAnswerStartAction}). If the answer never comes
 * (e.g. the turn ends with only reasoning), the held frame simply persists —
 * acceptable and rare.
 */
export function getThinkingEventAction(mode: DisplayVerbosityMode, phase: ThinkingPhase): ThinkingMessageAction {
  if (phase === 'live') {
    return mode === 'full' ? 'editLiveDetailed' : 'editLiveLabel';
  }
  // phase === 'done'
  if (mode === 'short') return 'collapseToDuration';
  if (mode === 'minimal') return 'holdForAnswer';
  return 'keep';
}

/**
 * @description Decide what the bot does to the thinking message when the real
 * answer starts (first `output` of the response). Only `minimal` removes it;
 * the other modes leave their persisted message in place.
 */
export function getThinkingAnswerStartAction(mode: DisplayVerbosityMode): ThinkingMessageAction {
  return mode === 'minimal' ? 'delete' : 'noop';
}

/** Milliseconds in one second — for the "thought for {N}s" duration formatter. */
const millisecondsPerSecond = 1000;

/**
 * @description Format a reasoning duration (ms) into a whole-second count for
 * the "thought for {N}s" collapsed line. Rounds to the nearest second, with a
 * floor of 1 so a sub-second reasoning burst never reads "thought for 0s".
 */
export function formatThinkingDurationSeconds(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  return Math.max(1, Math.round(durationMs / millisecondsPerSecond));
}
