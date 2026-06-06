import { getNextRunAt } from './recurrence';
import type { ScheduleRecord } from './types';

/**
 * @name RebindResumeAction
 * @description What to do with one unbound-paused job when its thread is rebound
 * (plan S8 "rebind: resume paused-for-unbound jobs, nextRunAt recomputed from
 * now — no catch-up for deliberate pauses"):
 *  - `resume` — the spec still has a future occurrence: clear the pause, set
 *    `nextRunAt` to that occurrence, re-arm.
 *  - `remove` — the spec is exhausted (a one-shot whose instant already passed
 *    while unbound, or a finished cron): there is nothing left to fire, so the
 *    record is dropped rather than left as a permanently-paused husk. This is
 *    the honest semantic — a past one-shot cannot be resumed.
 */
export type RebindResumeAction =
  | { kind: 'resume'; nextRunAt: number }
  | { kind: 'remove' };

/**
 * @description Decide the rebind action for ONE paused job, recomputing its next
 * occurrence strictly from `nowMs` (deliberate pause ⇒ no catch-up replay of the
 * missed window). Pure: the caller injects `nowMs` and applies the persistence
 * (un-pause + upsert + arm, or remove + disarm) per the returned action.
 */
export function getRebindResumeAction(record: ScheduleRecord, nowMs: number): RebindResumeAction {
  const nextRunAt = getNextRunAt(record.spec, nowMs);
  if (nextRunAt === null) return { kind: 'remove' };
  return { kind: 'resume', nextRunAt };
}
