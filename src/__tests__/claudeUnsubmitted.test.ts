/**
 * @description B5 paste-race: a plain prompt typed into Claude's TUI can land
 * inside the paste-aggregation window so the trailing Enter is absorbed as a
 * newline and the prompt sits typed-but-unsubmitted in the input box.
 * `checkLooksUnsubmitted` is the post-Enter verification predicate that decides
 * whether to re-send Enter once: it reports unsubmitted ONLY when Claude is idle
 * AND the typed text still sits in the live input box (`❯ <text>`). A busy
 * footer (`esc to interrupt`) or an empty input box (`❯ `) both mean it
 * submitted — even if the prompt also echoes as a user-turn block in scrollback.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkLooksUnsubmitted } from '../adapters/claudeCliAdapter';

const typedPrompt = 'refactor the session queue to be fully async and ordered';

test('unsubmitted: idle pane with the typed text still in the input box', () => {
  const pane = `✻ Baked for 6s
❯ ${typedPrompt}
────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
  assert.equal(checkLooksUnsubmitted(pane, typedPrompt), true);
});

test('submitted: busy footer (esc to interrupt) means the turn started', () => {
  // After a real submit the prompt first echoes as a user-turn block, then
  // Claude goes busy — the `❯ <text>` echo must NOT count as unsubmitted.
  const pane = `❯ ${typedPrompt}
✻ Marinating… (4s · ↓ 184 tokens · thinking with xhigh effort)
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt`;
  assert.equal(checkLooksUnsubmitted(pane, typedPrompt), false);
});

test('submitted: empty input box (❯ ) means the input was consumed', () => {
  // Scrollback still shows the echoed user turn, but the LIVE input box (the
  // last `❯` line) is empty — Claude consumed the input.
  const pane = `❯ ${typedPrompt}
● Done.
❯
────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
  assert.equal(checkLooksUnsubmitted(pane, typedPrompt), false);
});

test('not our case: a selector/question is on screen (no input box)', () => {
  const selectorPane = `  1. Option one
  2. Option two
  3. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`;
  assert.equal(checkLooksUnsubmitted(selectorPane, typedPrompt), false);
});

test('not our case: empty pane or empty typed text', () => {
  assert.equal(checkLooksUnsubmitted('', typedPrompt), false);
  assert.equal(checkLooksUnsubmitted('❯ something', ''), false);
  assert.equal(checkLooksUnsubmitted('❯ something', '   '), false);
});

test('long prompt matches on its first wrapped line only', () => {
  const longPrompt =
    'please summarise the entire architecture of this telegram bot including ' +
    'the adapter boundary, the serial queue, and the polling pipeline in detail';
  // The input box only renders the first visual line of a long prompt.
  const pane = `❯ ${longPrompt.slice(0, 60)}
────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
  assert.equal(checkLooksUnsubmitted(pane, longPrompt), true);
});

test('different text in the input box is NOT a match', () => {
  const pane = `❯ a totally unrelated draft the user is now typing
────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
  assert.equal(checkLooksUnsubmitted(pane, typedPrompt), false);
});

test('short prompt: input box must start with the full trimmed text', () => {
  // Below CLAUDE_INPUT_MATCH_PREFIX_LEN we compare the whole trimmed text as a
  // prefix. The typed prompt still leading the input box → unsubmitted; an
  // unrelated draft that does NOT start with it → submitted (no match). The
  // `hibernate` case is the locked ambiguity tradeoff: err toward retry (a
  // duplicate Enter is a harmless no-op) rather than risk a missed submit.
  assert.equal(checkLooksUnsubmitted('❯ hi there friend', 'hi'), true);
  assert.equal(checkLooksUnsubmitted('❯ hibernate', 'hi'), true);
  assert.equal(checkLooksUnsubmitted('❯ nope', 'hi'), false);
});
