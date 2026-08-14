/**
 * @description Wiring guard — the free-form question-cancel path posts EXACTLY
 * ONE cancellation notice.
 *
 * Live report (thread 15812, json-stream Claude): typing a free-form message
 * while a question was pending surfaced THREE messages about the same thing:
 *   1. the question bubble relabelled to "❌ Question cancelled: <header>"
 *      (an in-place edit — `agent.question_cancelled_msg_label`),
 *   2. a SEPARATE "⚠️ Previous question cancelled — running your new request."
 *      line (`agent.question_cancelled_for_prompt`),
 *   3. a bogus "Claude error: API error" from the adapter (fixed separately in
 *      `claudeJsonStreamAdapter` — the interrupt-aborted turn is now swallowed).
 *
 * This guard locks the fix for (2): `cancelPendingQuestionAndForward` must post
 * the standalone notice ONLY when there was no question bubble to relabel
 * (`didLabelQuestionMessage`). When the bubble WAS relabelled, that relabel is
 * the single notice — a second standalone line is the reported noise.
 *
 * Structural (not behavioural): the function lives in the side-effecting
 * `bot.ts` and depends on Telegram I/O, so — like `voiceQuestionCancelWiring` —
 * the seam is asserted against the source. The cancel DECISION itself is pure
 * and covered in `openCodeQuestionFlow.test.ts` (`getQuestionReplyRoute`).
 *
 * No Jira test-case issue exists for this repo; recording the gap per
 * `tests.md` instead of inventing an id.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');

/** Isolate `cancelPendingQuestionAndForward`'s body so the assertions can't be
 *  satisfied by an unrelated call elsewhere in `bot.ts`. */
function getCancelFunctionBody(): string {
  const startIdx = botSource.indexOf('async function cancelPendingQuestionAndForward');
  assert.notEqual(startIdx, -1, 'cancelPendingQuestionAndForward must exist in bot.ts');
  const after = botSource.slice(startIdx + 1);
  const nextDeclMatch = after.search(/\n(?:async function|function) /);
  return after.slice(0, nextDeclMatch === -1 ? undefined : nextDeclMatch);
}

test('the standalone cancel notice is gated behind the no-bubble case (not unconditional)', () => {
  const body = getCancelFunctionBody();

  // The decision variable must exist and be derived from the bubble presence.
  assert.match(
    body,
    /const\s+didLabelQuestionMessage\s*=\s*cancelledMessageId\s*!==\s*null\s*&&\s*cancelledQuestion\s*!==\s*undefined/,
    'didLabelQuestionMessage must reflect whether a question bubble was relabelled',
  );

  // The standalone `question_cancelled_for_prompt` notice must sit INSIDE an
  // `if (!didLabelQuestionMessage)` guard — never fired alongside the relabel.
  assert.match(
    body,
    /if\s*\(\s*!didLabelQuestionMessage\s*\)\s*\{[\s\S]*?question_cancelled_for_prompt/,
    'the standalone notice must only fire when no question bubble was relabelled',
  );
});

test('the cancel path never posts the standalone notice unconditionally', () => {
  const body = getCancelFunctionBody();
  // There must be no `question_cancelled_for_prompt` reply that is NOT preceded
  // by the guard within the same function — i.e. exactly one gated occurrence.
  const occurrences = body.match(/question_cancelled_for_prompt/g) ?? [];
  assert.equal(
    occurrences.length,
    1,
    'exactly one (guarded) standalone-notice reference belongs in the cancel function',
  );
});
