/**
 * @description Pure decision for WHEN the per-thread output queue should flush
 * a freshly-queued frame.
 *
 * Extracted from `bot.ts`'s `getOutputDelay` so the timing rule is
 * unit-testable without the Telegraf / queue machinery (same pattern as
 * {@link ../utils/statusFlushDecision.ts}). It governs only flush TIMING — the
 * append/continuation semantics of the buffer are decided elsewhere.
 *
 * Three cases:
 * - `isFinal` (the turn's last frame, emitted as the session goes idle) →
 *   `'now'`: flush immediately, regardless of a 429 cooldown. A turn that just
 *   ended must not look hung while its closing message sits out the stretched
 *   debounce.
 * - non-final + rate-limited → the stretched debounce, so we don't keep
 *   hammering Telegram while it is already throttling us.
 * - non-final + normal → the normal debounce.
 */

/**
 * Stretched debounce used while the chat is inside a Telegram 429 cooldown, so
 * coalesced output is sent in larger, less-frequent batches instead of hammering
 * an already-throttling API.
 */
export const rateLimitedOutputDebounceMs = 5000;

/** A flush that should fire immediately, bypassing the debounce. */
export type ImmediateFlush = 'now';

export interface OutputFlushTimingInput {
  /** Is this the turn's final frame (emitted as the session goes idle)? */
  isFinal: boolean;
  /** Is the chat currently inside a Telegram 429 cooldown? */
  isRateLimited: boolean;
  /** The thread's normal debounce window, in ms. */
  normalDebounceMs: number;
}

/**
 * @description Decide the flush timing for a queued output frame: either flush
 * `'now'` (final frame) or after a debounce delay in ms.
 */
export function getOutputFlushTiming(input: OutputFlushTimingInput): ImmediateFlush | number {
  if (input.isFinal) return 'now';
  if (input.isRateLimited) return Math.max(input.normalDebounceMs, rateLimitedOutputDebounceMs);
  return input.normalDebounceMs;
}
