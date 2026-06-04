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
 * @description Decide whether a rate-limited interactive send may be
 * redelivered once after the cooldown (B14).
 *
 * Pure so it can be unit-tested without booting Telegraf. Rules:
 *   - Only `interactive`-priority sends are recoverable; `output`/`status`
 *     are disposable and never redelivered.
 *   - A topic marked `closed` is not a valid send target → skip.
 *   - A thread that HAD a binding at send time but has none now was torn
 *     down (`/unbind` or topic deletion) between the send and the cooldown
 *     → skip, so stale content never lands in a stopped/unbound thread.
 *   - Otherwise (live bound thread, or a still-unbound fresh folder picker)
 *     → redeliver.
 */
export function checkShouldRedeliverInteractive(
  priority: SendPriority,
  snapshot: RedeliverBindingSnapshot,
): boolean {
  if (priority !== 'interactive') return false;
  if (snapshot.bindingNow?.closed === true) return false;
  if (snapshot.hadBindingAtSend && snapshot.bindingNow === null) return false;
  return true;
}

/**
 * @description Side-effecting dependencies the B14 redelivery orchestration
 * needs, injected so the orchestration can be unit-tested with a fake clock
 * and a stub send instead of real `setTimeout` / Telegram.
 */
export interface RedeliverDeps {
  /** Remaining 429 cooldown for the chat in ms (0 if not limited). */
  getRemainingCooldownMs: () => number;
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
 * @description Orchestrate the single B14 redelivery: wait out the chat's
 * cooldown (plus a small slack), re-check the thread is still a valid send
 * target via {@link checkShouldRedeliverInteractive}, then redeliver exactly
 * once. No loop — the caller is responsible for ensuring the redelivered
 * send itself cannot re-schedule (it passes a one-shot flag through).
 *
 * Returns nothing; the redelivery happens through {@link RedeliverDeps.redeliver}
 * on the scheduled tick. Extracted (with injected deps) so the wait → recheck
 * → send-exactly-once behaviour is testable without Telegraf.
 */
export function scheduleRedelivery(
  priority: SendPriority,
  hadBindingAtSend: boolean,
  slackMs: number,
  deps: RedeliverDeps,
): void {
  const waitMs = deps.getRemainingCooldownMs() + slackMs;
  deps.scheduleAfter(() => {
    const shouldRedeliver = checkShouldRedeliverInteractive(priority, {
      hadBindingAtSend,
      bindingNow: deps.getBindingNow(),
    });
    if (!shouldRedeliver) {
      deps.onSkip?.('thread no longer a valid target');
      return;
    }
    deps.redeliver();
  }, waitMs);
}
