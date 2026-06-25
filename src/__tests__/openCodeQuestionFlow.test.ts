/**
 * @description Pure logic for the OpenCode question UX (plan
 * `2026-06-09-question-ux.md`). These tests are the PRIMARY safety net for the
 * question-answer path: every save auto-deploys to the live bot and OpenCode
 * questions can't be force-triggered on demand, so a regression here would
 * silently break question answering for real users.
 *
 * Coverage:
 *  - S1: option descriptions rendered under each numbered label (and NOT on the
 *    button — that is asserted in the body line shape; buttons are bot-side).
 *  - S2: the sequential answer state machine — answering a non-final question
 *    advances WITHOUT submitting; answering the last builds the full matrix with
 *    the REAL collected answers and signals exactly one submit.
 *  - S2 restore-compat: an OLD persisted entry (no `answers`/`currentIndex`) is
 *    migrated to the new shape instead of crashing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQuestionBodyLines,
  buildQuestionBodyLinesPlain,
  recordAnswerAndAdvance,
  migratePendingQuestionState,
  getQuestionReplyRoute,
} from '../openCodeQuestionFlow';
import type {
  OpenCodeQuestion,
  PendingQuestionState,
} from '../types';

// An identity "escape" makes the assertions read the raw text; the escaper is
// the bot's `escapeMarkdown` (tested elsewhere) — what matters here is the line
// SHAPE (numbering, description placement), not the escape rules.
const noEscape = (text: string): string => text;

function makeQuestion(partial: Partial<OpenCodeQuestion>): OpenCodeQuestion {
  return {
    question: 'Q?',
    options: [{ label: 'A' }, { label: 'B' }],
    ...partial,
  };
}

function makePending(
  questions: OpenCodeQuestion[],
  answers: (string[] | null)[],
  currentIndex: number,
): PendingQuestionState {
  return {
    data: { requestId: 'req-1', questions },
    messageId: 100,
    answers,
    currentIndex,
  };
}

// ── S1: option descriptions in the body ─────────────────────────────────────

test('S1: option WITH a description renders the description on an indented sub-line', () => {
  const question = makeQuestion({
    header: 'Pick a DB',
    question: 'Which database?',
    options: [
      { label: 'Postgres', description: 'relational, ACID' },
      { label: 'SQLite' },
    ],
  });

  const lines = buildQuestionBodyLines(question, noEscape);

  assert.deepEqual(lines, [
    '❓ *Pick a DB*',
    'Which database?',
    '1. Postgres',
    '   relational, ACID',
    '2. SQLite',
  ]);
});

test('S1: when header equals question, the question line is not duplicated', () => {
  const question = makeQuestion({
    header: 'Confirm?',
    question: 'Confirm?',
    options: [{ label: 'Yes', description: 'do it' }, { label: 'No' }],
  });

  const lines = buildQuestionBodyLines(question, noEscape);

  assert.deepEqual(lines, [
    '❓ *Confirm?*',
    '1. Yes',
    '   do it',
    '2. No',
  ]);
});

test('S1: no descriptions → just the numbered labels, no stray indented lines', () => {
  const question = makeQuestion({
    header: 'Pick',
    question: 'Pick one',
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
  });

  const lines = buildQuestionBodyLines(question, noEscape);

  assert.deepEqual(lines, [
    '❓ *Pick*',
    'Pick one',
    '1. A',
    '2. B',
    '3. C',
  ]);
});

test('S1: the escape function is applied to header, question, label and description', () => {
  const question = makeQuestion({
    header: 'H*',
    question: 'Q*',
    options: [{ label: 'L*', description: 'D*' }],
  });

  const lines = buildQuestionBodyLines(question, text => text.replace(/\*/g, '\\*'));

  assert.deepEqual(lines, [
    '❓ *H\\**',
    'Q\\*',
    '1. L\\*',
    '   D\\*',
  ]);
});

