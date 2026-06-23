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
 * - non-final + rate-limited → the stretched debounce, ADAPTIVELY scaled to the
 *   live remaining cooldown (S3): while throttled, batch the whole cooldown into
 *   one larger edit instead of a flat 5s, so a long 429 produces fewer, larger
 *   API calls rather than a backlog of tiny ones. A short cooldown still gets at
 *   least the 5s floor.
 * - non-final + normal → the normal debounce.
 */

/**
 * Stretched debounce FLOOR used while the chat is inside a Telegram 429 cooldown,
 * so coalesced output is sent in larger, less-frequent batches instead of
 * hammering an already-throttling API. The actual in-cooldown debounce scales UP
 * to the live remaining cooldown when that is longer (S3).
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
  /**
   * Live remaining 429 cooldown for the chat, in ms (0 / omitted when not
   * limited). While rate-limited, the debounce scales to this so the flush
   * batches the whole cooldown into one larger edit (S3) — fewer, bigger edits
   * under a long 429. Ignored when not rate-limited.
   */
  remainingCooldownMs?: number;
}

/**
 * @description Decide the flush timing for a queued output frame: either flush
 * `'now'` (final frame) or after a debounce delay in ms. While rate-limited the
 * delay is the LONGEST of the normal debounce, the 5s floor, and the live
 * remaining cooldown — so a long cooldown coalesces into a single larger edit
 * rather than a backlog of tiny ones (S3).
 */
export function getOutputFlushTiming(input: OutputFlushTimingInput): ImmediateFlush | number {
  if (input.isFinal) return 'now';
  if (input.isRateLimited) {
    return Math.max(
      input.normalDebounceMs,
      rateLimitedOutputDebounceMs,
      input.remainingCooldownMs ?? 0,
    );
  }
  return input.normalDebounceMs;
}
