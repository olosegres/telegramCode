/**
 * @description Unit tests for the DM draft pacer (`utils/draftPacer`).
 *
 * Load-bearing per `rules/tests.md`: the pacer is a stateful cadence machine, so
 * the meaningful assertions drive a SIMULATED TIMELINE with an injectable clock
 * (mirroring the `BucketClock` pattern in `rateLimiter.test.ts`) and assert the
 * ACTION SEQUENCE — not a single call. A single-call test would pass vacuously
 * even if the interval / backoff gates were inverted.
 *
 * The harness mirrors exactly what the S3 runtime does on a `send`: it advances
 * `lastSentText`/`lastSentAtMs`. On `skip`/`defer` those stay put, so the next
 * tick re-evaluates against the same baseline — proving the gates fire across
 * time, not just once.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getDraftPaceAction,
  checkShouldKeepaliveDraft,
  DRAFT_MIN_INTERVAL_MS,
  DRAFT_KEEPALIVE_MS,
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

test('checkShouldKeepaliveDraft: false before keepaliveMs, true at/after', () => {
  const lastSentAt = 1000;
  assert.equal(
    checkShouldKeepaliveDraft(lastSentAt + DRAFT_KEEPALIVE_MS - 1, lastSentAt, DRAFT_KEEPALIVE_MS),
    false,
    'just before the keepalive window must not fire',
  );
  assert.equal(
    checkShouldKeepaliveDraft(lastSentAt + DRAFT_KEEPALIVE_MS, lastSentAt, DRAFT_KEEPALIVE_MS),
    true,
    'exactly at the keepalive window must fire',
  );
  assert.equal(
    checkShouldKeepaliveDraft(lastSentAt + DRAFT_KEEPALIVE_MS + 5000, lastSentAt, DRAFT_KEEPALIVE_MS),
    true,
    'past the keepalive window must fire',
  );
});

test('checkShouldKeepaliveDraft: never fires when nothing has been sent yet', () => {
  assert.equal(
    checkShouldKeepaliveDraft(999_999, null, DRAFT_KEEPALIVE_MS),
    false,
    'no draft sent → nothing to keep alive',
  );
});

test('timeline including a keepalive tick at t≈29000', () => {
  // Drive the full lifecycle the plan names: t=0 send, t=300 defer (too soon),
  // t=800 send, then a long silent gap — at t=29000 no new text, but the
  // keepalive must fire (≥25000 since the last send at t=800).
  const lastSentAtAfterT800 = 800;
  const actions = runTimeline([
    { t: 0, text: 'a' },
    { t: 300, text: 'ab' },
    { t: 800, text: 'abc' },
  ]);
  assert.deepEqual(actions, ['send', 'defer', 'send'], 'paced sends up to the silent gap');
  // The silent gap: same text, so the pacer itself would `skip`; the keepalive
  // path is what keeps the draft alive.
  assert.equal(
    checkShouldKeepaliveDraft(29000, lastSentAtAfterT800, DRAFT_KEEPALIVE_MS),
    true,
    'a >25s silent gap must trigger a keepalive re-send',
  );
});

test('constants are the locked P3 values', () => {
  assert.equal(DRAFT_MIN_INTERVAL_MS, 700);
  assert.equal(DRAFT_KEEPALIVE_MS, 25_000);
  assert.equal(DRAFT_DEFAULT_BACKOFF_MS, 20_000);
});
