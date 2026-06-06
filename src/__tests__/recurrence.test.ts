/**
 * @description Unit coverage for `scheduler/recurrence.ts` (S1). Pure logic:
 * every case passes an explicit `nowMs`/`fromMs`, no real timers, no
 * `Date.now()`. Host-local time — fixed-instant assertions use UTC-anchored
 * cron shapes and `Date.UTC` so they hold regardless of the host timezone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateScheduleSpec,
  getNextRunAt,
  getCatchUpDecision,
  describeSchedule,
  minFireIntervalMs,
  catchUpToleranceMs,
} from '../scheduler/recurrence';
import type { ScheduleSpec } from '../scheduler/types';

/**
 * Anchor "now" at a fixed LOCAL wall-clock instant. croner interprets cron
 * fields in host-local time, so expected `getNextRunAt` instants are built with
 * the local-time `Date` constructor (not `Date.UTC`) to stay timezone-stable.
 */
const baseNow = new Date(2026, 5, 6, 10, 0, 0).getTime(); // local 2026-06-06 10:00

describe('validateScheduleSpec — cron', () => {
  it('accepts a well-formed daily cron', () => {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '30 21 * * *' };
    assert.equal(validateScheduleSpec(spec, baseNow), null);
  });

  it('rejects an unparseable cron string', () => {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: 'not a cron' };
    const error = validateScheduleSpec(spec, baseNow);
    assert.ok(error && /invalid cron/i.test(error), `expected parse error, got: ${error}`);
  });

  it('rejects a cron that fires every minute (below min interval)', () => {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '* * * * *' };
    const error = validateScheduleSpec(spec, baseNow);
    assert.ok(error && /too often/i.test(error), `expected min-interval rejection, got: ${error}`);
  });

  it('rejects a cron at every-3-minutes (still below 5 min)', () => {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '*/3 * * * *' };
    const error = validateScheduleSpec(spec, baseNow);
    assert.ok(error && /too often/i.test(error));
  });

  it('accepts a cron at exactly the 5-minute boundary', () => {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '*/5 * * * *' };
    assert.equal(validateScheduleSpec(spec, baseNow), null);
    // sanity: the boundary equals the configured minimum
    assert.equal(minFireIntervalMs, 5 * 60 * 1000);
  });

  it('rejects an N-times cron with non-positive remainingRuns', () => {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '0 9 * * *', remainingRuns: 0 };
    const error = validateScheduleSpec(spec, baseNow);
    assert.ok(error && /remainingRuns/i.test(error));
  });

  it('accepts a valid N-times cron', () => {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '0 9 * * *', remainingRuns: 3 };
    assert.equal(validateScheduleSpec(spec, baseNow), null);
  });
});

describe('validateScheduleSpec — once', () => {
  it('accepts a once spec in the future', () => {
    const spec: ScheduleSpec = { kind: 'once', onceAtIso: new Date(baseNow + 3600_000).toISOString() };
    assert.equal(validateScheduleSpec(spec, baseNow), null);
  });

  it('rejects a once spec in the past', () => {
    const spec: ScheduleSpec = { kind: 'once', onceAtIso: new Date(baseNow - 1000).toISOString() };
    const error = validateScheduleSpec(spec, baseNow);
    assert.ok(error && /past/i.test(error));
  });

  it('rejects a once spec exactly at now (not strictly future)', () => {
    const spec: ScheduleSpec = { kind: 'once', onceAtIso: new Date(baseNow).toISOString() };
    assert.ok(validateScheduleSpec(spec, baseNow));
  });

  it('rejects an unparseable once instant', () => {
    const spec: ScheduleSpec = { kind: 'once', onceAtIso: 'tomorrow-ish' };
    const error = validateScheduleSpec(spec, baseNow);
    assert.ok(error && /not a valid iso/i.test(error));
  });
});

