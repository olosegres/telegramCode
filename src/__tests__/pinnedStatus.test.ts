import { test } from 'node:test';
import * as assert from 'node:assert';
import { formatPinnedStatus } from '../pinnedStatus';
import type { BindingData } from '../state';

/**
 * @description Tests for the pure pinned-banner formatter. Plan §11 Этап 7
 * polish / §20.5. The bot's `updatePinnedStatus` impure wrapper isn't tested
 * here (would require Telegraf + state mocks); we cover the parts that
 * actually need a regression net — the text layout.
 */

const baseBinding: BindingData = {
  subdir: 'overview',
  createdAt: '2026-05-12T10:00:00Z',
};

test('formatPinnedStatus: bound but no agent yet', () => {
  const out = formatPinnedStatus({
    binding: baseBinding,
    agentLabel: null,
    model: null,
    isActive: false,
  });
  assert.strictEqual(out, '📁 overview · no agent · ⚪ idle');
});

test('formatPinnedStatus: claude idle', () => {
  const out = formatPinnedStatus({
    binding: baseBinding,
    agentLabel: 'Claude Code',
    model: null,
    isActive: false,
  });
  assert.strictEqual(out, '📁 overview · Claude Code · ⚪ idle');
});

test('formatPinnedStatus: claude running', () => {
  const out = formatPinnedStatus({
    binding: baseBinding,
    agentLabel: 'Claude Code',
    model: null,
    isActive: true,
  });
  assert.strictEqual(out, '📁 overview · Claude Code · 🟢 running');
});

test('formatPinnedStatus: opencode running with model', () => {
  const out = formatPinnedStatus({
    binding: baseBinding,
    agentLabel: 'OpenCode',
    model: 'anthropic/claude-3-5-sonnet',
    isActive: true,
  });
  assert.strictEqual(
    out,
    '📁 overview · OpenCode · anthropic/claude-3-5-sonnet · 🟢 running',
  );
});

test('formatPinnedStatus: closed topic suppresses running indicator', () => {
  // A closed topic can still hold a binding (plan D49), and the banner
  // should make the closure obvious — the user can't drive the agent
  // while it's closed, so a `🟢 running` row would just be confusing.
  const out = formatPinnedStatus({
    binding: { ...baseBinding, closed: true },
    agentLabel: 'Claude Code',
    model: 'sonnet',
    isActive: true, // even though the adapter still considers itself active
  });
  assert.strictEqual(out, '📁 overview · Claude Code · sonnet · 🔒 closed');
});

test('formatPinnedStatus: closed wins over idle too', () => {
  const out = formatPinnedStatus({
    binding: { ...baseBinding, closed: true },
    agentLabel: null,
    model: null,
    isActive: false,
  });
  assert.strictEqual(out, '📁 overview · no agent · 🔒 closed');
});

test('formatPinnedStatus: deep subdir paths are passed through verbatim', () => {
  // `validateSubdir` only allows simple subdirs today, but the banner is
  // dumb on purpose — whatever the binding row has is what the user sees.
  const out = formatPinnedStatus({
    binding: { ...baseBinding, subdir: 'overview/api/v2' },
    agentLabel: 'Claude Code',
    model: null,
    isActive: false,
  });
  assert.strictEqual(out, '📁 overview/api/v2 · Claude Code · ⚪ idle');
});

test('formatPinnedStatus: parts are separated by " · " consistently', () => {
  // Regression for any future refactor that tries to be clever with spacing
  // — the separator must stay exactly " · " (space, middle dot, space) so
  // Telegram clients render the banner the same way everywhere.
  const out = formatPinnedStatus({
    binding: baseBinding,
    agentLabel: 'X',
    model: 'Y',
    isActive: true,
  });
  const segments = out.split(' · ');
  assert.deepStrictEqual(segments, ['📁 overview', 'X', 'Y', '🟢 running']);
});
