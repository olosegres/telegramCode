/**
 * @description Pure decision for the per-thread status-coalescer flush loop:
 * given the frame about to be sent, the last frame that actually reached
 * Telegram, and whether the chat is in a 429 cooldown, decide what the loop
 * should do with this frame.
 *
 * Extracted from `bot.ts`'s `flushStatusCoalescer` so the rule is unit-testable
 * without the Telegraf / bucket machinery (same pattern as
 * `clearThreadOutputQueues.ts`). Status frames are disposable spinner ticks:
 * during congestion it is correct to drop or defer them rather than burn the
 * chat-wide send budget that interactive command replies and agent output need.
 *
 * @name StatusFlushAction
 * @description
 * - `send`   — text differs from the last sent frame and the chat is not in a
 *   cooldown: send it now.
 * - `skip`   — text equals the last sent frame after stripping the leading
 *   spinner glyph: sending it would either earn a `400 "message is not
 *   modified"` (truly identical) or an `editMessageText` that changed ONLY the
 *   rotating liveness glyph — a per-second edit purely for animation. Either
 *   way it wastes a token, so consume `pendingText` and move on. The native
 *   typing indicator already carries alive-ness; the visible status frame's
 *   glyph effectively freezes until the activity text actually changes.
 * - `defer`  — the chat is rate-limited: do NOT send (a stale spinner frame is
 *   not worth a token while a 429 cooldown is starving real traffic). Leave
 *   `pendingText` in place so the newest frame is sent once the cooldown lifts.
 */
import { stripLeadingSpinnerGlyph } from './claudeScrapeShapes';

export type StatusFlushAction = 'send' | 'skip' | 'defer';

export interface StatusFlushDecisionInput {
  /** Frame the loop is about to send. */
  nextText: string;
  /** Last frame that successfully reached Telegram for this thread, or null. */
  lastSentText: string | null;
  /** Is the chat currently inside a Telegram 429 cooldown? */
  isRateLimited: boolean;
}

/**
 * @description Decide what the status-flush loop should do with `nextText`.
 *
 * Cooldown wins over dedup: while rate-limited we always `defer` (even an
 * identical frame) so the loop exits leaving the latest `pendingText` for the
 * post-cooldown flush, instead of spinning and re-checking the clock.
 */
export function getStatusFlushAction(input: StatusFlushDecisionInput): StatusFlushAction {
  if (input.isRateLimited) return 'defer';
  if (input.lastSentText === null) return 'send';
  // Compare on a glyph-stripped signature: the liveness frame rotates its
  // leading spinner glyph every tick, so an exact-string compare treated each
  // cosmetic-only tick as new → one editMessageText per second. Equal after
  // stripping the lead glyph ⇒ skip (no edit); a real activity-text change ⇒ send.
  if (stripLeadingSpinnerGlyph(input.nextText) === stripLeadingSpinnerGlyph(input.lastSentText)) {
    return 'skip';
  }
  return 'send';
}
