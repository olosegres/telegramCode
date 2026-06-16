/**
 * @description The capability gate behind one-tap start + the unified typing
 * loader: `getStartReadyMessage` is the pure decision extracted from
 * `startAgentSession`, deciding whether the bot posts a "ready" notice after a
 * session comes up.
 *
 * Load-bearing facts proven here (against the REAL adapter instances, so the
 * `selfGreetsOnStart` flag wiring itself is under test — not a stand-in):
 *   • a self-greeting agent (Claude) → returns `''`: NO `agent.ready` notice,
 *     because the TUI prints its own banner and the typing loader covers the gap.
 *   • OpenCode (HTTP, never self-greets) → returns the generic `agent.ready`
 *     text — without it the user would have no cue the session is up.
 *   • terminal (a bare shell, never self-greets) → returns the shell-specific
 *     `terminal.ready` text, NOT `agent.ready`.
 *   • the `subdir` / `args` interpolation rides through for the non-suppressed
 *     backends.
 *
 * Comparing against the real `t(...)` output (not a hardcoded string) keeps the
 * test locale-independent: it asserts the SAME key+vars the helper resolves.
 *
 * `./startReadyMessage.testSetup` is imported FIRST so `bot.ts`'s boot-time
 * `parseEnv()` finds a token + a valid `WORK_ROOT` before the module evaluates.
 */
import './startReadyMessage.testSetup';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStartReadyMessage } from '../bot';
import { ClaudeCliAdapter } from '../adapters/claudeCliAdapter';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { TerminalAdapter } from '../adapters/terminalAdapter';
import { t } from '../i18n';

const subdir = 'myProject';

describe('getStartReadyMessage — self-greeting gate', () => {
  it('Claude (self-greeting) → empty string, no ready notice', () => {
    const adapter = new ClaudeCliAdapter();
    assert.equal(adapter.selfGreetsOnStart, true, 'precondition: Claude self-greets');
    assert.equal(
      getStartReadyMessage(adapter, subdir),
      '',
      'a self-greeting agent must NOT get a bot ready notice (its own banner covers it)',
    );
    // Args must not resurrect a notice for a self-greeting agent.
    assert.equal(getStartReadyMessage(adapter, subdir, 'refactor src/bot.ts'), '');
  });

  it('OpenCode (no self-greet) → the generic agent.ready text', () => {
    const adapter = new OpenCodeAdapter();
    assert.notEqual(adapter.selfGreetsOnStart, true, 'precondition: OpenCode does NOT self-greet');
    assert.equal(
      getStartReadyMessage(adapter, subdir),
      t('agent.ready', { label: adapter.label, subdir, argsSuffix: '' }),
      'OpenCode must keep its ready notice — nothing else greets the user',
    );
  });

  it('terminal (no self-greet) → the shell-specific terminal.ready text', () => {
    const adapter = new TerminalAdapter();
    assert.notEqual(adapter.selfGreetsOnStart, true, 'precondition: terminal does NOT self-greet');
    const message = getStartReadyMessage(adapter, subdir);
    assert.equal(
      message,
      t('terminal.ready', { label: adapter.label, subdir, argsSuffix: '' }),
      'terminal must use its own ready copy',
    );
    assert.notEqual(
      message,
      t('agent.ready', { label: adapter.label, subdir, argsSuffix: '' }),
      'terminal must NOT fall back to the generic agent.ready',
    );
  });

  it('non-self-greeting backends interpolate subdir + args into the notice', () => {
    const adapter = new OpenCodeAdapter();
    const message = getStartReadyMessage(adapter, subdir, 'fix the bug');
    assert.equal(
      message,
      t('agent.ready', { label: adapter.label, subdir, argsSuffix: ' (fix the bug)' }),
    );
    assert.ok(message.includes(subdir), 'the bound subdir must appear in the ready notice');
    assert.ok(message.includes('fix the bug'), 'the start args must appear in the ready notice');
  });
});
