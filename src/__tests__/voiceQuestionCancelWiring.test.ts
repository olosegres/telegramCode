/**
 * @description S4 wiring guard — a voice transcript must reach the SAME
 * active-prompt choke point as a text message, so a question pending on the
 * thread is cancelled (free-form) or answered (bare digit) identically for both
 * inputs.
 *
 * Why a structural test (and not a behavioural one): the delivery functions live
 * in the side-effecting `bot.ts` entrypoint and depend on Telegram + download +
 * transcription I/O, so they cannot be exercised in isolation without standing
 * up the whole bot. The cancel DECISION itself is pure and exhaustively covered
 * in `openCodeQuestionFlow.test.ts` (`getQuestionReplyRoute`), and the cancel
 * WIRING is proven live on the test topic for TEXT. This guard locks the one
 * remaining seam that a live run can't drive (the `send_voice` MCP tool can't
 * target a forum topic): that `processVoiceJob`'s final delivery goes through
 * `deliverActivePrompt`, the shared choke point — NOT back to the bare
 * `forwardPromptToAgent` it used before S4, which would silently re-open the
 * "voice queues behind a blocked question" bug this change fixes.
 *
 * No Jira test-case issue is known for this change; recording the gap here per
 * `tests.md` § "Jira test-case reference" instead of inventing an id.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const botSource = fs.readFileSync(
  path.join(__dirname, '..', 'bot.ts'),
  'utf8',
);

/** Isolate `processVoiceJob`'s body so the assertion can't be satisfied by an
 *  unrelated `deliverActivePrompt` call elsewhere in `bot.ts`. */
function getProcessVoiceJobBody(): string {
  const startIdx = botSource.indexOf('async function processVoiceJob');
  assert.notEqual(startIdx, -1, 'processVoiceJob must exist in bot.ts');
  // The next top-level `async function` / `function` declaration ends the body.
  const after = botSource.slice(startIdx + 1);
  const nextDeclMatch = after.search(/\n(?:async function|function) /);
  return after.slice(0, nextDeclMatch === -1 ? undefined : nextDeclMatch);
}

test('S4: processVoiceJob delivers the transcript via the shared deliverActivePrompt choke point', () => {
  const body = getProcessVoiceJobBody();
  assert.match(
    body,
    /await\s+deliverActivePrompt\(\s*key\s*,\s*adapter\s*,\s*transcript\s*\)/,
    'voice must route the transcript through deliverActivePrompt (the text+voice choke point)',
  );
});

test('S4: processVoiceJob no longer forwards the transcript with the bare forwardPromptToAgent', () => {
  const body = getProcessVoiceJobBody();
  assert.doesNotMatch(
    body,
    /forwardPromptToAgent\(\s*key\s*,\s*adapter\s*,\s*transcript\s*\)/,
    'a bare forwardPromptToAgent on the transcript would skip the question-cancel/wedge handling (the pre-S4 bug)',
  );
});

test('S2: the text handler routes a generic active prompt through the same deliverActivePrompt choke point', () => {
  // The text handler's generic active branch must delegate to deliverActivePrompt
  // too, so text + voice share one cancel/answer/forward implementation.
  assert.match(
    botSource,
    /await\s+deliverActivePrompt\(\s*key\s*,\s*adapter\s*,\s*text\s*\)/,
    'the text handler must delegate its active branch to deliverActivePrompt',
  );
});
