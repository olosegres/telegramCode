/**
 * @description `checkShouldAdvanceWatermark` — the pure decision behind Claude's
 * S3 idle-poll seen-watermark advance. The poll loop advances the persisted
 * watermark to the transcript's current EOF on EVERY idle+ready poll (not just
 * the single busy→ready edge), but only when the file actually grew. This pure
 * helper encodes that decision (`!isBusy && isReady && eof > lastOffset`) so the
 * truth table is testable without a live tmux pane. A never-advanced session
 * passes `lastOffset = -1` so its first idle+ready poll writes.
 *
 * Why each clause matters:
 *   - busy ⇒ never advance (the turn is mid-flight; EOF may hold an unsent line).
 *   - not-ready ⇒ never advance (a selector / boot box up — not a settled idle).
 *   - grew ⇒ advance; not-grown ⇒ skip (idle metadata churn must not write).
 *
 * Test case: N/A — telegramCode has no Jira tracker. TODO: add a test-case key
 * if one is ever created.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkShouldAdvanceWatermark } from '../adapters/claudeCliAdapter';

describe('checkShouldAdvanceWatermark', () => {
  it('advances when idle, ready, and EOF grew past the last offset', () => {
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: false, isReady: true, eof: 2_603_805, lastOffset: 2_597_508 }),
      true,
    );
  });

  it('never advances while the turn is busy (even if EOF grew)', () => {
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: true, isReady: true, eof: 2_603_805, lastOffset: 2_597_508 }),
      false,
    );
  });

  it('never advances when the input box is not ready (selector / boot box up)', () => {
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: false, isReady: false, eof: 2_603_805, lastOffset: 2_597_508 }),
      false,
    );
  });

  it('does not advance when EOF did not grow (idle metadata churn → no write)', () => {
    // Equal EOF — already at the tail.
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: false, isReady: true, eof: 2_603_805, lastOffset: 2_603_805 }),
      false,
    );
    // Smaller EOF (file rewritten smaller) — monotonic, never rewinds.
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: false, isReady: true, eof: 2_000_000, lastOffset: 2_603_805 }),
      false,
    );
  });

  it('advances on the first idle+ready poll of a never-advanced session (lastOffset -1)', () => {
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: false, isReady: true, eof: 0, lastOffset: -1 }),
      true,
      'a brand-new empty transcript (eof 0) still advances past the -1 sentinel',
    );
  });
});
