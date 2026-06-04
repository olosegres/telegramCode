/**
 * @description B19 — the diag log flooded one "sse drop" line PER BOUND SESSION
 * per foreign event. On a busy multi-topic chat that is the per-delta firehose
 * the diag log explicitly forbids.
 *
 * Fix, in two parts:
 *   1. Single-owner delivery (getEventOwnerKey) makes the normal multiplex skip
 *      SILENT — a drop is now logged only when NO bound thread owns the event,
 *      so it can no longer fire once per bound thread.
 *   2. `checkShouldLogDrop` throttles repeats of the same (eventType,
 *      eventSessionId) to one line per window, so an orphan session's delta
 *      stream collapses to a single line.
 *
 * This file pins the throttle decision (2). The single-owner part (1) is pinned
 * in openCodeSessionRouting.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkShouldLogDrop } from '../openCodeSessionRouting';

const throttleMs = 60_000;
const maxEntries = 3;

test('logs the FIRST drop for a (type, session) key', () => {
  const throttle = new Map<string, number>();
  assert.equal(checkShouldLogDrop(throttle, 'message.part.delta', 'ses_x', 1000, throttleMs, maxEntries), true);
});

test('suppresses repeats of the same key within the window (orphan delta firehose)', () => {
  const throttle = new Map<string, number>();
  // First logs, the next 49 (all "now" within the window) are suppressed.
  assert.equal(checkShouldLogDrop(throttle, 'message.part.delta', 'ses_flood', 0, throttleMs, maxEntries), true);
  let logged = 1;
  for (let i = 1; i < 50; i++) {
    if (checkShouldLogDrop(throttle, 'message.part.delta', 'ses_flood', i * 100, throttleMs, maxEntries)) logged++;
  }
  assert.equal(logged, 1, '50 deltas of one orphan session collapse to a single drop line');
});

test('logs again once the window elapses', () => {
  const throttle = new Map<string, number>();
  assert.equal(checkShouldLogDrop(throttle, 'session.idle', 'ses_y', 0, throttleMs, maxEntries), true);
  assert.equal(checkShouldLogDrop(throttle, 'session.idle', 'ses_y', throttleMs - 1, throttleMs, maxEntries), false);
  assert.equal(checkShouldLogDrop(throttle, 'session.idle', 'ses_y', throttleMs, throttleMs, maxEntries), true);
});

test('different (type, session) keys are throttled independently', () => {
  const throttle = new Map<string, number>();
  assert.equal(checkShouldLogDrop(throttle, 'message.updated', 'ses_a', 0, throttleMs, maxEntries), true);
  assert.equal(checkShouldLogDrop(throttle, 'message.updated', 'ses_b', 0, throttleMs, maxEntries), true);
  assert.equal(checkShouldLogDrop(throttle, 'session.idle', 'ses_a', 0, throttleMs, maxEntries), true);
});

test('the throttle map stays bounded (oldest key evicted past the cap)', () => {
  const throttle = new Map<string, number>();
  checkShouldLogDrop(throttle, 't', 'ses_1', 0, throttleMs, maxEntries);
  checkShouldLogDrop(throttle, 't', 'ses_2', 0, throttleMs, maxEntries);
  checkShouldLogDrop(throttle, 't', 'ses_3', 0, throttleMs, maxEntries);
  checkShouldLogDrop(throttle, 't', 'ses_4', 0, throttleMs, maxEntries);
  assert.equal(throttle.size, maxEntries);
  assert.equal(throttle.has('t|ses_1'), false, 'oldest entry evicted');
  assert.equal(throttle.has('t|ses_4'), true);
});
