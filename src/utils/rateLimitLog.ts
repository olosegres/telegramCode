/**
 * @description Pure formatters for the always-on rate-limit instrumentation
 * (plan 2026-06-24-rate-limit-429-metrics). Kept pure + separate from
 * `rateLimiter.ts`'s module state so they're trivially unit-testable: given the
 * measured rate + queue context, return the exact log string.
 *
 * Both lines stay greppable in the bot-console log:
 *   - `[RateLimit] 429` — every 429 the bot receives, with rich context;
 *   - `[RateLimit] rate` — the periodic per-chat outbound-rate summary.
 */

import type { SendPriority } from '../rateLimiter';

/** Order the priority breakdown is rendered in (highest-first, stable). */
const priorityRenderOrder: readonly SendPriority[] = ['interactive', 'output', 'status'];

/**
 * @description Snapshot of the outbound channel at the instant a 429 was
 * received, gathered from the send-rate tracker (rate) and the chat's token
 * bucket (queue depth + priority mix of waiters).
 */
export interface RateLimit429Context {
  chatId: number;
  /** Telegram's `retry_after` for this 429, in seconds (already parsed). */
  retryAfterSec: number;
  /** Sends issued for this chat in the last 60s at the moment of the 429. */
  sentPerMin: number;
  /** Busiest short-burst count (sends in any 10s sub-window) in that minute. */
  peak10s: number;
  /** Sends currently parked on the bucket, by priority class. */
  waitersByPriority: Record<SendPriority, number>;
  /** Whether this was the SECOND consecutive 429 (after the single retry). */
  isAfterRetry: boolean;
}

/** Total waiters across all priority classes. */
function getTotalWaiters(waiters: Record<SendPriority, number>): number {
  return priorityRenderOrder.reduce((sum, p) => sum + (waiters[p] ?? 0), 0);
}

/** Render the priority breakdown as `interactive=N,output=M,status=K`. */
function formatPriorityBreakdown(waiters: Record<SendPriority, number>): string {
  return priorityRenderOrder.map((p) => `${p}=${waiters[p] ?? 0}`).join(',');
}

/**
 * @description Build the rich, greppable 429 log line. Example:
 *
 *   [RateLimit] 429 chat=-100123 retryAfter=5s sent/min=38 peak10s=12 queue=7 (interactive=1,output=5,status=1) after_retry=yes
 *
 * Every field is load-bearing for tuning the per-chat budget later: the
 * measured send-rate (how hard we were pushing), the peak burst (spikes the
 * average hides), and the queue depth + priority mix (how much was backed up,
 * and of what).
 */
export function formatRateLimit429Line(context: RateLimit429Context): string {
  const queueDepth = getTotalWaiters(context.waitersByPriority);
  return (
    `[RateLimit] 429 chat=${context.chatId} ` +
    `retryAfter=${context.retryAfterSec}s ` +
    `sent/min=${context.sentPerMin} ` +
    `peak10s=${context.peak10s} ` +
    `queue=${queueDepth} (${formatPriorityBreakdown(context.waitersByPriority)}) ` +
    `after_retry=${context.isAfterRetry ? 'yes' : 'no'}`
  );
}

/**
 * @description Build the periodic per-chat outbound-rate summary line. Example:
 *
 *   [RateLimit] rate chat=-100123 sent/min=22 peak10s=8
 *
 * Logged only for chats with recent activity so we can see how close normal
 * operation runs to the per-chat ceiling WITHOUT needing a 429 to occur.
 */
export function formatRateSummaryLine(chatId: number, sentPerMin: number, peak10s: number): string {
  return `[RateLimit] rate chat=${chatId} sent/min=${sentPerMin} peak10s=${peak10s}`;
}
