/**
 * @description Pure rolling per-chat outbound send-rate tracker
 * (plan 2026-06-24-rate-limit-429-metrics, S1).
 *
 * The tracker records a timestamp per outbound send and answers:
 *  - sends in the last 60s (sustained rate/min), and
 *  - the PEAK count in any 10s sub-window (the busiest burst the per-minute
 *    average hides),
 * over a bounded rolling window, evicting aged-out timestamps.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`): drive the tracker with an
 * INJECTED clock and assert the rate/peak/active-chat queries against the
 * timestamps we fed in — including that old sends EVICT (the rate drops back to
 * 0 once the window passes, not "state returned to initial" vacuously), that the
 * peak reflects a real intra-minute burst distinct from the per-minute count,
 * and that distinct chats stay independent.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SendRateTracker, defaultPeakSubWindowMs } from '../utils/sendRateTracker';

/** A manual clock the test advances explicitly — no wall-clock dependency. */
function createClock(): { now: () => number; set: (ms: number) => void } {
  let current = 0;
  return { now: () => current, set: (ms) => { current = ms; } };
}

describe('SendRateTracker', () => {
  it('counts sends within the rolling 60s window', () => {
    const clock = createClock();
    const tracker = new SendRateTracker(clock.now);
    const chat = -100;

    // Three sends within the same second.
    tracker.recordSend(chat);
    tracker.recordSend(chat);
    tracker.recordSend(chat);

    assert.equal(tracker.getSendsPerMin(chat), 3, 'all three are inside the minute');
  });

  it('evicts sends once they age out of the 60s window (rate drops back to 0)', () => {
    const clock = createClock();
    const tracker = new SendRateTracker(clock.now);
    const chat = -101;

    clock.set(0);
    tracker.recordSend(chat);
    tracker.recordSend(chat);
    assert.equal(tracker.getSendsPerMin(chat), 2, 'two recorded at t=0');

    // 59s later: still inside the 60s window.
    clock.set(59_000);
    assert.equal(tracker.getSendsPerMin(chat), 2, 'still inside the window at 59s');

    // 61s later: both sends have aged out → rate is 0 (load-bearing: proves
    // eviction, not a vacuous "returned to initial").
    clock.set(61_000);
    assert.equal(tracker.getSendsPerMin(chat), 0, 'both aged out past 60s');

    // A fresh send at the new time counts on its own.
    tracker.recordSend(chat);
    assert.equal(tracker.getSendsPerMin(chat), 1, 'only the fresh send remains');
  });

  it('peak10s reflects the busiest 10s burst, distinct from the per-minute count', () => {
    const clock = createClock();
    const tracker = new SendRateTracker(clock.now);
    const chat = -102;

    // 5 sends bunched into a ~2s burst at the start of the minute…
    clock.set(0);
    for (let i = 0; i < 5; i += 1) {
      clock.set(i * 400); // 0,400,800,1200,1600 ms — all within one 10s window
      tracker.recordSend(chat);
    }
    // …then 2 more spread out late in the minute, >10s away from the burst.
    clock.set(30_000);
    tracker.recordSend(chat);
    clock.set(45_000);
    tracker.recordSend(chat);

    clock.set(50_000);
    // 7 total inside the minute…
    assert.equal(tracker.getSendsPerMin(chat), 7, 'all 7 inside the minute');
    // …but the busiest 10s window held only the 5-send opening burst.
    assert.equal(
      tracker.getPeakInSubWindow(chat, defaultPeakSubWindowMs),
      5,
      'peak 10s window is the opening burst of 5',
    );
  });

  it('peak10s caps at the sub-window size when sends are spread one per interval', () => {
    const clock = createClock();
    const tracker = new SendRateTracker(clock.now);
    const chat = -103;

    // One send every 4s for 40s → 10 sends in the minute, but any 10s window
    // holds at most 3 (t, t+4s, t+8s).
    for (let i = 0; i < 10; i += 1) {
      clock.set(i * 4_000);
      tracker.recordSend(chat);
    }
    clock.set(40_000);
    assert.equal(tracker.getSendsPerMin(chat), 10, '10 sends in the minute');
    assert.equal(tracker.getPeakInSubWindow(chat, 10_000), 3, 'at most 3 within any 10s window');
  });

  it('getActiveChats returns only chats with sends still in the window, and drops silent ones', () => {
    const clock = createClock();
    const tracker = new SendRateTracker(clock.now);

    clock.set(0);
    tracker.recordSend(-200);
    tracker.recordSend(-201);

    // -202 sent long ago and has since gone silent.
    clock.set(0);
    tracker.recordSend(-202);

    clock.set(61_000);
    // Now -200 and -201 sent fresh; -202 stays silent → must be pruned.
    tracker.recordSend(-200);
    tracker.recordSend(-201);

    const active = tracker.getActiveChats().sort((a, b) => a - b);
    assert.deepEqual(active, [-201, -200].sort((a, b) => a - b), 'only the two active chats');
    assert.ok(!active.includes(-202), 'silent chat dropped');
  });

  it('keeps distinct chats independent', () => {
    const clock = createClock();
    const tracker = new SendRateTracker(clock.now);

    tracker.recordSend(-300);
    tracker.recordSend(-300);
    tracker.recordSend(-301);

    assert.equal(tracker.getSendsPerMin(-300), 2);
    assert.equal(tracker.getSendsPerMin(-301), 1);
    assert.equal(tracker.getSendsPerMin(-999), 0, 'unknown chat is 0, never throws');
  });

  it('never throws on an unknown chat for any query', () => {
    const tracker = new SendRateTracker(() => 0);
    assert.equal(tracker.getSendsPerMin(-1), 0);
    assert.equal(tracker.getSendsInWindow(-1, 5_000), 0);
    assert.equal(tracker.getPeakInSubWindow(-1), 0);
    assert.deepEqual(tracker.getActiveChats(), []);
  });
});
