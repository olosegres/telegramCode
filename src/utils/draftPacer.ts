/**
 * @description Pure pacing decision for the DM-mode live-draft channel (P3),
 * mirroring {@link ../utils/statusFlushDecision.ts} in shape: given the latest
 * accumulated draft text, the last text actually drafted, the clock, and the
 * draft-channel 429 cooldown, decide what the draft loop should do with this
 * update.
 *
 * The draft channel is SEPARATE from the message channel: it never touches the
 * rateLimiter TokenBucket / per-chat 429 cooldown, so its own backoff
 * (`backoffUntilMs`) can never starve real `sendMessage`/`editMessageText`
 * traffic. Drafts are disposable previews — under congestion it is correct to
 * defer them rather than spend a draft call on a frame the next one will replace.
 *
 * @name DraftPaceAction
 * @description
 * - `send`  — text changed, not too soon since the last send, no draft-channel
 *   cooldown: fire the draft now.
 * - `skip`  — text is identical to the last drafted text: a draft update would
 *   only re-send the same preview; don't spend a draft call.
 * - `defer` — either a draft-channel 429 cooldown is active, or the min interval
 *   since the last send hasn't elapsed: hold the newest text and re-arm a timer
 *   for the remainder.
 */
export type DraftPaceAction = 'send' | 'skip' | 'defer';

/**
 * Min gap between two draft updates of the same in-flight response. ~700ms →
 * ~1.4 updates/sec — fast enough to read as a live "typing" animation, slow
 * enough to stay well under the draft budget the P0.5 probe measured.
 */
export const DRAFT_MIN_INTERVAL_MS = 700;

/**
 * Fallback draft-channel backoff when a draft 429 omits `retry_after`. The P0.5
 * live probe saw ~20s draft cooldowns; the runtime prefers the error's
 * `retry_after` when present and uses this only as the floor/fallback.
 */
export const DRAFT_DEFAULT_BACKOFF_MS = 20_000;

export interface DraftPaceInput {
  /** Latest accumulated draft text the loop wants to show. */
  nextText: string;
  /** Last text actually drafted for this thread, or null (nothing sent yet). */
  lastSentText: string | null;
  /** Current time, ms. */
  nowMs: number;
  /** When the last draft actually went out, ms, or null (nothing sent yet). */
  lastSentAtMs: number | null;
  /** Min gap between two draft sends, ms (= {@link DRAFT_MIN_INTERVAL_MS}). */
  minIntervalMs: number;
  /** Draft-channel 429 cooldown end, ms. `0` = no cooldown. */
  backoffUntilMs: number;
}

/**
 * @description Decide what the draft pacer should do with `nextText`.
 *
 * Order matters: the 429 cooldown wins over everything (defer even an identical
 * frame so the loop exits leaving the newest text for the post-cooldown re-arm);
 * then an unchanged frame is a `skip` (no draft call); then the min-interval
 * gate `defer`s a too-soon update; otherwise `send`.
 */
export function getDraftPaceAction(input: DraftPaceInput): DraftPaceAction {
  if (input.nowMs < input.backoffUntilMs) return 'defer';
  if (input.nextText === input.lastSentText) return 'skip';
  if (input.lastSentAtMs !== null && input.nowMs - input.lastSentAtMs < input.minIntervalMs) {
    return 'defer';
  }
  return 'send';
}

/**
 * @description Whether an `output` event should be streamed via the native DM
 * draft channel. Drafts are for genuinely INCREMENTAL streaming; a COMPLETE
 * one-shot output (`meta.isComplete`, e.g. the resume context block) is already
 * whole at emit time — drafting it would make Telegram's native draft "typing"
 * animation draw static text progressively, so it must post directly. Sub-agent
 * chunks are never drafted either. Group mode never drafts.
 */
export function checkShouldStreamAsDraft(
  isDmMode: boolean,
  meta?: { isComplete?: boolean; isSubagent?: boolean },
): boolean {
  if (!isDmMode) return false;
  if (meta?.isComplete === true) return false;
  if (meta?.isSubagent === true) return false;
  return true;
}
