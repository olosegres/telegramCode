/**
 * @description Unit coverage for the boot-time readiness status decision layer
 * (plan 2026-07-12-startup-readiness-status). Proves each unmet combination maps
 * to the exact `unmetKeys`, that `isReady` is driven only by the REQUIRED items
 * (optional groq/owner never block it), the cadence truth table, and the full
 * message composition (numbering + missing-rights interpolation).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildReadinessReport,
  buildStartupStatusText,
  checkShouldSendStartupStatus,
  formatMissingRights,
  getMissingBotRights,
  type BotAdminRights,
  type ReadinessFacts,
} from '../utils/startupReadiness';

const allRights: BotAdminRights = { manageTopics: true, pin: true, delete: true };

/** A fully-configured, ready deployment — the baseline every case tweaks. */
function readyFacts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    groupPaired: true,
    botRights: allRights,
    hasBinding: true,
    availableAgents: ['claude', 'opencode'],
    hasGroq: true,
    ownerSet: true,
    usedGeneralFallback: false,
    ...overrides,
  };
}

// ── isReady ────────────────────────────────────────────────────────────────

test('all required items met → isReady, no unmet keys', () => {
  const report = buildReadinessReport(readyFacts());
  assert.equal(report.isReady, true);
  assert.deepEqual(report.unmetKeys, []);
  assert.deepEqual(report.missingRights, []);
});

test('a ready bot with GROQ missing stays ready (optional never blocks)', () => {
  const report = buildReadinessReport(readyFacts({ hasGroq: false }));
  // Ready → the ready message wins and no checklist renders, but the optional
  // key is still tracked in unmetKeys.
  assert.equal(report.isReady, true);
  assert.deepEqual(report.unmetKeys, ['optional_groq']);
});

test('a ready bot with owner unset + General fallback stays ready (optional never blocks)', () => {
  const report = buildReadinessReport(readyFacts({ ownerSet: false, usedGeneralFallback: true }));
  assert.equal(report.isReady, true);
  assert.deepEqual(report.unmetKeys, ['optional_owner']);
});

// ── individual required items ────────────────────────────────────────────────

test('no group paired → create_group unmet, grant_admin suppressed', () => {
  // Unpaired: botRights is null, but grant_admin must NOT render (you cannot
  // grant admin before the group exists) — create_group covers it.
  const report = buildReadinessReport(
    readyFacts({ groupPaired: false, botRights: null, hasBinding: false }),
  );
  assert.equal(report.isReady, false);
  assert.ok(report.unmetKeys.includes('create_group'));
  assert.ok(!report.unmetKeys.includes('grant_admin'));
});

test('paired but not admin (botRights null) → grant_admin unmet with all three rights missing', () => {
  const report = buildReadinessReport(readyFacts({ botRights: null }));
  assert.equal(report.isReady, false);
  assert.deepEqual(report.unmetKeys, ['grant_admin']);
  assert.deepEqual(report.missingRights, ['manageTopics', 'pin', 'delete']);
});

test('paired admin missing only pin → grant_admin unmet naming just pin', () => {
  const report = buildReadinessReport(
    readyFacts({ botRights: { manageTopics: true, pin: false, delete: true } }),
  );
  assert.equal(report.isReady, false);
  assert.deepEqual(report.unmetKeys, ['grant_admin']);
  assert.deepEqual(report.missingRights, ['pin']);
});

test('no binding → bind_topic unmet and not ready', () => {
  const report = buildReadinessReport(readyFacts({ hasBinding: false }));
  assert.equal(report.isReady, false);
  assert.deepEqual(report.unmetKeys, ['bind_topic']);
});

test('no agent installed → install_agent unmet and not ready', () => {
  const report = buildReadinessReport(readyFacts({ availableAgents: [] }));
  assert.equal(report.isReady, false);
  assert.deepEqual(report.unmetKeys, ['install_agent']);
});

test('one agent installed is enough for the agent axis', () => {
  const report = buildReadinessReport(readyFacts({ availableAgents: ['opencode'] }));
  assert.equal(report.isReady, true);
  assert.deepEqual(report.unmetKeys, []);
});