test('S1: plain fallback mirrors the body but without bold/escaping', () => {
  const question = makeQuestion({
    header: 'Pick a DB',
    question: 'Which database?',
    options: [
      { label: 'Postgres', description: 'relational' },
      { label: 'SQLite' },
    ],
  });

  assert.deepEqual(buildQuestionBodyLinesPlain(question), [
    '❓ Pick a DB',
    'Which database?',
    '1. Postgres',
    '   relational',
    '2. SQLite',
  ]);
});

// ── S2: sequential answer state machine ─────────────────────────────────────

test('S2: answering the first of three advances to Q2 and does NOT submit', () => {
  const questions = [
    makeQuestion({ header: 'Q1' }),
    makeQuestion({ header: 'Q2' }),
    makeQuestion({ header: 'Q3' }),
  ];
  const pending = makePending(questions, [null, null, null], 0);

  const { nextState, action } = recordAnswerAndAdvance(pending, ['ans1']);

  assert.equal(action.kind, 'showQuestion');
  assert.equal(action.kind === 'showQuestion' && action.index, 1);
  assert.equal(nextState.currentIndex, 1);
  // The answer was recorded; the rest stay unanswered (NOT blanked).
  assert.deepEqual(nextState.answers, [['ans1'], null, null]);
});

test('S2: answering the second advances to Q3 and does NOT submit', () => {
  const questions = [
    makeQuestion({ header: 'Q1' }),
    makeQuestion({ header: 'Q2' }),
    makeQuestion({ header: 'Q3' }),
  ];
  const pending = makePending(questions, [['ans1'], null, null], 1);

  const { nextState, action } = recordAnswerAndAdvance(pending, ['ans2']);

  assert.equal(action.kind, 'showQuestion');
  assert.equal(action.kind === 'showQuestion' && action.index, 2);
  assert.equal(nextState.currentIndex, 2);
  assert.deepEqual(nextState.answers, [['ans1'], ['ans2'], null]);
});

test('S2: answering the LAST builds the full matrix with the REAL answers and submits once', () => {
  const questions = [
    makeQuestion({ header: 'Q1' }),
    makeQuestion({ header: 'Q2' }),
    makeQuestion({ header: 'Q3' }),
  ];
  const pending = makePending(questions, [['ans1'], ['ans2'], null], 2);

  const { action } = recordAnswerAndAdvance(pending, ['ans3']);

  assert.equal(action.kind, 'submit');
  // Load-bearing: the matrix carries every REAL answer, not empties — the exact
  // bug the plan targets (answering Q1 used to close with '' for Q2/Q3).
  assert.deepEqual(
    action.kind === 'submit' ? action.matrix : null,
    [['ans1'], ['ans2'], ['ans3']],
  );
});

test('S2: a single-question set submits immediately on the first answer', () => {
  const questions = [makeQuestion({ header: 'Only' })];
  const pending = makePending(questions, [null], 0);

  const { action } = recordAnswerAndAdvance(pending, ['theAnswer']);

  assert.equal(action.kind, 'submit');
  assert.deepEqual(action.kind === 'submit' ? action.matrix : null, [['theAnswer']]);
});

test('S2: answering out of order fills the answered slot and advances to the FIRST still-unanswered', () => {
  // currentIndex points at Q3 (e.g. after a restore), Q1 already answered.
  const questions = [
    makeQuestion({ header: 'Q1' }),
    makeQuestion({ header: 'Q2' }),
    makeQuestion({ header: 'Q3' }),
  ];
  const pending = makePending(questions, [['ans1'], null, null], 2);

  const { nextState, action } = recordAnswerAndAdvance(pending, ['ans3']);

  // Q3 recorded; the next unanswered is Q2 (index 1), so we go back to it.
  assert.equal(action.kind, 'showQuestion');
  assert.equal(action.kind === 'showQuestion' && action.index, 1);
  assert.deepEqual(nextState.answers, [['ans1'], null, ['ans3']]);
});

test('S2: answering the last hole when an earlier one is already filled submits with both answers', () => {
  const questions = [makeQuestion({ header: 'Q1' }), makeQuestion({ header: 'Q2' })];
  // Q2 already answered, Q1 is the only hole and is current.
  const pending = makePending(questions, [null, ['ans2']], 0);

  const { action } = recordAnswerAndAdvance(pending, ['ans1']);

  assert.equal(action.kind, 'submit');
  assert.deepEqual(action.kind === 'submit' ? action.matrix : null, [['ans1'], ['ans2']]);
});

