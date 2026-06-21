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
  defaultEffortLevel,
  clampEffortToAvailable,
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

// ── Default level + clamp ───────────────────────────────────────────────────

test('defaultEffortLevel is xhigh', () => {
  assert.equal(defaultEffortLevel, 'xhigh');
});

test('clampEffortToAvailable — xhigh against full opus-4-8 set is kept', () => {
  assert.equal(
    clampEffortToAvailable('xhigh', ['low', 'medium', 'high', 'xhigh', 'max']),
    'xhigh',
  );
});

test('clampEffortToAvailable — no xhigh → highest below it (high), not max', () => {
  // sonnet/haiku-style sets that stop at high/max: xhigh isn't there, so the
  // closest level at-or-below xhigh wins. high (rank 3) ≤ xhigh, max (rank 5) >.
  assert.equal(clampEffortToAvailable('xhigh', ['high', 'max']), 'high');
});

test('clampEffortToAvailable — opus-4-5 style [low,medium,high] → high', () => {
  assert.equal(clampEffortToAvailable('xhigh', ['low', 'medium', 'high']), 'high');
});

test('clampEffortToAvailable — empty available → null (no effort concept)', () => {
  assert.equal(clampEffortToAvailable('xhigh', []), null);
});

test('clampEffortToAvailable — none-prefixed set still resolves to high', () => {
  assert.equal(clampEffortToAvailable('xhigh', ['none', 'low', 'medium', 'high']), 'high');
});

test('clampEffortToAvailable — only-max set → max (closest above when none below)', () => {
  // max (rank 5) is the only known variant and it is ABOVE xhigh, so it is
  // returned as the closest-above fallback.
  assert.equal(clampEffortToAvailable('xhigh', ['max']), 'max');
});

test('clampEffortToAvailable — only-unknown variants → null', () => {
  assert.equal(clampEffortToAvailable('xhigh', ['weird']), null);
});
