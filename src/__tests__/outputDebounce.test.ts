/**
 * @description Group-mode regression for the P3 DM live-draft migration.
 *
 * The #1 risk of P3 is an accidental group-mode regression: the new
 * native-draft streaming + raised debounce must apply ONLY in DM mode, leaving
 * group mode byte-for-byte. The draft branch in `handleAgentOutput` and the
 * debounce both gate on the SAME `checkIsDmMode()` predicate, which is the
 * boolean input to `getOutputDebounceMs` here.
 *
 * This proves the debounce half against the same constants `bot.ts` uses (no
 * Telegraf boot needed): group mode keeps the original 1000ms window and is NOT
 * given the DM value, while DM mode gets the longer 4000ms window. A regression
 * that wired the DM debounce into group mode — or the draft path behind the
 * wrong gate — would flip these.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getOutputDebounceMs,
  OUTPUT_DEBOUNCE_MS,
  OUTPUT_DEBOUNCE_MS_DM,
} from '../utils/outputDebounce';

test('group mode (isDmMode=false) keeps the original 1000ms debounce', () => {
  assert.equal(getOutputDebounceMs(false), 1000, 'group debounce must stay 1000ms');
  assert.equal(
    getOutputDebounceMs(false),
    OUTPUT_DEBOUNCE_MS,
    'group debounce must be exactly OUTPUT_DEBOUNCE_MS',
  );
  assert.notEqual(
    getOutputDebounceMs(false),
    OUTPUT_DEBOUNCE_MS_DM,
    'group mode must NOT use the DM debounce (the P3 regression guard)',
  );
});

test('DM mode (isDmMode=true) uses the longer 4000ms debounce', () => {
  assert.equal(getOutputDebounceMs(true), 4000, 'DM debounce must be 4000ms');
  assert.equal(
    getOutputDebounceMs(true),
    OUTPUT_DEBOUNCE_MS_DM,
    'DM debounce must be exactly OUTPUT_DEBOUNCE_MS_DM',
  );
});

test('the two surfaces resolve to different windows (the gate is load-bearing)', () => {
  // If both sides returned the same value the gate would be a no-op — a silent
  // P3 regression. The whole point is that DM is longer than group.
  assert.ok(
    getOutputDebounceMs(true) > getOutputDebounceMs(false),
    'DM debounce must be strictly longer than group',
  );
});

test('constants are the locked P3 values', () => {
  assert.equal(OUTPUT_DEBOUNCE_MS, 1000);
  assert.equal(OUTPUT_DEBOUNCE_MS_DM, 4000);
});
