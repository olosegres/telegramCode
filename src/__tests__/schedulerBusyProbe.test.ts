/**
 * @description Coverage for the `AgentAdapter.checkIsBusy` per-backend pure
 * predicates added in S4 (the scheduler's wait-for-idle probe). These are the
 * sync, in-memory busy decisions each adapter's `checkIsBusy` method delegates
 * to, exported so they are testable without spawning a tmux pane / OpenCode
 * server. The underlying signals (`checkIsClaudeBusy` footer scrape,
 * `getOpenCodeInterruptAction`) have their own coverage — here we lock the
 * "session active AND mid-turn" gating those methods add.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsClaudeSessionBusy, cleanOutput } from '../adapters/claudeCliAdapter';
import { checkIsOpenCodeSessionBusy } from '../adapters/openCodeAdapter';

// ── Claude ──

const busyFooter =
  '✻ Marinating… (1m 41s · ↓ 9.3k tokens)\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt';
const idlePane = '❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';

test('claude: active session showing the interrupt footer is busy', () => {
  assert.equal(checkIsClaudeSessionBusy({ isActive: true, lastContent: busyFooter }), true);
});

test('claude: active session at an idle pane is NOT busy', () => {
  assert.equal(checkIsClaudeSessionBusy({ isActive: true, lastContent: idlePane }), false);
});

test('claude: an inactive session is never busy (even if the last capture showed a turn)', () => {
  assert.equal(checkIsClaudeSessionBusy({ isActive: false, lastContent: busyFooter }), false);
});

test('claude: the probe input must be CLEANED pane text — an SGR run inside the raw footer splits the marker (why lastContent, not lastRawCapture)', () => {
  // Raw `-e` captures can style the footer mid-word; cleanOutput strips the
  // escapes, so the predicate sees the contiguous marker again.
  const ansiSplitFooter =
    '✻ Marinating… (1m 41s)\n  ⏵⏵ bypass permissions on · \x1b[2mesc\x1b[0m\x1b[2m to interrupt\x1b[0m';
  assert.equal(checkIsClaudeSessionBusy({ isActive: true, lastContent: cleanOutput(ansiSplitFooter) }), true);
});

// ── OpenCode ──

test('opencode: own generation running → busy', () => {
  assert.equal(
    checkIsOpenCodeSessionBusy({ isBusy: true, isCompacting: false, busyChildCount: 0 }),
    true,
  );
});

test('opencode: idle session → not busy', () => {
  assert.equal(
    checkIsOpenCodeSessionBusy({ isBusy: false, isCompacting: false, busyChildCount: 0 }),
    false,
  );
});

test('opencode: a running sub-agent counts as busy (occupied with a turn)', () => {
  assert.equal(
    checkIsOpenCodeSessionBusy({ isBusy: false, isCompacting: false, busyChildCount: 1 }),
    true,
  );
});

test('opencode: context compaction counts as busy', () => {
  assert.equal(
    checkIsOpenCodeSessionBusy({ isBusy: false, isCompacting: true, busyChildCount: 0 }),
    true,
  );
});
