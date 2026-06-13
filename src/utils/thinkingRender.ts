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

const secondsPerMinute = 60;
const secondsPerHour = 3600;

/**
 * @description Extract the FIRST `for <Nh Nm Ns>` duration clause anywhere in a
 * scraped Claude thinking block — the `Thinking for *1m 6s*…` header
 * (`THINKING_HEADER_RE`) or the `✻ Cooked for 1m 6s` trailer
 * (`POST_THINKING_TRAILER_RE`). Tolerates the ANSI-bold `*…*` wraps and the
 * trailing U+2026 ellipsis around the duration. Each of h/m/s is optional but
 * at least one must be present for a match.
 */
const THINKING_DURATION_CLAUSE_RE =
  /\bfor\s+\*?(?:(\d+)h\s+)?(?:(\d+)m\s+)?(?:(\d+)s)\*?/;

/**
 * @description Parse the whole-second reasoning duration out of a scraped Claude
 * thinking block, or null when no duration clause is present. The Claude backend
 * has no millisecond timestamps like OpenCode — the only signal is the duration
 * the TUI renders as text in the block's header / trailer, so this scrapes it
 * from {@link THINKING_DURATION_CLAUSE_RE} (the first line that carries one).
 */
export function parseThinkingDurationSeconds(blockText: string): number | null {
  for (const line of blockText.split('\n')) {
    const match = line.match(THINKING_DURATION_CLAUSE_RE);
    if (!match) continue;
    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = match[2] ? Number(match[2]) : 0;
    const seconds = match[3] ? Number(match[3]) : 0;
    return hours * secondsPerHour + minutes * secondsPerMinute + seconds;
  }
  return null;
}
