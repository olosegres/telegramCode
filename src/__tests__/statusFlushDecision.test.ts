/**
 * @description Unit tests for {@link getStatusFlushAction} — the pure decision
 * the status-coalescer flush loop in `bot.ts` consults per frame (B1 part 3).
 * Extracted so the dedup + cooldown-defer rule is testable without the
 * Telegraf / token-bucket machinery (same pattern as
 * `clearThreadOutputQueues.test.ts`).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getStatusFlushAction } from '../utils/statusFlushDecision';

test('send: new frame text while not rate-limited', () => {
  assert.equal(
    getStatusFlushAction({ nextText: 'Thinking… 2s', lastSentText: 'Thinking… 1s', isRateLimited: false }),
    'send',
  );
});

test('send: first ever frame (no previous sent text)', () => {
  assert.equal(
    getStatusFlushAction({ nextText: 'Thinking…', lastSentText: null, isRateLimited: false }),
    'send',
  );
});

test('skip: identical frame text avoids a "message is not modified" 400', () => {
  assert.equal(
    getStatusFlushAction({ nextText: 'Thinking… 5s', lastSentText: 'Thinking… 5s', isRateLimited: false }),
    'skip',
  );
});

test('skip: two frames differing ONLY by the leading liveness glyph (S2 — no edit/sec)', () => {
  // The liveness frame rotates ✻ ✽ ✶ ✢ every 1s tick; pre-fix the exact-string
  // compare treated each cosmetic tick as new → one editMessageText per second.
  assert.equal(
    getStatusFlushAction({ nextText: '✽ 🔧 Update', lastSentText: '✻ 🔧 Update', isRateLimited: false }),
    'skip',
  );
});

test('send: a REAL activity-text change still sends even though the glyph also rotated', () => {
  assert.equal(
    getStatusFlushAction({ nextText: '✽ 🔧 Read', lastSentText: '✻ 🔧 Update', isRateLimited: false }),
    'send',
  );
});

test('send: only the live elapsed m:ss tail advanced — the S1 un-freeze (survives glyph-strip)', () => {
  // The freeze bug: a static activity word + a rotating glyph dedups to a skip,
  // so the frame never re-sends. The elapsed tail is NOT stripped, so an
  // advancing counter (even with the same word + a rotated glyph) still sends.
  assert.equal(
    getStatusFlushAction({ nextText: '✽ 🔧 working… · 0:45', lastSentText: '✻ 🔧 working… · 0:42', isRateLimited: false }),
    'send',
  );
});

test('skip: same elapsed, only the glyph rotated — still no per-second edit', () => {
  // Within one 3s send-throttle window the elapsed (whole seconds) can repeat;
  // a glyph-only difference must still dedup to skip so we never flood.
  assert.equal(
    getStatusFlushAction({ nextText: '✽ 🔧 working… · 0:42', lastSentText: '✻ 🔧 working… · 0:42', isRateLimited: false }),
    'skip',
  );
});

test('send: first frame (no lastSentText) sends regardless of glyph stripping', () => {
  assert.equal(
    getStatusFlushAction({ nextText: '✻ 🔧 Update', lastSentText: null, isRateLimited: false }),
    'send',
  );
});

test('defer: any frame during a 429 cooldown is held, not sent', () => {
  assert.equal(
    getStatusFlushAction({ nextText: 'Thinking… 9s', lastSentText: 'Thinking… 8s', isRateLimited: true }),
    'defer',
  );
});

test('defer wins over skip: identical frame during cooldown still defers', () => {
  // Cooldown takes precedence so the loop exits leaving the newest pendingText
  // for the post-cooldown flush, instead of consuming it as a skip.
  assert.equal(
    getStatusFlushAction({ nextText: 'same', lastSentText: 'same', isRateLimited: true }),
    'defer',
  );
});
