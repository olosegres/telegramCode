/**
 * @description Pure loop-guard for keeping a pending question at the bottom of
 * its topic (plan `2026-06-09-question-ux.md`, S3). The debounce timer + the
 * delete/re-send I/O live in `bot.ts`; this proves the decision that gates them:
 * re-post only when a question is pending AND the question was NOT the last
 * thing sent (otherwise a re-post would fire in reaction to its own send → loop).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkShouldRepostPendingQuestion } from '../pendingQuestionRepost';

test('S3: other output landed below a pending question → re-post', () => {
  assert.equal(
    checkShouldRepostPendingQuestion({
      isQuestionPending: true,
      wasLastSendTheQuestion: false,
    }),
    true,
  );
});

test('S3: the question itself was the last send → do NOT re-post (loop guard)', () => {
  assert.equal(
    checkShouldRepostPendingQuestion({
      isQuestionPending: true,
      wasLastSendTheQuestion: true,
    }),
    false,
  );
});

test('S3: no question pending → never re-post, regardless of last send', () => {
  assert.equal(
    checkShouldRepostPendingQuestion({
      isQuestionPending: false,
      wasLastSendTheQuestion: false,
    }),
    false,
  );
  assert.equal(
    checkShouldRepostPendingQuestion({
      isQuestionPending: false,
      wasLastSendTheQuestion: true,
    }),
    false,
  );
});
