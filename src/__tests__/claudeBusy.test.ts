/**
 * @description `interruptAndWaitIdle` waits for Claude to leave the busy state
 * before forwarding the next prompt — otherwise a prompt typed while a turn is
 * still running gets queued behind it (the "voice message arrives before the
 * interrupt, then the agent just waits" bug). `checkIsClaudeBusy` is the
 * predicate driving that wait: the TUI footer shows `esc to interrupt` exactly
 * while a turn is in flight, and a selector/permission prompt shows
 * `Esc to cancel` (which must read as idle, since we only wait out a running
 * turn — Escape still cancels the selector before this is called again).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkIsClaudeBusy, checkIsClaudeUninterruptible } from '../adapters/claudeCliAdapter';

test('busy: a turn in flight shows the interrupt hint', () => {
  const busyFooters = [
    '✻ Marinating… (1m 41s · ↓ 9.3k tokens · thinking more with xhigh effort)\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    '✶ Grooving… (4s · ↓ 184 tokens · thinking with xhigh effort)\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    '⏵⏵ bypass permissions on (shift+tab to cycle) · ESC to interrupt',
  ];
  for (const pane of busyFooters) {
    assert.equal(checkIsClaudeBusy(pane), true, `expected busy for: ${JSON.stringify(pane)}`);
  }
});

test('idle: no interrupt hint means the turn finished', () => {
  const idlePanes = [
    '❯ \n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    '✻ Baked for 6s\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    '',
  ];
  for (const pane of idlePanes) {
    assert.equal(checkIsClaudeBusy(pane), false, `expected idle for: ${JSON.stringify(pane)}`);
  }
});

test('selector on screen reads as idle (Esc to cancel, not esc to interrupt)', () => {
  const selectorPane =
    '  1. Option one\n  2. Option two\n  3. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel';
  assert.equal(checkIsClaudeBusy(selectorPane), false);
});

test('uninterruptible: a running sub-agent must NOT be Escaped (queue instead)', () => {
  // Real capture: a `◯` (U+25EF) task line + the `↓ to manage` footer hint.
  const subagentPane =
    '● Agent(List 100 primes)\n  ⎿  Initializing…\n✽ Orchestrating… (11s · ↓ 197 tokens)\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ↓ to manage\n  ● main                          ↑/↓ to select · Enter to view\n  ◯ general-purpose  List 100 primes with comments                7s';
  assert.equal(checkIsClaudeUninterruptible(subagentPane), true);
  // The footer hint alone is enough (the task line may scroll out of view).
  assert.equal(checkIsClaudeUninterruptible('· esc to interrupt · ↓ to manage'), true);
});

test('uninterruptible: compaction in progress must NOT be Escaped', () => {
  assert.equal(
    checkIsClaudeUninterruptible('✶ Compacting conversation… (57s · ↑ 3.1k tokens)'),
    true,
  );
  assert.equal(checkIsClaudeUninterruptible('✻ Compacting conversation… (1m 22s)'), true);
});

test('interruptible: plain thinking / tool turn is fair game for Escape', () => {
  const plainThinking =
    '✻ Marinating… (1m 41s · ↓ 9.3k tokens · thinking more with xhigh effort)\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt';
  assert.equal(checkIsClaudeUninterruptible(plainThinking), false);
  // `○` (U+25CB, the small spinner glyph) must NOT be mistaken for `◯` (U+25EF).
  assert.equal(checkIsClaudeUninterruptible('○ Thinking… (3s)'), false);
  assert.equal(checkIsClaudeUninterruptible('❯ launch another subagent later'), false);
});
