/**
 * Pure helpers for recovering an OpenCode question that the bot lost track of.
 *
 * An OpenCode `question` tool blocks its assistant turn (`state.status =
 * "running"`) until answered via `POST /question/:requestId/reply`. The bot
 * only treats a free-form user message as the ANSWER when its in-memory
 * `pendingQuestions` map holds an entry. Two situations leave the map empty
 * while a question is still open on the server — a bot restart (the reattach
 * path rebuilds the session with `pendingQuestion: null`) and an
 * `question.asked` event that was dropped at ask time — and then the topic
 * hangs forever (answers can't break out; a fresh prompt queues behind the
 * blocked turn).
 *
 * `GET /question?directory=<workDir>` exposes the server's live open questions
 * for an instance as a JSON array; this module turns that array into the same
 * {@link OpenCodePendingQuestion} the live `question.asked` path produces, so a
 * reattach can re-surface it and a wedged-turn check can detect it. Kept PURE
 * (no network) so it is unit-testable; the adapter owns the `GET`.
 */

import type { OpenCodePendingQuestion, OpenCodeQuestion } from './types';

/**
 * @description One entry of the `GET /question` response array. The reply id is
 * the top-level `id` (`que_…`) — NOT `tool.callID` (`toolu_…`). Only the fields
 * the bot needs are declared; the server may send more.
 */
export interface OpenCodeOpenQuestionEntry {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestion[];
}

/**
 * @description Narrow an unknown `GET /question` array element to a usable open
 * question entry. Guards every field the rebuild reads so a malformed element
 * (missing id / sessionID / non-array questions) is skipped rather than crashing
 * the reattach. Returns `null` for anything that does not match the shape.
 */
function getOpenQuestionEntry(value: unknown): OpenCodeOpenQuestionEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || entry.id.length === 0) return null;
  if (typeof entry.sessionID !== 'string' || entry.sessionID.length === 0) return null;
  if (!Array.isArray(entry.questions) || entry.questions.length === 0) return null;
  return { id: entry.id, sessionID: entry.sessionID, questions: entry.questions as OpenCodeQuestion[] };
}

/**
 * @description Find the open question owned by `sessionId` in a `GET /question`
 * response and rebuild it into the {@link OpenCodePendingQuestion} shape the
 * rest of the bot already understands (`requestId` = the entry's `id`, the
 * `questions` array, and the owning `directory` so the eventual reply targets
 * the right project instance).
 *
 * Returns `null` when the response is not an array, holds no entry for this
 * session, or the matching entry is malformed — i.e. "there is no open question
 * to recover for this session". Pure: the adapter does the `GET` and passes the
 * already-parsed JSON in here.
 */
export function getOpenQuestionForSession(
  response: unknown,
  sessionId: string,
  workDir: string,
): OpenCodePendingQuestion | null {
  if (!Array.isArray(response)) return null;

  for (const element of response) {
    const entry = getOpenQuestionEntry(element);
    if (entry && entry.sessionID === sessionId) {
      return { requestId: entry.id, questions: entry.questions, directory: workDir };
    }
  }

  return null;
}
