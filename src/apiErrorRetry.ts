/**
 * @description Pure decision layer for the auto-retry-after-API-error feature
 * (plan `agent/tasks/actual/2026-06-09-api-error-auto-retry.md`, S1). No I/O and
 * no `Date.now()` inside: every caller passes `now` so the module is fully
 * deterministic and unit-testable on a fixed clock.
 *
 * Two responsibilities:
 *  - {@link classifyAgentApiError} — read a terminal error string and decide
 *    whether (and how) it should be auto-retried. ORDER MATTERS (see the fn doc).
 *  - {@link getRetryPlan} — given a class + the current attempt, decide the next
 *    backoff delay or that we should give up.
 *
 * The same classifier serves BOTH backends: Claude surfaces the provider's
 * "API Error" line in its TUI pane; OpenCode surfaces the same provider text
 * through `session.error`.
 */

import type { AgentApiErrorClass } from './types';
import { maxTimeoutMs } from './scheduler/engine';

/** One minute in milliseconds — the unit the backoff schedules are expressed in. */
const msPerMinute = 60_000;
/** One hour in milliseconds. */
const msPerHour = 60 * msPerMinute;

/**
 * Transient backoff schedule (one entry per attempt): attempt 1 → 5m,
 * 2 → 10m, 3 → 20m. After the last entry the retry gives up.
 */
export const transientBackoffMinutes = [5, 10, 20] as const;
/** Max transient attempts before giving up (= `transientBackoffMinutes.length`). */
export const transientMaxAttempts = transientBackoffMinutes.length;

/**
 * Fixed delay for a usage-limit error whose text exposed no reset time (the
 * common case for Claude's "blocked" message): 60 minutes, re-armed on each
 * repeat until {@link usageLimitMaxAttempts}.
 */
export const usageLimitDefaultMs = 60 * msPerMinute;
/** Max usage-limit attempts before giving up (~6h with the default delay). */
export const usageLimitMaxAttempts = 6;
/**
 * Grace window after a retry fires: another API error within this window counts
 * as the SAME error episode (escalate to attempt+1, longer backoff); an error
 * later than this is a FRESH episode (reset to attempt 1). Decouples the
 * decision from session-end events — a recovered turn just leaves a stale record
 * that the next, much-later error resets to attempt 1.
 */
export const retryRecurrenceGraceMs = 2 * msPerMinute;
/**
 * Padding added to a parsed reset time so the retry fires just AFTER the window
 * actually rolls over, never a hair before it (which would re-error instantly).
 */
export const resetBufferMs = 60_000;

/** Matches reset phrasings like "resets in 2h", "in 45m", "in 90 min". */
const relativeResetRegex = /\bin\s+(\d+)\s*(h|hours?|m|min|minutes?)\b/i;
/** Matches absolute clock phrasings like "resets at 3pm", "at 15:00", "at 3:30 pm". */
const clockResetRegex = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
/** Matches an ISO-8601 timestamp anywhere in the text. */
const isoTimestampRegex = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/;

const hoursPerDay = 24;
const minutesPerHour = 60;

/**
 * @description Classify a backend error string into a retry class, or `null`
 * when it must NOT be auto-retried.
 *
 * ORDER IS LOAD-BEARING — branches are evaluated top to bottom and return on
 * first match:
 *  1. auth / non-retryable (login, bad credentials) → `null`. Must win: a wait
 *     never fixes these (they need a re-login or server restart).
 *  2. transient (rate-limited, overloaded, 429/503/529) → `{ kind: 'transient' }`.
 *     Tested BEFORE usage on purpose: the live transient string literally reads
 *     "...(not your usage limit)...", so a naive usage check would false-match it.
 *     Because transient returns here, the usage branch never sees that substring.
 *  3. usage / quota exhausted → `{ kind: 'usageLimit', resetAt? }`.
 * Anything else (normal prose, unrelated text) → `null`.
 *
 * @param now Current epoch ms — only consulted to resolve a relative/absolute
 *   reset time for the usage class; the transient/auth branches ignore it.
 */
