/**
 * @description Pure decision for the OpenCode "prompt delivered but the agent
 * never ran a turn" detector.
 *
 * OpenCode ALWAYS creates an assistant message when a turn genuinely starts
 * (even a pure delegation emits the parent's text before spawning a sub-agent),
 * so a healthy turn is always accompanied by assistant activity. A WEDGED
 * session instead accepts the prompt (HTTP 204 from `prompt_async`), records the
 * user message, and its agent loop exits IMMEDIATELY — no `message.updated`, no
 * parts, no LLM call — so `session.idle` arrives with zero assistant activity
 * and the topic looks silently hung.
 *
 * Live incident (2026-08-15, the my-news digest schedule): a bloated session
 * (~648K tokens) accepted every scheduled/manual prompt but produced no output;
 * three user messages piled up with no assistant reply and the topic looked
 * dead with no explanation.
 *
 * Guards against false positives:
 *  - a context compaction cycle legitimately idles with no assistant text;
 *  - a still-pending provider-managed retry keeps the turn alive past this idle.
 */
export interface OpenCodeTurnActivityState {
  /** A prompt was sent and this `session.idle` is the first one since it. */
  awaitingResponse: boolean;
  /** Any assistant message / part was observed for this turn (own or child). */
  sawActivity: boolean;
  /** A context compaction was in flight as the turn ended. */
  wasCompacting: boolean;
  /** A provider-managed retry was still pending as the turn ended. */
  hadPendingProviderRetry: boolean;
}

/**
 * @description `true` when a delivered prompt produced no turn at all — the
 * caller should surface a notice instead of leaving the topic silently hung.
 */
export function checkIsWedgedTurn(state: OpenCodeTurnActivityState): boolean {
  return (
    state.awaitingResponse &&
    !state.sawActivity &&
    !state.wasCompacting &&
    !state.hadPendingProviderRetry
  );
}
