/**
 * @description S7 readiness predicate — `checkIsClaudePromptReady(paneText)`.
 *
 * This is the signal that decides WHEN the deferred `/effort` re-apply may type
 * into a freshly spawned Claude TUI. Getting it wrong reproduces the live bug
 * (2026-06-05): keystrokes sent while the banner is still painting interleave
 * with the paint and the command sits unsubmitted.
 *
 * Ready ⇔ the live input box `❯` is on screen AND no boot-time lifecycle gate
 * is still up (the "Press Enter to continue" / login gate, or the
 * bypass-permissions warning). The auto-lifecycle handlers dismiss those gates
 * over the following polls; until then the pane is NOT ready for a typed slash
 * command.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsClaudePromptReady } from '../adapters/claudeCliAdapter';

describe('checkIsClaudePromptReady (S7)', () => {
  it('false while the TUI is still painting its boot banner (no input box)', () => {
    assert.equal(
      checkIsClaudePromptReady('Claude Code v2.1.165\nLoading…'),
      false,
      'no ❯ input row yet ⇒ not ready (this is exactly the booting-paint window)',
    );
  });

  it('true once the empty input box is up and no gate is left', () => {
    assert.equal(checkIsClaudePromptReady('welcome\n\n❯ '), true);
  });

  it('true even when the input box already holds an unrelated draft', () => {
    // A non-empty box still means the TUI accepts keys; readiness is about the
    // box existing, not about it being empty.
    assert.equal(checkIsClaudePromptReady('❯ some draft text'), true);
  });

  it('false while the "Press Enter to continue" gate is up, even with an input row', () => {
    assert.equal(
      checkIsClaudePromptReady('Press Enter to continue\n❯ '),
      false,
      'a boot gate must be auto-dismissed before we type — not ready yet',
    );
  });

  it('false on the login-success gate', () => {
    assert.equal(checkIsClaudePromptReady('Login successful. Press Enter to continue\n❯ '), false);
  });

  it('false while the bypass-permissions warning is up (warning AND accept)', () => {
    const pane = 'WARNING: Bypass Permissions mode\nYes, I accept\n❯ ';
    assert.equal(checkIsClaudePromptReady(pane), false);
  });

  it('true when only the word "Bypass" appears without the accept prompt', () => {
    // The gate needs BOTH the warning and the "Yes, I accept" line; a stray
    // "Bypass" in normal output must not block readiness forever.
    assert.equal(checkIsClaudePromptReady('Some text mentioning Bypass nothing else\n❯ '), true);
  });
});