// ── S1 (cancel-on-free-form): reply routing ─────────────────────────────────

test('route: a bare digit in range answers with that option label', () => {
  const question = makeQuestion({
    options: [{ label: 'first' }, { label: 'second' }],
  });

  const route = getQuestionReplyRoute('2', question);

  assert.equal(route.kind, 'answer');
  assert.deepEqual(route.kind === 'answer' ? route.labels : null, ['second']);
});

test('route: a digit with surrounding whitespace still answers', () => {
  const question = makeQuestion({ options: [{ label: 'first' }, { label: 'second' }] });

  const route = getQuestionReplyRoute('  1  ', question);

  assert.equal(route.kind, 'answer');
  assert.deepEqual(route.kind === 'answer' ? route.labels : null, ['first']);
});

test('route: a digit OUT of range cancels (no such option)', () => {
  const question = makeQuestion({ options: [{ label: 'first' }, { label: 'second' }] });

  assert.equal(getQuestionReplyRoute('3', question).kind, 'cancel');
  assert.equal(getQuestionReplyRoute('0', question).kind, 'cancel');
});

test('route: free-form prose cancels (a real message means move on)', () => {
  const question = makeQuestion({ options: [{ label: 'first' }, { label: 'second' }] });

  assert.equal(getQuestionReplyRoute('forget it, let us do something else', question).kind, 'cancel');
});

test('route: empty / whitespace text cancels', () => {
  const question = makeQuestion({ options: [{ label: 'first' }] });

  assert.equal(getQuestionReplyRoute('', question).kind, 'cancel');
  assert.equal(getQuestionReplyRoute('   ', question).kind, 'cancel');
});

test('route: a digit mixed with text is NOT a bare digit → cancels', () => {
  const question = makeQuestion({ options: [{ label: 'first' }, { label: 'second' }] });

  assert.equal(getQuestionReplyRoute('1 please', question).kind, 'cancel');
});

test('route: with no current question, any text cancels', () => {
  assert.equal(getQuestionReplyRoute('1', undefined).kind, 'cancel');
});

// ── S2: restore-compat migration ────────────────────────────────────────────

test('S2 restore: an OLD entry (no answers/currentIndex) is migrated, not left to crash', () => {
  const questions = [makeQuestion({ header: 'Q1' }), makeQuestion({ header: 'Q2' })];
  // Simulate an entry persisted before the shape change: only data + messageId.
  const oldEntry = {
    data: { requestId: 'req-old', questions },
    messageId: 555,
  } as unknown as PendingQuestionState;

  const migrated = migratePendingQuestionState(oldEntry);

  assert.deepEqual(migrated.answers, [null, null]);
  assert.equal(migrated.currentIndex, 0);
  assert.equal(migrated.messageId, 555);
  assert.equal(migrated.data.requestId, 'req-old');
});

test('S2 restore: a NEW-shape entry with valid fields is preserved verbatim', () => {
  const questions = [makeQuestion({ header: 'Q1' }), makeQuestion({ header: 'Q2' })];
  const entry = makePending(questions, [['ans1'], null], 1);

  const migrated = migratePendingQuestionState(entry);

  assert.deepEqual(migrated.answers, [['ans1'], null]);
  assert.equal(migrated.currentIndex, 1);
});

test('S2 restore: an answers array of the WRONG length is rebuilt to the question count', () => {
  const questions = [makeQuestion({ header: 'Q1' }), makeQuestion({ header: 'Q2' }), makeQuestion({ header: 'Q3' })];
  // A corrupt entry whose answers length no longer matches the questions.
  const entry = {
    data: { requestId: 'req-corrupt', questions },
    messageId: 1,
    answers: [['stale']],
    currentIndex: 9,
  } as PendingQuestionState;

  const migrated = migratePendingQuestionState(entry);

  assert.deepEqual(migrated.answers, [null, null, null]);
  // Out-of-range currentIndex resets to 0.
  assert.equal(migrated.currentIndex, 0);
});
