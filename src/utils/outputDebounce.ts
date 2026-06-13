/**
 * @description The output-debounce selection rule (P3), extracted as a pure
 * helper so the group-vs-DM choice is unit-testable WITHOUT booting Telegraf.
 *
 * In DM mode the live UX comes from the native `sendMessageDraft` stream (off the
 * message budget), so the persist path only needs to land the final full message
 * — interim `editMessageText` re-renders are redundant with the draft. Raising
 * the debounce coalesces those interim persists to ~0 during a stream while the
 * `isFinal` frame still flushes immediately. Group mode keeps the original
 * 1000ms window byte-for-byte and never opens a draft.
 *
 * This module owns BOTH constants so the regression test can assert the exact
 * values and the gate (group → 1000, DM → 4000) against the same source `bot.ts`
 * uses — no drift.
 */

/** Group-mode debounce. Telegram tolerates ~1 msg/sec/chat. */
export const OUTPUT_DEBOUNCE_MS = 1000;

/** DM-mode debounce — longer, because the live draft carries the UX. */
export const OUTPUT_DEBOUNCE_MS_DM = 4000;

/**
 * @description The output debounce window for the current surface. `isDmMode`
 * is the ONLY input — the same `checkIsDmMode()` predicate the draft branch
 * gates on — so a true here implies the draft path and the longer window, and a
 * false leaves group mode exactly as it was.
 */
export function getOutputDebounceMs(isDmMode: boolean): number {
  return isDmMode ? OUTPUT_DEBOUNCE_MS_DM : OUTPUT_DEBOUNCE_MS;
}