describe('getNextRunAt', () => {
  it('returns the next daily occurrence strictly after fromMs', () => {
    // local 09:00 daily; from local 10:00 same day → next is 09:00 next day.
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '0 9 * * *' };
    const next = getNextRunAt(spec, baseNow);
    assert.equal(next, new Date(2026, 5, 7, 9, 0, 0).getTime());
  });

  it('returns the same-day occurrence when it is still ahead', () => {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '0 21 * * *' };
    const next = getNextRunAt(spec, baseNow);
    assert.equal(next, new Date(2026, 5, 6, 21, 0, 0).getTime());
  });

  it('is strictly-after: a fromMs exactly at the due instant skips to the next', () => {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '0 9 * * *' };
    const dueInstant = new Date(2026, 5, 7, 9, 0, 0).getTime();
    const next = getNextRunAt(spec, dueInstant);
    assert.equal(next, new Date(2026, 5, 8, 9, 0, 0).getTime());
  });

  it('every-2h cron advances to the next even hour at :15', () => {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: '15 */2 * * *' };
    // from local 10:00 → next :15 on an even hour is local 10:15.
    assert.equal(getNextRunAt(spec, baseNow), new Date(2026, 5, 6, 10, 15, 0).getTime());
  });

  it('once returns its instant when still ahead', () => {
    const at = baseNow + 7200_000;
    const spec: ScheduleSpec = { kind: 'once', onceAtIso: new Date(at).toISOString() };
    assert.equal(getNextRunAt(spec, baseNow), at);
  });

  it('once returns null when already past', () => {
    const spec: ScheduleSpec = { kind: 'once', onceAtIso: new Date(baseNow - 1000).toISOString() };
    assert.equal(getNextRunAt(spec, baseNow), null);
  });

  it('returns null for an unparseable cron', () => {
    const spec: ScheduleSpec = { kind: 'cron', cronExpr: 'garbage' };
    assert.equal(getNextRunAt(spec, baseNow), null);
  });
});

describe('getCatchUpDecision', () => {
  it('returns null when nextRunAt is null (exhausted)', () => {
    assert.equal(getCatchUpDecision({ nextRunAt: null, nowMs: baseNow }), null);
  });

  it('returns on-time when now is within tolerance of the due instant', () => {
    assert.equal(
      getCatchUpDecision({ nextRunAt: baseNow, nowMs: baseNow + catchUpToleranceMs }),
      'on-time',
    );
  });

  it('returns on-time when the timer fired a touch early', () => {
    assert.equal(getCatchUpDecision({ nextRunAt: baseNow, nowMs: baseNow - 5 }), 'on-time');
  });

  it('returns fire-missed when now is well past the due instant', () => {
    assert.equal(
      getCatchUpDecision({ nextRunAt: baseNow, nowMs: baseNow + catchUpToleranceMs + 1000 }),
      'fire-missed',
    );
  });
});

describe('describeSchedule', () => {
  it('describes a daily cron', () => {
    assert.equal(describeSchedule({ kind: 'cron', cronExpr: '30 21 * * *' }), 'daily at 21:30');
  });

  it('describes every-2h-at-minute', () => {
    assert.equal(describeSchedule({ kind: 'cron', cronExpr: '15 */2 * * *' }), 'every 2h at :15');
  });

  it('describes every-N-minutes', () => {
    assert.equal(describeSchedule({ kind: 'cron', cronExpr: '*/10 * * * *' }), 'every 10m');
  });

  it('falls back to the raw cron for non-divisor steps ("every 40m" would lie — real gaps alternate 40m/20m)', () => {
    assert.equal(describeSchedule({ kind: 'cron', cronExpr: '*/40 * * * *' }), 'cron */40 * * * *');
    assert.equal(describeSchedule({ kind: 'cron', cronExpr: '0 */7 * * *' }), 'cron 0 */7 * * *');
  });

  it('describes weekdays', () => {
    assert.equal(describeSchedule({ kind: 'cron', cronExpr: '0 9 * * 1-5' }), 'weekdays at 09:00');
  });

  it('describes a single weekday', () => {
    assert.equal(describeSchedule({ kind: 'cron', cronExpr: '0 9 * * 1' }), 'weekly on Monday at 09:00');
  });

  it('describes monthly on a day', () => {
    assert.equal(describeSchedule({ kind: 'cron', cronExpr: '0 8 15 * *' }), 'monthly on day 15 at 08:00');
  });

  it('describes a once spec as a local date-time', () => {
    // Build the ISO from local-time fields so the expected string is timezone-stable.
    const at = new Date(2026, 5, 7, 9, 0, 0);
    const text = describeSchedule({ kind: 'once', onceAtIso: at.toISOString() });
    assert.equal(text, 'once at 2026-06-07 09:00');
  });

  it('appends remaining-runs for an N-times cron', () => {
    const text = describeSchedule({ kind: 'cron', cronExpr: '30 21 * * *', remainingRuns: 4 });
    assert.equal(text, 'daily at 21:30 (4 runs left)');
  });

  it('falls back to the raw cron string for an unrecognised shape', () => {
    const text = describeSchedule({ kind: 'cron', cronExpr: '0 0 1 1 *' });
    assert.equal(text, 'cron 0 0 1 1 *');
  });
});
