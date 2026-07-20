/**
 * @description Pure idle-watchdog decision for the `claude-json-stream` adapter's
 * `isBusy` flag — the flag that (via `checkIsBusy` → `checkShouldKeepTyping`)
 * keeps the native Telegram "agent is typing…" indicator alive.
 *
 * ROOT-CAUSE CONTEXT. In `claudeJsonStreamAdapter` `isBusy` has exactly ONE
 * clear-point: a processed terminal `result` line (`handleTurnEnd`). Every other
 * event only ever SETS it (`sendInput`, a text/thinking delta, a `tool_use`, a
 * surfaced question). So if that single `result` is ever missed — an `interrupt`
 * the CLI aborts without a final `result`, a process that goes quiet after the
 * answer, a `result` shape a newer CLI stops emitting — `isBusy` sticks `true`
 * forever and the typing indicator hangs. Observed live: an otherwise-idle topic
 * firing `sendChatAction('typing')` every 4s for an hour+ after the agent was
 * already done. The typing loop self-stops only when `checkShouldKeepTyping`
 * (`isBusy || isOutputStreaming`) goes false and has NO absolute bound, so a
 * single stuck flag is unbounded.
 *
 * This is the bounded safety net: when the session is flagged busy but stdout has
 * been SILENT for {@link busyIdleWatchdogMs} AND nothing is genuinely in flight
 * (no outstanding tool, no active sub-agent, no pending user question, no
 * un-emitted answer batch), the turn has really ended — clear `isBusy`.
 *
 * SILENCE — not wall-clock since the turn started — is the signal, so a
 * legitimately long turn is NEVER cut short: a working agent is always doing one
 * of (a) streaming text/thinking deltas → stdout activity, (b) waiting on a tool
 * → `outstandingToolCount > 0`, (c) waiting on a sub-agent → `subagentActive`,
 * (d) waiting on the user → `hasPendingQuestion`. Each of those VETOES the clear.
 * The watchdog can therefore only fire once the work is provably done but the
 * terminal `result` never arrived.
 */

/**
 * @description How long stdout may be silent, with nothing in flight, before a
 * busy session is force-declared idle. Comfortably longer than the only silent
 * gap a working-yet-nothing-in-flight turn has (pre-first-token latency), far
 * shorter than the reported hour+ hang.
 */
export const busyIdleWatchdogMs = 120_000;

export interface BusyIdleWatchdogInput {
  /** Is the session currently flagged busy (drives the typing indicator)? */
  isBusy: boolean;
  /** ms since the last stdout byte was consumed for this session. */
  msSinceStdoutActivity: number;
  /** The silence threshold (injected so tests need no fake clock). */
  idleTimeoutMs: number;
  /** Tool calls started but whose `tool_result` hasn't returned (Bash/Read/Task/…). */
  outstandingToolCount: number;
  /** A sub-agent delegation is mid-flight. */
  subagentActive: boolean;
  /** A user question is awaiting an answer. */
  hasPendingQuestion: boolean;
  /** Answer text still sits un-emitted in the coalesce batch. */
  hasUnflushedAnswer: boolean;
}

/**
 * @description True iff a busy session should be force-cleared to idle: it is
 * busy, stdout has been silent past the threshold, and every "in flight" signal
 * is absent. Any single in-flight signal (tool / sub-agent / question / batched
 * answer) VETOES the clear so a legitimately mid-turn agent is never truncated.
 */
export function checkShouldClearBusyOnIdle(input: BusyIdleWatchdogInput): boolean {
  if (!input.isBusy) return false;
  if (input.msSinceStdoutActivity < input.idleTimeoutMs) return false;
  if (input.outstandingToolCount > 0) return false;
  if (input.subagentActive) return false;
  if (input.hasPendingQuestion) return false;
  if (input.hasUnflushedAnswer) return false;
  return true;
}