// ── fresh-install onboarding: everything unmet, fixed render order ────────────

test('fresh install → unmetKeys in the canonical render order (create → optionals)', () => {
  const report = buildReadinessReport({
    groupPaired: false,
    botRights: null,
    hasBinding: false,
    availableAgents: [],
    hasGroq: false,
    ownerSet: false,
    usedGeneralFallback: true,
  });
  assert.equal(report.isReady, false);
  assert.deepEqual(report.unmetKeys, [
    'create_group',
    'bind_topic',
    'install_agent',
    'optional_groq',
    'optional_owner',
  ]);
});

test('optional_owner requires BOTH owner unset AND General fallback', () => {
  // Owner set but fallback used (403) → no optional_owner (owner IS set).
  const setButFellBack = buildReadinessReport(
    readyFacts({ hasBinding: false, ownerSet: true, usedGeneralFallback: true }),
  );
  assert.ok(!setButFellBack.unmetKeys.includes('optional_owner'));
  // Owner unset but no fallback recorded → still no optional_owner.
  const unsetNoFallback = buildReadinessReport(
    readyFacts({ hasBinding: false, ownerSet: false, usedGeneralFallback: false }),
  );
  assert.ok(!unsetNoFallback.unmetKeys.includes('optional_owner'));
});

// ── missing-rights helpers ───────────────────────────────────────────────────

test('getMissingBotRights: null rights → all three missing', () => {
  assert.deepEqual(getMissingBotRights(null), ['manageTopics', 'pin', 'delete']);
});

test('getMissingBotRights: partial → only the false ones', () => {
  assert.deepEqual(
    getMissingBotRights({ manageTopics: false, pin: true, delete: false }),
    ['manageTopics', 'delete'],
  );
});

test('formatMissingRights uses Telegram permission names', () => {
  assert.equal(
    formatMissingRights(['manageTopics', 'pin', 'delete']),
    'Manage Topics, Pin Messages, Delete Messages',
  );
});

// ── cadence truth table ──────────────────────────────────────────────────────

test('cadence: cold start always sends (ready or not)', () => {
  assert.equal(checkShouldSendStartupStatus({ isHotReload: false, isReady: true }), true);
  assert.equal(checkShouldSendStartupStatus({ isHotReload: false, isReady: false }), true);
});

test('cadence: hot reload sends only when something is missing', () => {
  assert.equal(checkShouldSendStartupStatus({ isHotReload: true, isReady: true }), false);
  assert.equal(checkShouldSendStartupStatus({ isHotReload: true, isReady: false }), true);
});

// ── message composition (injected translate) ─────────────────────────────────

/** Fake translate that echoes the code and appends any opts for assertability. */
const echoTranslate = (code: string, opts?: Record<string, string>): string =>
  opts ? `${code}[${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',')}]` : code;

test('ready report renders only the ready line', () => {
  const report = buildReadinessReport(readyFacts());
  assert.equal(buildStartupStatusText(report, echoTranslate), 'startup.ready');
});

test('not-ready report renders header + renumbered unmet items', () => {
  const report = buildReadinessReport(
    readyFacts({
      groupPaired: false,
      botRights: null,
      hasBinding: false,
      availableAgents: [],
      hasGroq: false,
    }),
  );
  const text = buildStartupStatusText(report, echoTranslate);
  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines[0], 'startup.header_not_ready');
  // Items are renumbered 1..N regardless of their position in the canonical order.
  assert.deepEqual(lines.slice(1), [
    '1. startup.item.create_group',
    '2. startup.item.bind_topic',
    '3. startup.item.install_agent',
    '4. startup.item.optional_groq',
  ]);
});

test('grant_admin line interpolates the missing rights via {missing}', () => {
  const report = buildReadinessReport(
    readyFacts({ botRights: { manageTopics: false, pin: true, delete: false } }),
  );
  const text = buildStartupStatusText(report, echoTranslate);
  assert.ok(
    text.includes('1. startup.item.grant_admin[missing=Manage Topics, Delete Messages]'),
    `expected the grant_admin line with interpolated rights, got: "${text}"`,
  );
});
