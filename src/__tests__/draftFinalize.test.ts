/**
 * @description Unit tests for the DM draft-cursor boundary/finalize decision
 * (`utils/draftFinalize`).
 *
 * Load-bearing per `rules/tests.md`: the boundary set is what makes the v2 draft
 * cursor correct (finalize on idle / overflow / isFinal / new-response). The idle
 * gate is driven on a SIMULATED TIMELINE with an injectable clock (mirroring
 * `draftPacer.test.ts`), and the per-feed decision is asserted across the full
 * action enum so an inverted order (e.g. overflow before new-response) fails.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getDraftFeedAction,
  checkShouldFinalizeOnIdle,
  FINALIZE_IDLE_MS,
} from '../utils/draftFinalize';

const CAP = 4096;

test('append: a continuation tail under the cap just grows the draft', () => {
  const action = getDraftFeedAction({
    isDraftActive: true,
    isContinuation: true,
    needsNewMessage: false,
    isFinal: false,
    prospectiveRenderedLength: 100,
    renderedCap: CAP,
  });
  assert.equal(action, 'append');
});

test('finalizeThenStart: a non-continuation output while a draft is active finalizes the previous', () => {
  const action = getDraftFeedAction({
    isDraftActive: true,
    isContinuation: false,
    needsNewMessage: false,
    isFinal: false,
    prospectiveRenderedLength: 50,
    renderedCap: CAP,
  });
  assert.equal(action, 'finalizeThenStart', 'a new response must finalize the previous draft first');
});

test('finalizeThenStart: a forced new-message break while active also finalizes the previous', () => {
  const action = getDraftFeedAction({
    isDraftActive: true,
    isContinuation: true, // continuation flag set, but…
    needsNewMessage: true, // …a forced break overrides it
    isFinal: false,
    prospectiveRenderedLength: 50,
    renderedCap: CAP,
  });
  assert.equal(action, 'finalizeThenStart');
});

test('no finalizeThenStart when no draft is active (the first output opens a fresh draft)', () => {
  const action = getDraftFeedAction({
    isDraftActive: false,
    isContinuation: false,
    needsNewMessage: false,
    isFinal: false,
    prospectiveRenderedLength: 50,
    renderedCap: CAP,
  });
  assert.equal(action, 'append', 'a first output with no active draft is a plain append (opens the draft)');
});

test('finalize: isFinal ends the turn (takes precedence over overflow)', () => {
  const action = getDraftFeedAction({
    isDraftActive: true,
    isContinuation: true,
    needsNewMessage: false,
    isFinal: true,
    prospectiveRenderedLength: CAP + 5000, // even over the cap…
    renderedCap: CAP,
  });
  assert.equal(action, 'finalize', 'the final frame finalizes without reopening a draft');
});

test('overflow: a continuation that renders past the cap spills', () => {
  const action = getDraftFeedAction({
    isDraftActive: true,
    isContinuation: true,
    needsNewMessage: false,
    isFinal: false,
    prospectiveRenderedLength: CAP + 1,
    renderedCap: CAP,
  });
  assert.equal(action, 'overflow');
});

test('overflow boundary is strict (== cap is still an append, > cap overflows)', () => {
  const base = {
    isDraftActive: true,
    isContinuation: true,
    needsNewMessage: false,
    isFinal: false,
    renderedCap: CAP,
  };
  assert.equal(getDraftFeedAction({ ...base, prospectiveRenderedLength: CAP }), 'append');
  assert.equal(getDraftFeedAction({ ...base, prospectiveRenderedLength: CAP + 1 }), 'overflow');
});

test('new-response ordering: a non-continuation OVER the cap still finalizes-then-starts (not overflow)', () => {
  // The prospective length is computed against the OLD accumulator, so across a
  // response boundary it is meaningless — new-response must win over overflow.
  const action = getDraftFeedAction({
    isDraftActive: true,
    isContinuation: false,
    needsNewMessage: false,
    isFinal: false,
    prospectiveRenderedLength: CAP + 9000,
    renderedCap: CAP,
  });
  assert.equal(action, 'finalizeThenStart');
});

test('checkShouldFinalizeOnIdle: false before the window, true at/after', () => {
  const lastFed = 1000;
  assert.equal(
    checkShouldFinalizeOnIdle(lastFed + FINALIZE_IDLE_MS - 1, lastFed, true, FINALIZE_IDLE_MS),
    false,
    'just before the idle window must not finalize',
  );
  assert.equal(
    checkShouldFinalizeOnIdle(lastFed + FINALIZE_IDLE_MS, lastFed, true, FINALIZE_IDLE_MS),
    true,
    'exactly at the idle window must finalize',
  );
  assert.equal(
    checkShouldFinalizeOnIdle(lastFed + FINALIZE_IDLE_MS + 10_000, lastFed, true, FINALIZE_IDLE_MS),
    true,
    'past the idle window must finalize',
  );
});

test('checkShouldFinalizeOnIdle: never fires with no active draft or nothing fed', () => {
  assert.equal(
    checkShouldFinalizeOnIdle(999_999, 1000, false, FINALIZE_IDLE_MS),
    false,
    'no active draft → nothing to finalize',
  );
  assert.equal(
    checkShouldFinalizeOnIdle(999_999, null, true, FINALIZE_IDLE_MS),
    false,
    'nothing fed yet → nothing to finalize',
  );
});

test('timeline: feeds re-arm the idle clock; only a real gap finalizes', () => {
  // Simulate the manager re-arming on each feed: lastFedAtMs advances to the
  // feed time. A finalize only fires once a full FINALIZE_IDLE_MS gap elapses
  // after the LAST feed — earlier ticks (within the window of a newer feed)
  // must not.
  const feeds = [0, 1000, 2000];
  const lastFed = feeds[feeds.length - 1];
  // A tick 3s after the last feed (< 4s) must NOT finalize.
  assert.equal(checkShouldFinalizeOnIdle(lastFed + 3000, lastFed, true, FINALIZE_IDLE_MS), false);
  // A tick 4s after the last feed finalizes.
  assert.equal(checkShouldFinalizeOnIdle(lastFed + FINALIZE_IDLE_MS, lastFed, true, FINALIZE_IDLE_MS), true);
});

test('FINALIZE_IDLE_MS is the locked ~4s window', () => {
  assert.equal(FINALIZE_IDLE_MS, 4000);
});
