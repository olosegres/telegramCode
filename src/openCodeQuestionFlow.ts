/**
 * @description Pure logic for the OpenCode interactive-question UX (plan
 * `2026-06-09-question-ux.md`, scopes S1 + S2). Kept side-effect-free so the
 * tricky parts — rendering option descriptions and the sequential
 * multi-question answer collection — are exhaustively unit-testable without a
 * live Telegram round-trip (the answer path real topics depend on; a bug here
 * silently breaks question answering and can't be force-triggered on demand).
 *
 * The bot (`bot.ts`) owns all I/O: it calls {@link buildQuestionBodyLines} to
 * render a question's text body, and drives the answer state machine via
 * {@link recordAnswerAndAdvance}, then performs the resulting Telegram send /
 * agent reply.
 */

import type { OpenCodeQuestion, PendingQuestionState } from './types';

/**
 * @description Build the message-BODY text lines for ONE question: the header,
 * the question text (only when it differs from the header), then the numbered
 * option labels each followed by its description (S1 — descriptions were
 * previously discarded even though OpenCode delivers them).
 *
 * The numbering is 1-based and lines up with the inline option buttons
 * (`qa_<qIdx>_<optIdx>`), so a user can answer by tapping a button OR by typing
 * the digit. Descriptions go ONLY in the body (indented under the label), never
 * on the button — buttons stay label-only under Telegram's 40-char cap.
 *
 * `escape` is injected (Markdown or HTML escaper) so this stays pure and
 * backend-agnostic; the bot passes its own `escapeMarkdown`.
 */
export function buildQuestionBodyLines(
  question: OpenCodeQuestion,
  escape: (text: string) => string,
): string[] {
  const header = question.header || question.question || 'Question';
  const lines: string[] = [`❓ *${escape(header)}*`];
  if (question.question && question.question !== header) {
    lines.push(escape(question.question));
  }
  question.options.forEach((option, optIdx) => {
    lines.push(`${optIdx + 1}. ${escape(option.label)}`);
    if (option.description) {
      // Indented under the label so it reads as that option's sub-line.
      lines.push(`   ${escape(option.description)}`);
    }
  });
  return lines;
}

/**
 * @description Build the same body as {@link buildQuestionBodyLines} but with NO
 * escaping and no bold markers — the plain-text fallback used when Telegram
 * rejects the Markdown render of a question.
 */
export function buildQuestionBodyLinesPlain(question: OpenCodeQuestion): string[] {
  const header = question.header || question.question || 'Question';
  const lines: string[] = [`❓ ${header}`];
  if (question.question && question.question !== header) {
    lines.push(question.question);
  }
  question.options.forEach((option, optIdx) => {
    lines.push(`${optIdx + 1}. ${option.label}`);
    if (option.description) lines.push(`   ${option.description}`);
  });
  return lines;
}

/**
 * @description Outcome of recording one answer into the pending-question state.
 * Either the bot must SHOW the next unanswered question (`showQuestion`, with
 * the new `currentIndex`), or every question is now answered and the bot must
 * SUBMIT the full answer matrix to the agent (`submit`).
 */
export type AnswerAdvanceAction =
  | { kind: 'showQuestion'; index: number }
  | { kind: 'submit'; matrix: string[][] };

/**
 * @description Record the user's answer for the CURRENTLY shown question and
 * decide what happens next (S2 — sequential multi-question + local answer
 * collection). Pure: returns the mutated-copy state plus the action; the bot
 * performs the side effect (post the next question OR reply to the agent).
 *
 * The bug this fixes: the old handler closed the whole request on the first
 * answer, sending EMPTY answers for every other question. Here we only submit
 * once NO slot is left `null`.
 *
 * `answerForCurrent` is the chosen option label(s) or the typed text, wrapped
 * as a one-element array per OpenCode's `string[][]` matrix shape.
 */
export function recordAnswerAndAdvance(
  state: PendingQuestionState,
  answerForCurrent: string[],
): { nextState: PendingQuestionState; action: AnswerAdvanceAction } {
  const answers = state.answers.slice();
  answers[state.currentIndex] = answerForCurrent;

  const nextUnansweredIndex = answers.findIndex(slot => slot === null);
  if (nextUnansweredIndex === -1) {
    // All answered → build the matrix. A null slot can only appear here
    // defensively (e.g. a migrated/corrupt state); coerce it to [''] so the
    // reply shape stays valid string[][] and never carries `null`.
    const matrix = answers.map(slot => slot ?? ['']);
    return {
      nextState: { ...state, answers },
      action: { kind: 'submit', matrix },
    };
  }

  return {
    nextState: { ...state, answers, currentIndex: nextUnansweredIndex },
    action: { kind: 'showQuestion', index: nextUnansweredIndex },
  };
}

/**
 * @description Restore-compat guard for {@link PendingQuestionState} (S2). The
 * persisted shape grew `answers` + `currentIndex`; an OLD `state.json` entry
 * written before this change has only `{ data, messageId }`. Returning it raw
 * would leave `answers`/`currentIndex` undefined and crash the answer handlers
 * at boot. This normalises any restored entry to the new shape:
 *  - missing/mismatched-length `answers` → rebuilt as `[null…]` sized to the
 *    question count (the user must re-answer — the in-progress local answers
 *    were never sent to the agent anyway);
 *  - missing/out-of-range `currentIndex` → `0`.
 */
export function migratePendingQuestionState(raw: PendingQuestionState): PendingQuestionState {
  const questionCount = raw.data.questions.length;
  const hasValidAnswers =
    Array.isArray(raw.answers) && raw.answers.length === questionCount;
  const answers: (string[] | null)[] = hasValidAnswers
    ? raw.answers
    : new Array(questionCount).fill(null);

  const hasValidIndex =
    typeof raw.currentIndex === 'number' &&
    raw.currentIndex >= 0 &&
    raw.currentIndex < questionCount;
  const currentIndex = hasValidIndex ? raw.currentIndex : 0;

  return { ...raw, answers, currentIndex };
}