export function classifyAgentApiError(text: string, now: number): AgentApiErrorClass | null {
  if (/please run \/login|not logged in|invalid authentication credentials/i.test(text)) {
    return null;
  }
  if (/rate.?limited?|temporarily limiting requests|too many requests|overloaded|\b(429|503|529)\b/i.test(text)) {
    return { kind: 'transient' };
  }
  if (/usage limit reached|credit balance (is )?too low|out of (credits|usage)|quota/i.test(text)) {
    return { kind: 'usageLimit', resetAt: parseResetAt(text, now) };
  }
  return null;
}

/**
 * @description Best-effort parse of a "reset time" out of a usage-limit message.
 * Never throws: any unparseable / absent time yields `undefined`, which the
 * caller treats as "use the fixed delay". Handles three shapes, in order:
 *  - relative: "resets in 2h" / "in 45m" → `now + duration`.
 *  - absolute clock: "resets at 3pm" / "at 15:00" → the NEXT occurrence of that
 *    clock time at or after `now` (today if still ahead, else tomorrow).
 *  - ISO timestamp anywhere in the text → `Date.parse`.
 *
 * @param now Current epoch ms, used to resolve relative durations and to pick
 *   the next occurrence of an absolute clock time.
 */
export function parseResetAt(text: string, now: number): number | undefined {
  const relativeMatch = relativeResetRegex.exec(text);
  if (relativeMatch) {
    const amount = Number.parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const isHours = unit.startsWith('h');
    return now + amount * (isHours ? msPerHour : msPerMinute);
  }

  const clockMatch = clockResetRegex.exec(text);
  if (clockMatch) {
    return resolveNextClockTime(clockMatch, now);
  }

  const isoMatch = isoTimestampRegex.exec(text);
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0]);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return undefined;
}

/**
 * Resolve an "at HH[:MM] [am|pm]" match to the next epoch ms at or after `now`
 * that lands on that wall-clock time (local zone). Returns `undefined` for an
 * out-of-range hour rather than guessing.
 */
