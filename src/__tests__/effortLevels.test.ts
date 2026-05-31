/**
 * @description Catalog unit tests for the Claude `/effort` level set — the
 * pure-function pieces of the /effort feature. OpenCode effort levels are
 * the live model's variants (no pure helper to unit-test); they're covered
 * by the adapter against `GET /config/providers`.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  claudeEffortLevels,
  getClaudeAvailableLevels,
  checkIsClaudeEffortLevel,
} from '../effortLevels';

// ── Claude canonical catalog ────────────────────────────────────────────────

test('claudeEffortLevels — exactly the verified set, in display order', () => {
  // The exact order matters: it's the order the picker buttons appear in
  // and the order the unit-test below relies on. Locked against the
  // research baseline (verified `claude 2.1.158`).
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
