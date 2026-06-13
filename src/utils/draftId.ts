/**
 * @description Draft-id allocator for the DM-mode live-streaming draft channel
 * (P3). Telegram's `sendMessageDraft` animates updates that share the SAME
 * `draft_id` as one in-progress draft; a NEW id starts a fresh draft. So one
 * streamed response must keep ONE stable id across all its updates, and each new
 * response (a fresh, non-continuation turn) must get a DISTINCT id so it animates
 * separately from the previous turn.
 *
 * A pure module-scoped monotonic counter gives both: {@link nextDraftId} is
 * called ONCE per response (at `startDraftTurn`), and the returned id is then
 * stored on the per-thread draft state and reused for every update of that
 * response. Two DM topics streaming at once get distinct ids because each pulls
 * its own value off the shared counter.
 *
 * The id is folded into a NON-ZERO 31-bit positive int: Telegram requires a
 * non-zero draft id, and a small positive int avoids any signedness surprises in
 * the Bot API. The counter wraps at {@link DRAFT_ID_MODULO} without ever
 * yielding 0.
 */

/**
 * Wrap point for the draft-id counter. Kept well inside the 31-bit positive
 * range (2_147_483_647) so the `+1` fold can never reach a 32-bit boundary.
 */
export const DRAFT_ID_MODULO = 2_000_000_000;

let draftIdCounter = 0;

/**
 * @description Allocate the next draft id. Monotonic per process, folded into a
 * non-zero positive 31-bit int via `(counter % MODULO) + 1`, so the value is
 * always in `[1, DRAFT_ID_MODULO]` and never 0 even at the wrap boundary.
 *
 * `prevId` is accepted for symmetry with the per-thread state (and to make a
 * future "derive from previous" tweak local to this module) but is intentionally
 * unused: uniqueness comes from the shared monotonic counter, not the caller's
 * last id, so two interleaved per-thread turns can never collide.
 */
export function nextDraftId(prevId: number | null): number {
  void prevId;
  const id = (draftIdCounter % DRAFT_ID_MODULO) + 1;
  draftIdCounter += 1;
  return id;
}