function resolveNextClockTime(match: RegExpExecArray, now: number): number | undefined {
  const rawHour = Number.parseInt(match[1], 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();

  let hour = rawHour;
  if (meridiem === 'pm' && rawHour < 12) hour = rawHour + 12;
  else if (meridiem === 'am' && rawHour === 12) hour = 0;

  if (hour < 0 || hour >= hoursPerDay || minute < 0 || minute >= minutesPerHour) {
    return undefined;
  }

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  let candidateMs = candidate.getTime();
  if (candidateMs < now) {
    // Already past today — roll to the same clock time tomorrow.
    candidate.setDate(candidate.getDate() + 1);
    candidateMs = candidate.getTime();
  }
  return candidateMs;
}

export interface RetryPlanArgs {
  kind: AgentApiErrorClass['kind'];
  /** 1-based attempt number for the delay we are about to schedule. */
  attempt: number;
  /** Parsed reset time (usage class only); absent → the fixed default delay. */
  resetAt?: number;
  /** Current epoch ms (to size a reset-time-relative delay). */
  now: number;
}

export type RetryPlan = { delayMs: number } | { giveUp: true };

/**
 * @description Decide the next backoff for an attempt, or that the retry loop
 * should give up. Every returned `delayMs` is clamped to `[0, maxTimeoutMs]`
 * (the same `setTimeout` cap the scheduler engine uses) so a far-future reset
 * time never overflows the timer.
 *  - transient: {@link transientBackoffMinutes}[attempt-1]; giveUp once attempt
 *    exceeds {@link transientMaxAttempts}.
 *  - usageLimit: `resetAt` present → `resetAt - now + resetBufferMs`; else
 *    {@link usageLimitDefaultMs}; giveUp once attempt exceeds
 *    {@link usageLimitMaxAttempts}.
 */
export function getRetryPlan(args: RetryPlanArgs): RetryPlan {
  if (args.kind === 'transient') {
    if (args.attempt > transientMaxAttempts) return { giveUp: true };
    const minutes = transientBackoffMinutes[args.attempt - 1];
    return { delayMs: clampDelay(minutes * msPerMinute) };
  }

  if (args.attempt > usageLimitMaxAttempts) return { giveUp: true };
  const rawDelayMs =
    typeof args.resetAt === 'number' ? args.resetAt - args.now + resetBufferMs : usageLimitDefaultMs;
  return { delayMs: clampDelay(rawDelayMs) };
}

/** Clamp a delay into `[0, maxTimeoutMs]` (the Node `setTimeout` safe range). */
function clampDelay(delayMs: number): number {
  return Math.min(Math.max(0, delayMs), maxTimeoutMs);
}

/**
 * @description A read-only view of the bot's per-thread armed-retry record, fed
 * into {@link decideRetryAction}. The bot owns the live `Map`; this snapshot is
 * the only state the pure decision needs.
 */
export interface RetryEntrySnapshot {
  /** 1-based attempt of the currently / last armed retry. */
  attempt: number;
  /** Epoch ms when the last armed retry actually fired, or `null` if still pending. */
  firedAt: number | null;
  /** True while a retry timer is armed and has not fired yet. */
  pending: boolean;
}

/**
 * @description The action the bot must take in response to one `apiError`:
 *  - `ignore`  — a retry is already armed and waiting; dedup this duplicate
 *    error frame (Claude re-scrapes the same line; OpenCode can repeat
 *    `session.error`).
 *  - `arm`     — arm a timer for `attempt` after `delayMs` (firing at `fireAt`).
 *  - `giveUp`  — the retry cap was reached; `attempts` is how many were already
 *    made before giving up.
 */
export type RetryAction =
  | { action: 'ignore' }
  | { action: 'arm'; attempt: number; delayMs: number; fireAt: number }
  | { action: 'giveUp'; attempts: number };

export interface DecideRetryActionArgs {
  kind: AgentApiErrorClass['kind'];
  /** Parsed reset time (usage class only); absent → the fixed default delay. */
  resetAt?: number;
  /** Current epoch ms. */
  now: number;
  /** The thread's existing armed-retry snapshot, or `null` if none. */
  prev: RetryEntrySnapshot | null;
}

/**
 * @description Decide the bot's reaction to an incoming API error, combining the
 * episode/attempt bookkeeping with {@link getRetryPlan}. Pure — the caller
 * passes `now` and the `prev` snapshot, so the decision is deterministic.
 *
 * Rules (evaluated in order):
 *  1. `prev.pending` → `ignore` (a retry is already armed — dedup the episode;
 *     this is what stops Claude's repeated scrape frames AND any duplicate
 *     `session.error` from re-arming).
 *  2. same episode (a `prev` that fired within {@link retryRecurrenceGraceMs}) →
 *     escalate to `prev.attempt + 1`; otherwise a fresh episode → attempt 1.
 *  3. ask {@link getRetryPlan}: `giveUp` → `giveUp` with `attempts` already made
 *     (= attempt − 1); else `arm` at `now + delayMs`.
 */
export function decideRetryAction(args: DecideRetryActionArgs): RetryAction {
  const { kind, resetAt, now, prev } = args;
  if (prev?.pending) return { action: 'ignore' };

  const sameEpisode = !!prev && prev.firedAt != null && now - prev.firedAt <= retryRecurrenceGraceMs;
  const attempt = sameEpisode ? prev.attempt + 1 : 1;

  const plan = getRetryPlan({ kind, attempt, resetAt, now });
  if ('giveUp' in plan) return { action: 'giveUp', attempts: attempt - 1 };
  return { action: 'arm', attempt, delayMs: plan.delayMs, fireAt: now + plan.delayMs };
}
