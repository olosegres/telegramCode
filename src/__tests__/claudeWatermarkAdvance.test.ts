/**
 * @description `checkShouldAdvanceWatermark` — the pure decision behind Claude's
 * seen-watermark advance. S7: the poll loop advances the persisted watermark to
 * the transcript's current EOF on EVERY ready poll whose file GREW — busy OR
 * idle (not only at turn-end idle). This pure helper encodes that decision
 * (`isReady && eof > lastOffset`) so the truth table is testable without a live
 * tmux pane. A never-advanced session passes `lastOffset = -1` so its first
 * ready poll writes.
 *
 * Why each clause matters (post-S7):
 *   - busy is NO LONGER a gate — a live adapter relays the pane every poll, so
 *     growth mid-turn already means "shown up to here"; the old `!isBusy` gate
 *     stranded the watermark at the previous turn end and made a mid-turn
 *     restart re-count the whole in-flight turn as a false "missed N".
 *   - not-ready ⇒ never advance (a boot / lifecycle-gate frame is not a relay).
 *   - grew ⇒ advance; not-grown ⇒ skip (idle metadata churn must not write).
 *
 * Test case: N/A — TelegramCode has no Jira tracker. TODO: add a test-case key
 * if one is ever created.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkShouldAdvanceWatermark } from '../adapters/claudeCliAdapter';

describe('checkShouldAdvanceWatermark', () => {
  it('advances when ready and EOF grew past the last offset (idle poll)', () => {
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: false, isReady: true, eof: 2_603_805, lastOffset: 2_597_508 }),
      true,
    );
  });

  it('S7: advances on a BUSY poll whose EOF grew (busy no longer blocks)', () => {
    // Pre-S7 this returned false (the `!isBusy` gate). Now a mid-turn busy poll
    // that grew the transcript advances the watermark to the relayed tail.
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: true, isReady: true, eof: 2_603_805, lastOffset: 2_597_508 }),
      true,
    );
  });

  it('never advances when the input box is not ready (selector / boot box up)', () => {
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: false, isReady: false, eof: 2_603_805, lastOffset: 2_597_508 }),
      false,
    );
    // Not-ready wins even on a busy poll that grew.
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: true, isReady: false, eof: 2_603_805, lastOffset: 2_597_508 }),
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
    // Even busy: growth is still required.
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: true, isReady: true, eof: 2_603_805, lastOffset: 2_603_805 }),
      false,
    );
  });

  it('advances on the first ready poll of a never-advanced session (lastOffset -1)', () => {
    assert.equal(
      checkShouldAdvanceWatermark({ isBusy: false, isReady: true, eof: 0, lastOffset: -1 }),
      true,
      'a brand-new empty transcript (eof 0) still advances past the -1 sentinel',
    );
  });
});
