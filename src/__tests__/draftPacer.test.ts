/**
 * @description Unit tests for the DM draft pacer (`utils/draftPacer`).
 *
 * Load-bearing per `rules/tests.md`: the pacer is a stateful cadence machine, so
 * the meaningful assertions drive a SIMULATED TIMELINE with an injectable clock
 * (mirroring the `BucketClock` pattern in `rateLimiter.test.ts`) and assert the
 * ACTION SEQUENCE — not a single call. A single-call test would pass vacuously
 * even if the interval / backoff gates were inverted.
 *
 * The harness mirrors exactly what the runtime does on a `send`: it advances
 * `lastSentText`/`lastSentAtMs`. On `skip`/`defer` those stay put, so the next
 * tick re-evaluates against the same baseline — proving the gates fire across
 * time, not just once.
 *
 * DM v2 removed the draft keepalive (a draft now either updates within the idle
 * window or is finalized to a real message at the boundary), so there is no
 * keepalive case here.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getDraftPaceAction,
  checkShouldStreamAsDraft,
  DRAFT_MIN_INTERVAL_MS,
  DRAFT_DEFAULT_BACKOFF_MS,
  type DraftPaceAction,
} from '../utils/draftPacer';

/**
 * Replays a list of `{ t, text }` feed events against the pacer with the given
 * 429 backoff window, threading `lastSentText`/`lastSentAtMs` exactly as the
 * runtime would on each `send`. Returns the action emitted at each event.
 */
function runTimeline(
  events: Array<{ t: number; text: string }>,
  backoffUntilMs = 0,
): DraftPaceAction[] {
  let lastSentText: string | null = null;
  let lastSentAtMs: number | null = null;
  const actions: DraftPaceAction[] = [];
  for (const ev of events) {
    const action = getDraftPaceAction({
      nextText: ev.text,
      lastSentText,
      nowMs: ev.t,
      lastSentAtMs,
      minIntervalMs: DRAFT_MIN_INTERVAL_MS,
      backoffUntilMs,
    });
    actions.push(action);
    if (action === 'send') {
      lastSentText = ev.text;
      lastSentAtMs = ev.t;
    }
  }
  return actions;
}

test('getDraftPaceAction: send on the first change', () => {
  const action = getDraftPaceAction({
    nextText: 'hello',
    lastSentText: null,
    nowMs: 0,
    lastSentAtMs: null,
    minIntervalMs: DRAFT_MIN_INTERVAL_MS,
    backoffUntilMs: 0,
  });
  assert.equal(action, 'send', 'the first non-empty change must send');
});

test('getDraftPaceAction: skip on identical text', () => {
  const action = getDraftPaceAction({
    nextText: 'same',
    lastSentText: 'same',
    nowMs: 5000,
    lastSentAtMs: 1000,
    minIntervalMs: DRAFT_MIN_INTERVAL_MS,
    backoffUntilMs: 0,
  });
  assert.equal(action, 'skip', 'an unchanged frame must not spend a draft call');
});

test('getDraftPaceAction: defer while within the min interval', () => {
  // 300ms after a send, with new text → too soon.
  const action = getDraftPaceAction({
    nextText: 'grown',
    lastSentText: 'grow',
    nowMs: 300,
    lastSentAtMs: 0,
    minIntervalMs: DRAFT_MIN_INTERVAL_MS,
    backoffUntilMs: 0,
  });
  assert.equal(action, 'defer', 'a change inside the min interval must defer');
});

test('getDraftPaceAction: defer while inside a draft-channel 429 cooldown (even on change)', () => {
  const action = getDraftPaceAction({
    nextText: 'new',
    lastSentText: 'old',
    nowMs: 1000,
    lastSentAtMs: 0,
    minIntervalMs: DRAFT_MIN_INTERVAL_MS,
    backoffUntilMs: 5000, // cooldown active until t=5000
  });
  assert.equal(action, 'defer', 'the draft 429 cooldown must win over a change');
});

test('timeline: send → defer(too soon) → send(interval elapsed) → skip(no change)', () => {
  // t=0   first change            → send  (baseline set)
  // t=300 grown, <700ms since send→ defer
  // t=800 grown more, ≥700ms      → send  (baseline advances)
  // t=1600 same as last sent      → skip
  const actions = runTimeline([
    { t: 0, text: 'a' },
    { t: 300, text: 'ab' },
    { t: 800, text: 'abc' },
    { t: 1600, text: 'abc' },
  ]);
  assert.deepEqual(actions, ['send', 'defer', 'send', 'skip']);
});

test('timeline: defer through a 429 window, send once it clears', () => {
  // With a cooldown until t=20000, every feed before it defers regardless of
  // change; the first feed at/after t=20000 with new text sends.
  const actions = runTimeline(
    [
      { t: 0, text: 'a' },
      { t: 5000, text: 'ab' },
      { t: 19999, text: 'abc' },
      { t: 20000, text: 'abcd' },
    ],
    /* backoffUntilMs */ 20000,
  );
  assert.deepEqual(actions, ['defer', 'defer', 'defer', 'send']);
});

test('constants are the locked draft-pacer values', () => {
  assert.equal(DRAFT_MIN_INTERVAL_MS, 700);
  assert.equal(DRAFT_DEFAULT_BACKOFF_MS, 20_000);
});

// ── checkShouldStreamAsDraft — the group-vs-DM draft gate ──
//
// Load-bearing group-mode regression (the #1 risk of the draft migration): the
// draft path must NEVER engage in group mode, and even in DM must skip the
// already-whole one-shot / sub-agent outputs. This is the single predicate
// `handleAgentOutput` branches on, so proving it here proves group mode produces
// ZERO draft calls regardless of the output meta.

test('checkShouldStreamAsDraft: group mode (isDmMode=false) never drafts, for ANY meta', () => {
  assert.equal(checkShouldStreamAsDraft(false), false, 'no meta → no draft in group mode');
  assert.equal(checkShouldStreamAsDraft(false, {}), false);
  assert.equal(checkShouldStreamAsDraft(false, { isComplete: true }), false);
  assert.equal(checkShouldStreamAsDraft(false, { isSubagent: true }), false);
  assert.equal(
    checkShouldStreamAsDraft(false, { isComplete: false, isSubagent: false }),
    false,
    'even an ordinary streaming tail must NOT draft in group mode (the regression guard)',
  );
});

test('checkShouldStreamAsDraft: DM mode drafts an ordinary streaming tail', () => {
  assert.equal(checkShouldStreamAsDraft(true), true, 'no meta → an ordinary DM tail drafts');
  assert.equal(checkShouldStreamAsDraft(true, {}), true);
  assert.equal(checkShouldStreamAsDraft(true, { isComplete: false, isSubagent: false }), true);
});

test('checkShouldStreamAsDraft: DM mode skips the draft for a complete one-shot or a sub-agent chunk', () => {
  // A complete one-shot (resume context) is whole at emit time — drafting it would
  // make the typing animation "draw" already-ready text; it posts directly.
  assert.equal(checkShouldStreamAsDraft(true, { isComplete: true }), false);
  // Sub-agent chunks are streamed outside the draft cursor.
  assert.equal(checkShouldStreamAsDraft(true, { isSubagent: true }), false);
});
