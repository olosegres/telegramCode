/**
 * @description Classify Telegram API errors raised by `sendMessage` /
 * `editMessageText` / `deleteMessage` so the bot can take the right
 * cleanup action without confusing reversible events (a closed topic)
 * with irreversible ones (a deleted topic).
 *
 * Plan §13.10 / E5:
 *   - **thread-deleted** (400 "message thread not found") → wipe binding +
 *     agents + in-memory state.
 *   - **topic-closed** (400 "TOPIC_CLOSED" / "topic is closed") → keep the
 *     binding, mark `closed: true`, surface a friendly note.
 *   - **everything else** → log and leave state alone.
 *
 * Extracted from `bot.ts` so the classification rules are unit-testable
 * without importing the rest of the Telegraf bot (plan §11 Этап 7 / R8).
 */

/** Shape of the bits we read out of a Telegram API error object. */
export interface TelegramApiErrorLike {
  response?: { error_code?: number; description?: string; parameters?: { retry_after?: number } };
  description?: string;
}

export type SendErrorClass = 'thread-deleted' | 'topic-closed' | 'other';

export function checkIsApiError(e: unknown): e is TelegramApiErrorLike {
  // Telegraf surfaces both `err.response` (the raw payload) and a flat
  // `err.description` on different code paths; accept either as proof
  // that this is the kind of error we know how to classify.
  return (
    typeof e === 'object' &&
    e !== null &&
    ('response' in e || 'description' in e)
  );
}

export function getErrorCode(e: TelegramApiErrorLike): number | undefined {
  return e.response?.error_code;
}

export function getErrorDescription(e: TelegramApiErrorLike): string {
  return (e.response?.description ?? e.description ?? '').toString();
}

/**
 * @description The `retry_after` (seconds) Telegram attaches to a 429, or
 * `undefined` when absent. Callers fall back to their own default backoff when
 * this is missing.
 */
export function getErrorRetryAfterSeconds(e: TelegramApiErrorLike): number | undefined {
  return e.response?.parameters?.retry_after;
}

/**
 * @description Map an arbitrary error into one of the cleanup categories
 * the bot knows about. Returns `'other'` for anything that doesn't match
 * (and for non-API errors) so callers can fall through to a generic
 * "log and ignore" branch without crashing.
 */
export function classifySendError(err: unknown): SendErrorClass {
  if (!checkIsApiError(err)) return 'other';
  const code = getErrorCode(err);
  if (code !== 400) return 'other';
  const desc = getErrorDescription(err);
  if (/thread not found/i.test(desc)) return 'thread-deleted';
  if (/TOPIC_CLOSED|topic is closed/i.test(desc)) return 'topic-closed';
  return 'other';
}
