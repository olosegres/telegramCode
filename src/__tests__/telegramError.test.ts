import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkIsStaleAnswerCallbackQueryError } from '../utils/telegramError';

describe('checkIsStaleAnswerCallbackQueryError', () => {
  it('matches stale answerCallbackQuery Telegram 400 errors', () => {
    assert.equal(
      checkIsStaleAnswerCallbackQueryError({
        response: { error_code: 400, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' },
        on: { method: 'answerCallbackQuery' },
      }),
      true,
    );
  });

  it('does not match unrelated Telegram 400 errors', () => {
    assert.equal(
      checkIsStaleAnswerCallbackQueryError({
        response: { error_code: 400, description: 'Bad Request: message is not modified' },
        on: { method: 'editMessageText' },
      }),
      false,
    );
  });
});
