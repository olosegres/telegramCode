/**
 * @description Plan 2026-05-30-effort-command / S2 — catalog + helper unit
 * tests. These are the pure-function pieces of the /effort feature and the
 * only place that exercises the OpenCode-variant intersection logic without
 * spinning up an HTTP server.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  claudeEffortLevels,
  getClaudeAvailableLevels,
  checkIsClaudeEffortLevel,
  parseConfiguredLevels,
  intersectVariants,
  OPENCODE_EFFORT_COMMAND_ENV,
  OPENCODE_EFFORT_LEVELS_ENV,
} from '../effortLevels';

// ── Claude canonical catalog ────────────────────────────────────────────────

test('claudeEffortLevels — exactly the verified set, in display order', () => {
  // The exact order matters: it's the order the picker buttons appear in
  // and the order the unit-test below relies on. Locked against the
  // research baseline in the plan (verified `claude 2.1.158` 2026-05-30).
  assert.deepEqual(
    [...claudeEffortLevels],
    ['low', 'medium', 'high', 'xhigh', 'max', 'auto', 'ultracode'],
  );
});

test('getClaudeAvailableLevels returns a mutable copy of the canonical list', () => {
  const a = getClaudeAvailableLevels();
  const b = getClaudeAvailableLevels();
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'callers must not share the same array instance');
  // Mutation of a returned copy must not affect the next call.
  a.push('garbage');
  assert.deepEqual(getClaudeAvailableLevels(), [...claudeEffortLevels]);
});

test('checkIsClaudeEffortLevel — accept canonical, reject anything else', () => {
  for (const level of claudeEffortLevels) {
    assert.ok(checkIsClaudeEffortLevel(level), `expected ${level} to be valid`);
  }
  // Empty, uppercase, common typos, opencode-only labels (`none`/`minimal`).
  for (const bad of ['', 'HIGH', 'highest', 'none', 'minimal', 'xxhigh', ' high', 'high ']) {
    assert.ok(!checkIsClaudeEffortLevel(bad), `expected "${bad}" to be rejected`);
  }
});

// ── OpenCode env config helpers ─────────────────────────────────────────────

test('env constants — match the documented names', () => {
  // These names are part of the public configuration surface (CLAUDE.md
  // and README env table reference them); a typo here is a breaking
  // change and should be hard to land silently.
  assert.equal(OPENCODE_EFFORT_COMMAND_ENV, 'OPENCODE_EFFORT_COMMAND');
  assert.equal(OPENCODE_EFFORT_LEVELS_ENV, 'OPENCODE_EFFORT_LEVELS');
});

test('parseConfiguredLevels — empty / undefined / whitespace handling', () => {
  assert.deepEqual(parseConfiguredLevels(undefined), []);
  assert.deepEqual(parseConfiguredLevels(null), []);
  assert.deepEqual(parseConfiguredLevels(''), []);
  assert.deepEqual(parseConfiguredLevels('   '), []);
  // A single value with surrounding whitespace must round-trip clean.
  assert.deepEqual(parseConfiguredLevels(' high '), ['high']);
  // Mixed: empty entries from doubled commas / trailing commas are dropped.
  assert.deepEqual(
    parseConfiguredLevels('low, medium ,, high,'),
    ['low', 'medium', 'high'],
  );
});

test('intersectVariants — empty configured leaves variants unchanged but deduped', () => {
  assert.deepEqual(intersectVariants(['high', 'max'], []), ['high', 'max']);
  // Defensive: duplicated source variants are collapsed (a misconfigured
  // OpenCode `provider.models.<m>.variants` map shouldn't double the picker).
  assert.deepEqual(intersectVariants(['high', 'max', 'high'], []), ['high', 'max']);
});

test('intersectVariants — non-empty configured filters by allow-list, preserves provider order', () => {
  // Provider order is `high` then `max`; the allow-list lists them in the
  // opposite order. The picker must follow the provider's intent.
  assert.deepEqual(
    intersectVariants(['high', 'max'], ['max', 'high']),
    ['high', 'max'],
  );
});

test('intersectVariants — allow-list with no overlap yields an empty set', () => {
  // No overlap == "model exposes variants but none match the operator's
  // policy". The bot surfaces this as "not supported" rather than offering
  // an empty picker.
  assert.deepEqual(intersectVariants(['high', 'max'], ['low', 'medium']), []);
});

test('intersectVariants — model with zero variants is always empty', () => {
  // No variants at all == "this model has no effort concept". Both with
  // and without an allow-list, the result must be empty.
  assert.deepEqual(intersectVariants([], []), []);
  assert.deepEqual(intersectVariants([], ['high', 'max']), []);
});
