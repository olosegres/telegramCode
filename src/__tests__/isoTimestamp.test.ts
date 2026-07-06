/**
 * @description Unit coverage for `formatIsoLocalOffset` (the `/timestamps`
 * prompt-injection formatter): local-offset ISO-8601, second precision, NEVER
 * the `Z` suffix. Node on POSIX re-reads `process.env.TZ` for new Date
 * operations, so the tests pin known zones (fixed-offset, negative-offset,
 * UTC) and restore the original TZ afterwards.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatIsoLocalOffset } from '../utils/isoTimestamp';

const isoLocalOffsetRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

let originalTz: string | undefined;

beforeEach(() => {
  originalTz = process.env.TZ;
});

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

test('formatIsoLocalOffset: fixed positive offset zone renders +04:00, not Z', () => {
  process.env.TZ = 'Asia/Dubai'; // +04:00, no DST
  // 2026-06-27T15:42:10Z == 19:42:10 +04:00
  const epochMs = Date.UTC(2026, 5, 27, 15, 42, 10);
  assert.equal(formatIsoLocalOffset(epochMs), '2026-06-27T19:42:10+04:00');
});

test('formatIsoLocalOffset: UTC renders an explicit +00:00 offset, never the Z suffix', () => {
  process.env.TZ = 'UTC';
  const epochMs = Date.UTC(2026, 0, 2, 3, 4, 5);
  assert.equal(formatIsoLocalOffset(epochMs), '2026-01-02T03:04:05+00:00');
});

test('formatIsoLocalOffset: negative offset zone renders -05:00 (winter New York)', () => {
  process.env.TZ = 'America/New_York'; // -05:00 in January (no DST)
  // 2026-01-15T14:30:00Z == 09:30:00 -05:00
  const epochMs = Date.UTC(2026, 0, 15, 14, 30, 0);
  assert.equal(formatIsoLocalOffset(epochMs), '2026-01-15T09:30:00-05:00');
});

test('formatIsoLocalOffset: half-hour offset zone pads minutes (+05:30)', () => {
  process.env.TZ = 'Asia/Kolkata'; // +05:30
  const epochMs = Date.UTC(2026, 2, 10, 12, 0, 0);
  assert.equal(formatIsoLocalOffset(epochMs), '2026-03-10T17:30:00+05:30');
});

test('formatIsoLocalOffset: output shape matches ISO-8601 and round-trips to the same instant', () => {
  // Load-bearing invariant regardless of host zone: the string parses back to
  // the SAME instant (second precision), proving the offset math is correct —
  // a wrong-sign or unpadded offset would shift or fail the parse.
  const nowSecondAligned = Math.floor(Date.now() / 1000) * 1000;
  const formatted = formatIsoLocalOffset(nowSecondAligned);
  assert.match(formatted, isoLocalOffsetRe);
  assert.equal(Date.parse(formatted), nowSecondAligned);
});
