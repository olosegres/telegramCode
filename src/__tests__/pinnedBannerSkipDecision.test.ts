/**
 * @description Unit tests for {@link getPinnedBannerSkipDecision} — the pure
 * decision `updatePinnedStatus` in `bot.ts` consults before editing a banner
 * (B8). Extracted so the in-memory-cache-then-persisted-fallback rule is
 * testable without the Telegraf / state machinery (same pattern as
 * `statusFlushDecision.test.ts`). The `seedAndSkip` branch is the load-bearing
 * one: it is what lets a restart's banner refresh wave skip identical-banner
 * edits when the in-memory cache is empty.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getPinnedBannerSkipDecision } from '../utils/pinnedBannerSkipDecision';

test('skip: in-memory cache already matches the computed banner', () => {
  assert.equal(
    getPinnedBannerSkipDecision({
      computedText: 'Claude · idle',
      cachedText: 'Claude · idle',
      persistedText: undefined,
    }),
    'skip',
  );
});

test('seedAndSkip: cache miss but persisted text matches (the restart B8 case)', () => {
  // In-memory cache is empty after a restart; the on-disk banner is already
  // current, so we seed the cache and skip the wasted "not modified" edit.
  assert.equal(
    getPinnedBannerSkipDecision({
      computedText: 'Claude · idle',
      cachedText: undefined,
      persistedText: 'Claude · idle',
    }),
    'seedAndSkip',
  );
});

test('send: computed text differs from both cache and persisted', () => {
  assert.equal(
    getPinnedBannerSkipDecision({
      computedText: 'Claude · running',
      cachedText: 'Claude · idle',
      persistedText: 'Claude · idle',
    }),
    'send',
  );
});

test('send: no prior text known at all (fresh banner)', () => {
  assert.equal(
    getPinnedBannerSkipDecision({
      computedText: 'Claude · idle',
      cachedText: undefined,
      persistedText: undefined,
    }),
    'send',
  );
});

test('send: persisted text was cleared (undefined) so a NEW banner is not suppressed', () => {
  // After the id is nulled (deleted-out-from-under-us / unbind), persistedText
  // is cleared. A stale text must never short-circuit the fresh banner's edit.
  assert.equal(
    getPinnedBannerSkipDecision({
      computedText: 'Claude · idle',
      cachedText: undefined,
      persistedText: undefined,
    }),
    'send',
  );
});

test('skip wins over seedAndSkip: in-memory cache is checked first', () => {
  // If both the cache and persisted text match, the cache hit returns 'skip'
  // (no seeding needed) — the hot path during a busy turn.
  assert.equal(
    getPinnedBannerSkipDecision({
      computedText: 'Claude · idle',
      cachedText: 'Claude · idle',
      persistedText: 'Claude · idle',
    }),
    'skip',
  );
});
