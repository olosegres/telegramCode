import { Cron } from 'croner';
import type { ScheduleSpec } from './types';

/**
 * @description Pure recurrence math for the scheduler (no I/O, no `Date.now()`
 * inside — every entry point takes the caller's `nowMs`/`fromMs` so the logic
 * is fully deterministic and testable). All computation is host-local time
 * (croner's default), matching the single-host bot.
 */

/**
 * Minimum allowed gap between two consecutive fires of a cron job (5 min). A
 * tighter cron would let one topic burn through the chat-wide 20-msg/min send
 * budget with announcements; `validateScheduleSpec` rejects anything below it.
 */
export const minFireIntervalMs = 5 * 60 * 1000;

/**
 * Tolerance for classifying a fire as "on time" vs a catch-up. A timer can fire
 * a few ms early/late and a boot replay computes `nowMs` slightly after the due
 * instant; within this window we treat the run as on-time, beyond it as a
 * missed run that needs the catch-up annotation.
 */
export const catchUpToleranceMs = 30 * 1000;

/** How many consecutive runs we sample to measure a cron's minimal gap. */
const minIntervalSampleCount = 5;

// Field periods used to verify a cron step-of-N divides evenly (truthful "every N" wording).
const minutesPerHour = 60;
const hoursPerDay = 24;

/**
 * @description Build a croner `Cron` for a spec. Returns `null` (instead of
 * throwing) when the cron string is unparseable, so callers can produce a
 * readable message. `once` specs build a `Cron` from the absolute Date.
 */
function createCron(spec: ScheduleSpec): Cron | null {
  try {
    if (spec.kind === 'once') {
      const at = new Date(spec.onceAtIso);
      if (Number.isNaN(at.getTime())) return null;
      return new Cron(at);
    }
    return new Cron(spec.cronExpr);
  } catch {
    return null;
  }
}

/**
 * @description Validate a schedule spec. Returns a readable error string, or
 * `null` when the spec is valid.
 *
 * Rejections:
 *  - cron string croner can't parse → the parse error message.
 *  - cron firing more often than {@link minFireIntervalMs} (e.g. `* * * * *`)
 *    → measured by sampling consecutive `nextRuns` and checking the min gap.
 *  - `once` whose instant is unparseable or already in the past.
 */
export function validateScheduleSpec(spec: ScheduleSpec, nowMs: number): string | null {
  if (spec.kind === 'once') {
    const at = new Date(spec.onceAtIso);
    if (Number.isNaN(at.getTime())) {
      return `Invalid one-shot time: "${spec.onceAtIso}" is not a valid ISO date`;
    }
    if (at.getTime() <= nowMs) {
      return 'One-shot time is in the past';
    }
    return null;
  }

  if (typeof spec.remainingRuns === 'number' && spec.remainingRuns <= 0) {
    return 'remainingRuns must be a positive number';
  }

  const cron = createCron(spec);
  if (!cron) {
    return `Invalid cron expression: "${spec.cronExpr}"`;
  }

  const from = new Date(nowMs);
  const runs = cron.nextRuns(minIntervalSampleCount, from);
  if (runs.length < 2) {
    // Fewer than two future runs means the cron is effectively a one-shot
    // (e.g. a fixed year) — no recurrence-frequency concern, accept it.
    return null;
  }
  let minGapMs = Number.POSITIVE_INFINITY;
  for (let i = 1; i < runs.length; i += 1) {
    const gap = runs[i].getTime() - runs[i - 1].getTime();
    if (gap < minGapMs) minGapMs = gap;
  }
  if (minGapMs < minFireIntervalMs) {
    const minMinutes = Math.round(minFireIntervalMs / 60000);
    return `Cron fires too often (min gap ${Math.round(minGapMs / 1000)}s); minimum allowed interval is ${minMinutes} min`;
  }
  return null;
}

/**
 * @description Epoch ms of the next occurrence strictly after `fromMs`, or
 * `null` when there is none (a `once` already past, or an exhausted cron).
 * croner's `nextRun(fromDate)` is strictly-after, so a fire exactly at the due
 * instant correctly advances to the following occurrence.
 */
export function getNextRunAt(spec: ScheduleSpec, fromMs: number): number | null {
  const cron = createCron(spec);
  if (!cron) return null;
  const next = cron.nextRun(new Date(fromMs));
  return next ? next.getTime() : null;
}

