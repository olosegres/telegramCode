/**
 * @description Unit cover for the pure `/model`-set reply decision (S4/S6).
 * Every branch of the four-way decision must produce the right copy + ok flag,
 * since all four `bot.ts` model-set paths funnel through it.
 *
 * The deferred-success branch is the bug fix: a model picked with NO live
 * session is a SUCCESS ("saved for next start"), not the old hard error.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getModelSetReplyDecision } from '../utils/modelSetReplyDecision';

// Stub: echoes the key + the substituted {model} so the test asserts the
// deferred branch routed through i18n without loading translation resources.
const translateStub = (code: string, vars?: Record<string, string | number>): string =>
  `${code}:${vars?.model ?? ''}`;

test('unsupported adapter → not ok, names the label', () => {
  const out = getModelSetReplyDecision(
    { hasSetModel: false, setModelError: null, isActive: true, adapterLabel: 'Claude Code', displayLabel: 'x/y' },
    translateStub,
  );
  assert.equal(out.isOk, false);
  assert.equal(out.message, 'Model switching not supported for Claude Code');
});

test('setModel error → not ok, "Error: <err>" format preserved', () => {
  const out = getModelSetReplyDecision(
    { hasSetModel: true, setModelError: 'No active session. Start an agent first.', isActive: false, adapterLabel: 'Claude Code', displayLabel: 'x/y' },
    translateStub,
  );
  assert.equal(out.isOk, false);
  assert.equal(out.message, 'Error: No active session. Start an agent first.');
});

test('live success → ok, "Model set to: <label>"', () => {
  const out = getModelSetReplyDecision(
    { hasSetModel: true, setModelError: null, isActive: true, adapterLabel: 'OpenCode', displayLabel: 'anthropic/claude-opus-4-8' },
    translateStub,
  );
  assert.equal(out.isOk, true);
  assert.equal(out.message, 'Model set to: anthropic/claude-opus-4-8');
});

test('deferred success (no session) → ok, routes through model.saved_for_next_start', () => {
  const out = getModelSetReplyDecision(
    { hasSetModel: true, setModelError: null, isActive: false, adapterLabel: 'OpenCode', displayLabel: 'anthropic/claude-opus-4-8' },
    translateStub,
  );
  // Load-bearing: the pre-fix flow turned this case into a hard error.
  assert.equal(out.isOk, true);
  assert.equal(out.message, 'model.saved_for_next_start:anthropic/claude-opus-4-8');
});
