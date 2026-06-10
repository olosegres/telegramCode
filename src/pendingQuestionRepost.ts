/**
 * @description Pure decision for keeping a pending interactive question at the
 * BOTTOM of its topic (plan `2026-06-09-question-ux.md`, scope S3). While a
 * question waits for an answer it must be the last message in the topic; if any
 * OTHER output reaches the topic (a still-streaming sub-agent, a tool status, an
 * api-retry notice) the question gets pushed up and the user can't see it.
 *
 * The bot owns the I/O (delete the old question message, re-send the current
 * one, the debounce timer); this module only answers "should we re-post now?"
 * so the loop-guard logic is unit-testable without a live Telegram round-trip.
 */

/**
 * @description Inputs to {@link checkShouldRepostPendingQuestion}.
 */
export interface RepostDecisionInput {
  /** Whether a question is currently pending for the thread. */
  isQuestionPending: boolean;
  /**
   * Whether the MOST RECENT thing the bot sent to the thread was the question
   * message itself (vs some other output that landed below it). True right
   * after the question is posted; flipped false as soon as anything else is
   * sent. The loop guard: a re-post must never fire in response to its own send.
   */
  wasLastSendTheQuestion: boolean;
  /**
   * Whether a question post (`postPendingQuestionAt`) is currently IN FLIGHT —
   * its send has started but `messageId` has not been stored yet. A re-post
   * must never run concurrently: it would read the PREVIOUS question's
   * `messageId`, delete that (already-answered) message, and leave the
   * in-flight post orphaned as a stale duplicate (live race 2026-06-10 in the
   * test topic: the answered-Q1 "✅" confirmation vanished and Q2 appeared
   * twice — the plan's named "repost must not fight post-next-question" risk).
   * The in-flight post lands at the bottom anyway, so skipping loses nothing.
   */
  isQuestionPostInFlight: boolean;
}

/**
 * @description Decide whether the pending question should be re-posted to the
 * bottom. Only when a question is pending AND something other than the question
 * was the last thing sent AND no question post is currently in flight —
 * otherwise re-posting would be pointless (no pending question), loop
 * (re-posting in reaction to its own send), or race the in-flight post over
 * `messageId` (deleting the wrong message; see
 * {@link RepostDecisionInput.isQuestionPostInFlight}).
 */
export function checkShouldRepostPendingQuestion(input: RepostDecisionInput): boolean {
  return (
    input.isQuestionPending &&
    !input.wasLastSendTheQuestion &&
    !input.isQuestionPostInFlight
  );
}
