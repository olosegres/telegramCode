import type { BindingData } from './state';
import type { SendPriority } from './rateLimiter';

/**
 * @description Snapshot of a thread's binding taken at two moments: when the
 * original interactive send was attempted, and again right before a B14
 * redelivery after the rate-limit cooldown.
 *
 * Two snapshots are needed because a `null` binding alone is ambiguous — a
 * fresh topic showing the bare `/bind` folder picker has no binding yet
 * (valid redelivery target), while a thread the user just `/unbind`ed (or a
 * deleted topic whose binding was wiped) also has `null` (must NOT receive
 * stale content). Comparing the two snapshots disambiguates them.
 */
export interface RedeliverBindingSnapshot {
  /** Whether a binding existed when the original send was attempted. */
  hadBindingAtSend: boolean;
  /** The binding as it stands now, just before redelivery (or `null`). */
  bindingNow: BindingData | null;
}

/**
 * @description Maximum number of post-cooldown redelivery passes for a
 * recoverable send (interactive reply or the agent's FINAL answer). The
 * original send is attempt 0; up to this many redeliveries follow. Strictly
 * bounded so a chat stuck in a sustained 429 storm can never reopen an
 * infinite requeue loop — the last attempt always terminates (the caller
 * posts the degraded notice instead of re-arming).
 */
export const maxRedeliveryAttempts = 4;

/**
 * @description Hard cap on a single redelivery's backoff, in ms. Each pass
 * waits the LIVE remaining cooldown + slack, but a pathological `retry_after`
 * must not park a redelivery for minutes — clamp it so the bounded schedule
 * still completes in a sane window.
 */
export const maxRedeliveryBackoffMs = 60_000;

/**
 * @description Decide whether a rate-limited send is RECOVERABLE (eligible for
 * the bounded post-cooldown redelivery) and still has a valid target.
 *
 * Pure so it can be unit-tested without booting Telegraf. Eligibility:
 *   - `interactive`-priority sends are recoverable (command replies / menus).
 *   - the agent's FINAL answer is recoverable via the explicit `isImportant`
 *     marker — even though it rides `output` priority, the last frame of a
 *     turn must land. Intermediate (non-final) `output` and `status` stay
 *     disposable and are NEVER redelivered.
 * Target validity (applies once eligible):
 *   - A topic marked `closed` is not a valid send target → skip.
 *   - A thread that HAD a binding at send time but has none now was torn
 *     down (`/unbind` or topic deletion) between the send and the cooldown
 *     → skip, so stale content never lands in a stopped/unbound thread.
 *   - Otherwise (live bound thread, or a still-unbound fresh folder picker)
 *     → redeliver.
 */
export function checkShouldRedeliver(
  priority: SendPriority,
  isImportant: boolean,
  snapshot: RedeliverBindingSnapshot,
): boolean {
  const isEligibleClass = priority === 'interactive' || isImportant;
  if (!isEligibleClass) return false;
  if (snapshot.bindingNow?.closed === true) return false;
  if (snapshot.hadBindingAtSend && snapshot.bindingNow === null) return false;
  return true;
}

/**
 * @description The bounded-redelivery decision for ONE failed (double-429)
 * send attempt. Pure, so the "N attempts then terminate" schedule is testable
 * without a clock.
 *
 * - `ineligible` — a disposable class (non-final `output` / `status`): drop,
 *   no redelivery, no notice.
 * - `exhausted` — eligible but the bounded attempt budget is spent: the caller
 *   posts the ONE user-visible degraded notice (D2) instead of re-arming.
 * - `schedule` — eligible and within budget: arm the next redelivery after
 *   `delayMs` (the live remaining cooldown + slack, clamped to
 *   {@link maxRedeliveryBackoffMs}).
 */
export type RedeliveryDecision =
  | { action: 'ineligible' }
  | { action: 'exhausted' }
  | { action: 'schedule'; delayMs: number };

export interface RedeliveryDecisionInput {
  priority: SendPriority;
  /** True only for the final-answer frame (makes an `output` send recoverable). */
  isImportant: boolean;
  /** 0-based count of redeliveries ALREADY made (the original send is not one). */
  attempt: number;
  /** Live remaining 429 cooldown for the chat, in ms. */
  remainingCooldownMs: number;
  /** Small slack added past the cooldown boundary so the retry fires after it lifts. */
  slackMs: number;
  /** Optional override for the attempt cap (tests); defaults to {@link maxRedeliveryAttempts}. */
  maxAttempts?: number;
  /** Optional override for the backoff cap (tests); defaults to {@link maxRedeliveryBackoffMs}. */
  maxBackoffMs?: number;
}

export function decideRedelivery(input: RedeliveryDecisionInput): RedeliveryDecision {
  const isEligibleClass = input.priority === 'interactive' || input.isImportant;
  if (!isEligibleClass) return { action: 'ineligible' };
  const maxAttempts = input.maxAttempts ?? maxRedeliveryAttempts;
  // `attempt` is how many redeliveries already happened; the next one is the
  // (attempt+1)-th. Allow it only while we have not reached the budget.
  if (input.attempt >= maxAttempts) return { action: 'exhausted' };
  const maxBackoffMs = input.maxBackoffMs ?? maxRedeliveryBackoffMs;
  const delayMs = Math.min(input.remainingCooldownMs + input.slackMs, maxBackoffMs);
  return { action: 'schedule', delayMs };
}

/**
 * @description Side-effecting dependencies the B14 redelivery orchestration
 * needs, injected so the orchestration can be unit-tested with a fake clock
 * and a stub send instead of real `setTimeout` / Telegram.
 */
export interface RedeliverDeps {
  /** Delay before this redelivery fires, in ms (from {@link decideRedelivery}). */
  delayMs: number;
  /** Schedule `fn` after `ms`. Real impl: `setTimeout`. */
  scheduleAfter: (fn: () => void, ms: number) => void;
  /** Read the binding as it stands now (just before redelivery). */
  getBindingNow: () => BindingData | null;
  /** Perform the actual redelivery send. */
  redeliver: () => void;
  /** Log a skip with a reason (no-op stub in tests is fine). */
  onSkip?: (reason: string) => void;
}

/**
 * @description Orchestrate ONE bounded redelivery pass: wait out the chat's
 * cooldown (the `delayMs` already computed by {@link decideRedelivery}),
 * re-check the thread is still a valid send target via
 * {@link checkShouldRedeliver}, then redeliver exactly once. No loop here —
 * the bounded re-arming is the caller's job (it bumps the attempt counter and
 * re-invokes only while {@link decideRedelivery} returns `schedule`).
 *
 * Returns nothing; the redelivery happens through {@link RedeliverDeps.redeliver}
 * on the scheduled tick.
 */
export function scheduleRedelivery(
  priority: SendPriority,
  isImportant: boolean,
  hadBindingAtSend: boolean,
  deps: RedeliverDeps,
): void {
  deps.scheduleAfter(() => {
    const shouldRedeliver = checkShouldRedeliver(priority, isImportant, {
      hadBindingAtSend,
      bindingNow: deps.getBindingNow(),
    });
    if (!shouldRedeliver) {
      deps.onSkip?.('thread no longer a valid target');
      return;
    }
    deps.redeliver();
  }, deps.delayMs);
}
