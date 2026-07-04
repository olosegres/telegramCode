/**
 * @description Pure decision for whether the native "agent is typing" state
 * should keep showing for a topic (S3).
 *
 * The typing indicator persists while a topic has anything still to show OR its
 * agent is still working — and clears only when the topic is truly drained AND
 * idle. Extracted so the rule is unit-testable without the Telegraf / adapter
 * machinery; `bot.ts` supplies the two live readings (output-queue streaming and
 * adapter busy).
 */

export interface TypingActiveInput {
  /** Is real agent output mid-flight (queued / debouncing / sending / drafting)? */
  isOutputStreaming: boolean;
  /** Is the thread's adapter still working (its `checkIsBusy`)? */
  isAdapterBusy: boolean;
}

/**
 * @description Keep the typing indicator alive while output is streaming OR the
 * agent is busy; stop only when BOTH are false (drained + idle).
 */
export function checkShouldKeepTyping(input: TypingActiveInput): boolean {
  return input.isOutputStreaming || input.isAdapterBusy;
}
