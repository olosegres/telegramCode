/**
 * @description Loop-level backstop for the native "agent is typing…" indicator —
 * a bounded safety net that force-stops the typing loader when it is being kept
 * alive by a PROVABLY-INCONSISTENT state, never by a legitimately long turn.
 *
 * ROOT-CAUSE CONTEXT. The typing loop self-stops only when
 * `checkShouldKeepTyping` (`isOutputStreaming || isAdapterBusy`) goes false, and
 * has NO absolute bound. `jsonStreamBusyWatchdog` already covers a stuck
 * `isBusy` (a missed terminal `result`). This backstop covers the OTHER input:
 * `isOutputStreaming`, which reads `q.pendingOutput !== null || q.isProcessing ||
 * q.debounceTimer !== null`. A leaked non-null `debounceTimer` (the `isFinal`
 * fast-path in `queueOutput` cleared the timer but left the handle set) pins
 * `isOutputStreaming` true forever → the indicator hangs unbounded even though
 * the output queue is empty (live 2026-07-19, a json-stream group topic firing
 * `sendChatAction('typing')` every 4s for an hour+ after a clean turn end).
 *
 * WHY THIS CAN'T CUT A LEGIT LONG (SILENT) TURN. The backstop fires ONLY on a
 * contradiction that a working agent can never produce:
 *  - a genuinely-working agent keeps `isAdapterBusy` TRUE (a long silent
 *    Bash/Task tool, a sub-agent, an unanswered question all hold busy) → vetoed;
 *  - a live DM draft is a real stream (`isTransportStreaming`) → vetoed;
 *  - real text waiting to send (`hasPendingOutput`) or an in-flight send
 *    (`isProcessing`, which may legitimately be a slow API call) → vetoed.
 * Only when the adapter is idle, nothing is drafting, the queue is empty AND an
 * un-fired debounce handle lingers does it fire. A LIVE debounce is ALWAYS armed
 * WITH pending text (both `queueOutput` and `processOutputQueue` arm it only when
 * `pendingOutput` is set, nulling it the instant it fires), so "debounce armed +
 * empty queue" can only be the dead/stale handle from the leak — never a real
 * in-flight turn. The decision is therefore safe by construction: it truncates a
 * leak, never work.
 */

export interface TypingLoopBackstopInput {
  /** The adapter's genuine busy signal — a real long/silent tool turn holds it. */
  isAdapterBusy: boolean;
  /** The output transport (DM draft cursor) reports an active live stream. */
  isTransportStreaming: boolean;
  /** `q.pendingOutput !== null` — real agent text still waiting to be sent. */
  hasPendingOutput: boolean;
  /** `q.isProcessing` — a flush is actively awaiting a send (possibly slow). */
  isProcessing: boolean;
  /** `q.debounceTimer !== null` — a debounce timer HANDLE is present. */
  hasDebounceTimer: boolean;
}

/**
 * @description True iff the typing loop is being kept alive PURELY by a leaked
 * output-queue state — an armed debounce handle over an otherwise-empty queue
 * while the adapter is idle. This is a provable inconsistency (a live debounce
 * never coexists with an empty queue), so force-stopping here can only clear a
 * leak, never truncate a genuinely long turn. Every "genuinely in flight" signal
 * (adapter busy / DM draft / pending text / active send) VETOES the decision.
 */
export function checkIsTypingStuckByLeak(input: TypingLoopBackstopInput): boolean {
  // A genuinely working agent (long/silent tool, sub-agent, mid-turn, unanswered
  // question) keeps this true — never a leak, never cut.
  if (input.isAdapterBusy) return false;
  // A live DM draft cursor is a legitimate stream, not this leak.
  if (input.isTransportStreaming) return false;
  // Real text queued → genuinely streaming.
  if (input.hasPendingOutput) return false;
  // An in-flight send may just be a slow API call, not a leak — leave it be.
  if (input.isProcessing) return false;
  // Nothing is genuinely in flight, yet a debounce timer handle lingers. A live
  // debounce is ALWAYS paired with pending text, so a handle over an empty queue
  // can only be the dead/stale one left by the `isFinal` fast-path → a leak.
  return input.hasDebounceTimer;
}
