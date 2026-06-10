/**
 * @description Pure loop-guard for keeping a pending question at the bottom of
 * its topic (plan `2026-06-09-question-ux.md`, S3). The debounce timer + the
 * delete/re-send I/O live in `bot.ts`; this proves the decision that gates them:
 * re-post only when a question is pending AND the question was NOT the last
 * thing sent (otherwise a re-post would fire in reaction to its own send → loop)
 * AND no question post is in flight (otherwise the re-post races the post over
 * `messageId` and deletes the wrong message — live race 2026-06-10).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkShouldRepostPendingQuestion } from '../pendingQuestionRepost';

test('S3: other output landed below a pending question → re-post', () => {
  assert.equal(
    checkShouldRepostPendingQuestion({
      isQuestionPending: true,
      wasLastSendTheQuestion: false,
      isQuestionPostInFlight: false,
    }),
    true,
  );
});

test('S3: the question itself was the last send → do NOT re-post (loop guard)', () => {
  assert.equal(
    checkShouldRepostPendingQuestion({
      isQuestionPending: true,
      wasLastSendTheQuestion: true,
      isQuestionPostInFlight: false,
    }),
    false,
  );
});

test('S3: no question pending → never re-post, regardless of last send', () => {
  assert.equal(
    checkShouldRepostPendingQuestion({
      isQuestionPending: false,
      wasLastSendTheQuestion: false,
      isQuestionPostInFlight: false,
    }),
    false,
  );
  assert.equal(
    checkShouldRepostPendingQuestion({
      isQuestionPending: false,
      wasLastSendTheQuestion: true,
      isQuestionPostInFlight: false,
    }),
    false,
  );
});

test('S3 race guard: a question post in flight → do NOT re-post (it owns messageId)', () => {
  // Load-bearing for the live 2026-06-10 race: an armed re-post firing while
  // the answer flow's post-next-question send was still in flight read the
  // PREVIOUS question's messageId, deleted the answered-Q1 "✅" confirmation,
  // and left the fresh Q2 post duplicated. With the in-flight flag up the
  // re-post must stand down even though everything else says "re-post".
  assert.equal(
    checkShouldRepostPendingQuestion({
      isQuestionPending: true,
      wasLastSendTheQuestion: false,
      isQuestionPostInFlight: true,
    }),
    false,
  );
});
