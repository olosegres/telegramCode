/**
 * @description S3 — `ClaudeCliAdapter.setModel` must refuse when no session is
 * live instead of silently no-op-ing `sendInput` and returning a false
 * "success". Claude has no model-pref persistence (model switch is a TUI
 * keystroke), so refusing is the correct no-session behavior — unlike OpenCode,
 * which persists. Reachable today via the ungated numeric-pick path.
 *
 * Drives the real adapter: `sendInput` is stubbed via bracket access so we can
 * assert it is / isn't typed into tmux; a session is injected for the active
 * case (mirrors the OpenCode session-injection tests).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// testSetup FIRST: points DATA_DIR at a temp dir + seeds an effort pref before
// the adapter resolves its prefs-file path at module load.
import {
  seededThreadKeyString,
} from './claudeSetModel.testSetup';
import { ClaudeCliAdapter } from '../adapters/claudeCliAdapter';
import { defaultEffortLevel } from '../effortLevels';
import { t } from '../i18n';
import { keyToString, keyFromString, type ThreadKey } from '../types';

function createAdapter(): { adapter: ClaudeCliAdapter; sent: string[] } {
  const adapter = new ClaudeCliAdapter();
  const sent: string[] = [];
  adapter['sendInput'] = (_key: ThreadKey, input: string) => { sent.push(input); };
  return { adapter, sent };
}

describe('Claude setModel session guard (S3)', () => {
  it('no active session → returns the notice, does NOT type into tmux', async () => {
    const key: ThreadKey = { chatId: -100555, threadId: 1 };
    const { adapter, sent } = createAdapter();

    const result = await adapter.setModel(key, 'opus');
    assert.equal(result, t('model.start_agent_first'), 'must return the start-agent-first notice');
    assert.deepEqual(sent, [], 'no keystrokes when there is no session (was: silent no-op + false success)');
  });

  it('active session with NO effort pref → sends "/model <id>" then the default "/effort xhigh"', async () => {
    // Thread absent from the seeded prefs file → getEffort returns null → the
    // bot re-applies its default effort for the newly picked model.
    const key: ThreadKey = { chatId: -100555, threadId: 2 };
    const { adapter, sent } = createAdapter();
    adapter['sessions'].set(keyToString(key), { isActive: true });

    const result = await adapter.setModel(key, 'sonnet');
    assert.equal(result, null, 'a live switch succeeds');
    assert.deepEqual(
      sent,
      ['/model sonnet', `/effort ${defaultEffortLevel}`],
      'a no-pref switch applies the default effort for the new model',
    );
  });

  it('active session WITH an explicit effort pref → sends only "/model <id>" (no default re-apply)', async () => {
    // Seeded thread (claudeSetModel.testSetup) → getEffort returns the explicit
    // level → the default is NOT re-applied; claude carries the pref across.
    const key: ThreadKey = keyFromString(seededThreadKeyString);
    const { adapter, sent } = createAdapter();
    adapter['sessions'].set(keyToString(key), { isActive: true });

    const result = await adapter.setModel(key, 'sonnet');
    assert.equal(result, null, 'a live switch succeeds');
    assert.deepEqual(
      sent,
      ['/model sonnet'],
      'an explicit pref must NOT be overwritten by the default on a model switch',
    );
  });
});