/**
 * @description Whether a fire is on time or a catch-up, used both by timer
 * fires and by boot replay. Returns `null` when there is nothing to fire.
 *
 *  - `nextRunAt === null`            → `null` (exhausted; nothing to do).
 *  - `nowMs - nextRunAt > tolerance` → `'fire-missed'` (a run was missed,
 *    e.g. the bot was down — fire once, annotated).
 *  - otherwise                       → `'on-time'`.
 */
export function getCatchUpDecision(args: {
  nextRunAt: number | null;
  nowMs: number;
}): 'fire-missed' | 'on-time' | null {
  const { nextRunAt, nowMs } = args;
  if (nextRunAt === null) return null;
  if (nowMs - nextRunAt > catchUpToleranceMs) return 'fire-missed';
  return 'on-time';
}

// ─── human description ───────────────────────────────────────────────

const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Pad a number to two digits (`9` → `"09"`) for HH:MM rendering. */
function padTwo(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * @description Try to render a recognised cron shape as short English text.
 * Returns `null` for shapes we don't special-case, so {@link describeSchedule}
 * can fall back to the raw cron string.
 *
 * Recognised shapes (5-field `min hour dom mon dow`):
 *  - daily at HH:MM            (`m h * * *`)
 *  - every Nh at :MM           (`m  *​/N * * *`)
 *  - every Nm                  (`*​/N * * * *`)
 *  - weekly on <weekday> HH:MM (`m h * * d`, single dow)
 *  - weekdays at HH:MM         (`m h * * 1-5`)
 *  - monthly on day D at HH:MM (`m h D * *`, single dom)
 */
function describeCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  // "every N" wording is only truthful when the step divides the field's
  // period — `*/40 * * * *` actually fires at :00 and :40 (gaps 40m/20m
  // alternating, the step resets each hour), so non-divisor steps fall back
  // to the raw cron string instead of lying in announcements.
  const everyMinuteMatch = minute.match(/^\*\/(\d+)$/);
  if (everyMinuteMatch && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const stepMinutes = Number(everyMinuteMatch[1]);
    return minutesPerHour % stepMinutes === 0 ? `every ${stepMinutes}m` : null;
  }

  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (everyHourMatch && /^\d+$/.test(minute) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const stepHours = Number(everyHourMatch[1]);
    return hoursPerDay % stepHours === 0 ? `every ${stepHours}h at :${padTwo(Number(minute))}` : null;
  }

  // The remaining shapes all need fixed minute + hour.
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  const atTime = `${padTwo(Number(hour))}:${padTwo(Number(minute))}`;

  if (month === '*') {
    if (dayOfMonth === '*') {
      if (dayOfWeek === '*') return `daily at ${atTime}`;
      if (dayOfWeek === '1-5') return `weekdays at ${atTime}`;
      if (/^[0-6]$/.test(dayOfWeek)) return `weekly on ${weekdayNames[Number(dayOfWeek)]} at ${atTime}`;
      return null;
    }
    if (dayOfWeek === '*' && /^\d+$/.test(dayOfMonth)) {
      return `monthly on day ${dayOfMonth} at ${atTime}`;
    }
  }
  return null;
}

/** ISO `2026-06-07T09:00:00.000Z` → `2026-06-07 09:00` (host-local). */
function describeOnce(onceAtIso: string): string {
  const at = new Date(onceAtIso);
  if (Number.isNaN(at.getTime())) return `once at ${onceAtIso}`;
  const datePart = `${at.getFullYear()}-${padTwo(at.getMonth() + 1)}-${padTwo(at.getDate())}`;
  const timePart = `${padTwo(at.getHours())}:${padTwo(at.getMinutes())}`;
  return `once at ${datePart} ${timePart}`;
}

/**
 * @description Short human description of a spec, English (it lands inside
 * announcements that are i18n'd around it). Unrecognised cron shapes fall back
 * to the raw cron string; N-times jobs append the remaining-runs count.
 */
export function describeSchedule(spec: ScheduleSpec): string {
  if (spec.kind === 'once') return describeOnce(spec.onceAtIso);
  const base = describeCron(spec.cronExpr) ?? `cron ${spec.cronExpr}`;
  if (typeof spec.remainingRuns === 'number') {
    return `${base} (${spec.remainingRuns} runs left)`;
  }
  return base;
}
