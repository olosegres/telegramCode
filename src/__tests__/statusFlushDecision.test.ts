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
