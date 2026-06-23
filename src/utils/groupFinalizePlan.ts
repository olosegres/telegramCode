/**
 * @description Pure decision for the GROUP output transport's `finalizeInFlight`
 * (S2): given the thread's coalesced output-queue state at a settle/teardown
 * boundary, decide whether there is an unsent remainder to force-deliver (so the
 * agent's final answer is never discarded) or the turn is already fully
 * delivered (a no-op — no duplicate post).
 *
 * Extracted from `bot.ts`'s `finalizeGroupOutput` so the "remainder vs no-op"
 * + importance decision is unit-testable without the Telegraf / queue
 * machinery. The bot-side function owns the imperative drain (snapshot + null
 * the buffer, then `sendOutputImmediate`); this owns only the decision.
 *
 * The group queue already SEPARATES what landed from what is pending:
 * `lastMessageText` holds the last landed message and `pendingOutput` holds the
 * coalesced-but-unsent remainder. So the "reconcile final accumulated vs last
 * landed" reduces to: send `pendingOutput` if it is non-empty. No text diff is
 * needed — the queue is the single source of the remainder.
 */

/** The load-bearing fields of `bot.ts`'s `OutputQueueState` the decision needs. */
export interface GroupFinalizeInput {
  /** Coalesced, not-yet-sent agent output. `null` = nothing pending. */
  pendingOutput: string | null;
  /** Whether the FIRST batch in `pendingOutput` continues the last sent message. */
  pendingIsContinuation: boolean;
  /** Whether the buffer holds the turn's FINAL answer (drives redelivery eligibility). */
  pendingIsFinal: boolean;
}

/**
 * @description The finalize plan: either nothing to do (fully delivered), or the
 * exact remainder to send and how.
 *
 * `isImportant` carries the buffer's `pendingIsFinal`, so a buffer that genuinely
 * holds the final answer becomes redelivery-eligible (S1), while a mid-turn
 * drain (e.g. a status-ordering finalize on a still-streaming turn) stays
 * disposable.
 */
export type GroupFinalizePlan =
  | { action: 'noop' }
  | { action: 'send'; text: string; isContinuation: boolean; isImportant: boolean };

export function getGroupFinalizePlan(input: GroupFinalizeInput): GroupFinalizePlan {
  // A fully-delivered turn (no pending remainder) — and a buffer holding only
  // whitespace, which would earn a Telegram error and is not a real answer — is
  // a no-op, so a settle/teardown never double-posts.
  if (input.pendingOutput === null || input.pendingOutput.trim() === '') {
    return { action: 'noop' };
  }
  return {
    action: 'send',
    text: input.pendingOutput,
    isContinuation: input.pendingIsContinuation,
    isImportant: input.pendingIsFinal,
  };
}
