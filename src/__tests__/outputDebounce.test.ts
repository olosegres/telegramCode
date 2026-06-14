/**
 * @description Regression for the output-debounce constant after the DM v2
 * draft-cursor migration.
 *
 * DM v2 removed the separate DM debounce: the persist/`queueOutput` path runs in
 * GROUP mode ONLY (DM streams via the native-draft cursor and finalizes at
 * boundaries), so there is a single window left — the original group cadence.
 * This proves the value against the same constant `bot.ts` uses (no Telegraf
 * boot needed): group mode keeps its 1000ms window byte-for-byte. A regression
 * that changed the group cadence — or re-introduced a DM-specific window into
 * this path — would flip this.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getOutputDebounceMs, OUTPUT_DEBOUNCE_MS } from '../utils/outputDebounce';

test('the output debounce is the group cadence (1000ms)', () => {
  assert.equal(getOutputDebounceMs(), 1000, 'debounce must stay 1000ms');
  assert.equal(
    getOutputDebounceMs(),
    OUTPUT_DEBOUNCE_MS,
    'debounce must be exactly OUTPUT_DEBOUNCE_MS',
  );
});

test('the constant is the locked group value', () => {
  assert.equal(OUTPUT_DEBOUNCE_MS, 1000);
});
