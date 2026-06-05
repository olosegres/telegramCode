import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getNextPollDelay,
  basePollIntervalMs,
  maxPollIntervalMs,
  backoffAfterUnchangedPolls,
} from '../utils/pollBackoff';

describe('getNextPollDelay', () => {
  it('stays at base delay while the unchanged streak is below the threshold', () => {
    let currentDelayMs = basePollIntervalMs;
    let unchangedStreak = 0;

    // Walk the first (threshold - 1) unchanged polls: each must keep base.
    for (let polls = 1; polls < backoffAfterUnchangedPolls; polls += 1) {
      const next = getNextPollDelay({ isChanged: false, currentDelayMs, unchangedStreak });
      assert.equal(next.delayMs, basePollIntervalMs);
      assert.equal(next.unchangedStreak, polls);
      currentDelayMs = next.delayMs;
      unchangedStreak = next.unchangedStreak;
    }
  });

  it('starts doubling once the unchanged streak reaches the threshold', () => {
    // Streak just below threshold; this poll pushes it to the threshold.
    const first = getNextPollDelay({
      isChanged: false,
      currentDelayMs: basePollIntervalMs,
      unchangedStreak: backoffAfterUnchangedPolls - 1,
    });
    assert.equal(first.unchangedStreak, backoffAfterUnchangedPolls);
    assert.equal(first.delayMs, basePollIntervalMs * 2);

    // Next unchanged poll doubles again from the new delay.
    const second = getNextPollDelay({
      isChanged: false,
      currentDelayMs: first.delayMs,
      unchangedStreak: first.unchangedStreak,
    });
    assert.equal(second.delayMs, basePollIntervalMs * 4);
  });

  it('caps the delay at the maximum and never exceeds it', () => {
    // Drive far past the cap: doubling from max stays clamped at max.
    const atCap = getNextPollDelay({
      isChanged: false,
      currentDelayMs: maxPollIntervalMs,
      unchangedStreak: backoffAfterUnchangedPolls + 50,
    });
    assert.equal(atCap.delayMs, maxPollIntervalMs);

    // A delay one doubling below the cap snaps to the cap, not above it.
    const belowCap = getNextPollDelay({
      isChanged: false,
      currentDelayMs: maxPollIntervalMs - 1,
      unchangedStreak: backoffAfterUnchangedPolls,
    });
    assert.ok(belowCap.delayMs <= maxPollIntervalMs);
    assert.equal(belowCap.delayMs, maxPollIntervalMs);
  });

  it('resets to base delay and zero streak on any change', () => {
    const reset = getNextPollDelay({
      isChanged: true,
      currentDelayMs: maxPollIntervalMs,
      unchangedStreak: backoffAfterUnchangedPolls + 5,
    });
    assert.equal(reset.delayMs, basePollIntervalMs);
    assert.equal(reset.unchangedStreak, 0);
  });
});
