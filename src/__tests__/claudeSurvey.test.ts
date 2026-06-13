/**
 * @description Bug #12. Claude CLI renders a periodic session-feedback SURVEY
 * that takes a BARE digit with NO Enter:
 *
 *   ● How is Claude doing this session? (optional)
 *     1: Bad    2: Fine   3: Good   0: Dismiss
 *
 * The detector must be AIRTIGHT: it matches ONLY a standalone header line
 * (anchored start-to-end, optional `● ` bullet) immediately followed by an
 * inline option row. A previous SUBSTRING matcher false-fired on a user
 * message that merely QUOTED the survey text — spamming the live topic with
 * bogus surveys + duplicates (the incident this test guards against).
 *
 * Also covered:
 *  - de-dup: the same survey across polls yields a STABLE signature → one emit;
 *  - no-Enter send plan: `appendEnter:false` enqueues NO Enter step, while the
 *    default still appends Enter (no regression);
 *  - reply routing precedence: a real AskUserQuestion selector beats a survey.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  extractClaudeSurvey,
  checkIsClaudeSurvey,
  getClaudeSendKeysPlan,
  getClaudeReplyRoute,
  checkIsClaudeLoginPaste,
} from '../adapters/claudeCliAdapter';

// The real survey frame captured live (2026-06-09): the `● ` assistant bullet
// leads the header, the options are inline on the next line.
const capturedSurveyFrame = [
  '● How is Claude doing this session? (optional)',
  '  1: Bad    2: Fine   3: Good   0: Dismiss',
].join('\n');

test('detects the captured survey frame and parses every option', () => {
  assert.equal(checkIsClaudeSurvey(capturedSurveyFrame), true);
  const survey = extractClaudeSurvey(capturedSurveyFrame)!;
  assert.ok(survey);
  assert.equal(survey.header, 'How is Claude doing this session?');
  assert.deepEqual(survey.options, [
    { digit: '1', label: 'Bad' },
    { digit: '2', label: 'Fine' },
    { digit: '3', label: 'Good' },
    { digit: '0', label: 'Dismiss' },
  ]);
});

test('detects the survey even without the leading ● bullet and without "(optional)"', () => {
  const noBullet = ['How is Claude doing this session?', '1: Bad   2: Fine'].join('\n');
  const survey = extractClaudeSurvey(noBullet)!;
  assert.ok(survey);
  assert.deepEqual(survey.options, [
    { digit: '1', label: 'Bad' },
    { digit: '2', label: 'Fine' },
  ]);
});

// ── THE INCIDENT GUARD ──
// A loose substring matcher would match the header inside this prose and
// re-spam the topic. The anchored detector must reject it: the header is NOT a
// standalone line, and no option row follows it.
test('a prose line CONTAINING the header substring (mid-sentence) is NOT a survey', () => {
  const prose = [
    'When the agent asks "How is Claude doing this session? (optional)" we forward',
    'the message and surface the 1: Bad 2: Fine options as buttons.',
  ].join('\n');
  assert.equal(checkIsClaudeSurvey(prose), false);
  assert.equal(extractClaudeSurvey(prose), null);
});

test('the header on its own line but with NO option row following is NOT a survey', () => {
  const headerOnly = [
    '● How is Claude doing this session? (optional)',
    'Sure, I can help with that — let me look into it.',
  ].join('\n');
  assert.equal(extractClaudeSurvey(headerOnly), null);
});

test('a real AskUserQuestion box is NOT detected as a survey', () => {
  const askUserQuestion = [
    'Which color do you prefer?',
    '',
    '❯ 1. Red',
    '  2. Green',
    '',
    'Enter to select',
  ].join('\n');
  assert.equal(checkIsClaudeSurvey(askUserQuestion), false);
});

test('a single-option row is not enough (needs ≥2)', () => {
  const oneOption = ['How is Claude doing this session?', '1: Bad'].join('\n');
  assert.equal(extractClaudeSurvey(oneOption), null);
});

// ── De-dup: same survey across polls → ONE emit; a different survey re-emits ──

test('the SAME survey across two polls yields an identical signature (one emit)', () => {
  // Two polls of the same survey — Claude repaints it but the content is the
  // same; the signature (header + option digits/labels, no volatile chrome)
  // must be byte-identical so the bot emits it exactly once.
  const pollOne = extractClaudeSurvey(capturedSurveyFrame)!;
  // A later poll: a spinner glyph and trailing chrome around the survey must
  // NOT change the signature.
  const pollTwo = extractClaudeSurvey(
    [
      '✻ Thinking… (3s)',
      '● How is Claude doing this session? (optional)',
      '  1: Bad    2: Fine   3: Good   0: Dismiss',
      'esc to dismiss',
    ].join('\n'),
  )!;
  assert.ok(pollOne);
  assert.ok(pollTwo);
  assert.equal(pollOne.signature, pollTwo.signature);
});

test('a DIFFERENT survey (different options) gets a different signature → re-emits', () => {
  const other = extractClaudeSurvey(
    ['How is Claude doing this session?', '1: Poor   2: Okay   3: Great'].join('\n'),
  )!;
  const original = extractClaudeSurvey(capturedSurveyFrame)!;
  assert.notEqual(other.signature, original.signature);
});

// ── No-Enter send plan ──

test('appendEnter:false → NO Enter step is enqueued (survey auto-submits on the digit)', () => {
  const plan = getClaudeSendKeysPlan('2', false);
  assert.deepEqual(plan, ['literal']);
  assert.equal(plan.some(step => step !== 'literal'), false);
});

test('default (appendEnter true) still appends an instant Enter for a short control reply — no regression', () => {
  const plan = getClaudeSendKeysPlan('2', true);
  assert.deepEqual(plan, ['literal', 'instantEnter']);
});

test('default still appends a DEFERRED slash Enter for a bare slash command — no regression', () => {
  const plan = getClaudeSendKeysPlan('/compact', true);
  assert.deepEqual(plan, ['literal', 'slashEnter']);
});

test('default still appends a paste-race-verified Enter for a plain prompt — no regression', () => {
  const plan = getClaudeSendKeysPlan('please refactor the parser module', true);
  assert.deepEqual(plan, ['literal', 'verifiedEnter']);
});

// ── Reply routing precedence ──

test('a pending AskUserQuestion selector BEATS a survey for a digit reply', () => {
  // Both pending + a digit → the real question wins (it is the user's actual
  // decision); the survey must not hijack the keystroke.
  const route = getClaudeReplyRoute({
    isQuestionPending: true,
    isSurveyPending: true,
    isLoginPastePending: false,
    text: '2',
  });
  assert.equal(route, 'selector');
});

test('a survey + a bare digit → answers the survey', () => {
  const route = getClaudeReplyRoute({
    isQuestionPending: false,
    isSurveyPending: true,
    isLoginPastePending: false,
    text: '0',
  });
  assert.equal(route, 'survey');
});

test('a survey + a y/n reply → answers the survey', () => {
  const route = getClaudeReplyRoute({
    isQuestionPending: false,
    isSurveyPending: true,
    isLoginPastePending: false,
    text: 'y',
  });
  assert.equal(route, 'survey');
});

test('a survey + free-form prose → breaks out as a normal prompt', () => {
  const route = getClaudeReplyRoute({
    isQuestionPending: false,
    isSurveyPending: true,
    isLoginPastePending: false,
    text: 'actually, do something else',
  });
  assert.equal(route, 'prompt');
});

test('nothing pending + a digit → a normal prompt (a bare "1" is never hijacked)', () => {
  const route = getClaudeReplyRoute({
    isQuestionPending: false,
    isSurveyPending: false,
    isLoginPastePending: false,
    text: '1',
  });
  assert.equal(route, 'prompt');
});

// ── /login OAuth code paste routing ──

test('login paste box up + a pasted code → routes verbatim into the box', () => {
  // The OAuth code is a long free-form string, NOT a control reply: without
  // the loginPaste route it would fall to `prompt`, whose Escape cancels the
  // login flow and whose preamble corrupts the code (the live "can't log in
  // via the bot" bug).
  const route = getClaudeReplyRoute({
    isQuestionPending: false,
    isSurveyPending: false,
    isLoginPastePending: true,
    text: 'abc123XYZ#def456-the-oauth-code',
  });
  assert.equal(route, 'loginPaste');
});

test('a real selector still beats the login-paste route for a control reply', () => {
  // Defensive precedence: the screens are mutually exclusive, but if both
  // flags were ever set a bare digit must still drive the selector.
  const route = getClaudeReplyRoute({
    isQuestionPending: true,
    isSurveyPending: false,
    isLoginPastePending: true,
    text: '1',
  });
  assert.equal(route, 'selector');
});

test('checkIsClaudeLoginPaste matches the /login paste screen, not normal panes', () => {
  const pasteScreen = [
    'Browser didn’t open? Use the url below to sign in:',
    'https://claude.ai/oauth/authorize?code=true&client_id=...',
    '',
    'Paste code here if prompted > ',
  ].join('\n');
  assert.equal(checkIsClaudeLoginPaste(pasteScreen), true);
  assert.equal(checkIsClaudeLoginPaste('❯ normal input box'), false);
  assert.equal(checkIsClaudeLoginPaste('Select login method:'), false);
  assert.equal(checkIsClaudeLoginPaste(''), false);
});
