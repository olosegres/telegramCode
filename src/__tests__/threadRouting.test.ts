/**
 * @description Plan §11 Этап 7 / R2 — gating + thread-routing rules.
 *
 * Every test feeds a plain-object stand-in for `ctx.chat` / `ctx.message`
 * into `resolveThreadKey` and asserts on the returned key (or `null`).
 * The pure module has no Telegraf or ENV dependency, so these tests run
 * in microseconds and stay deterministic regardless of state.json.
 *
 * Coverage matrix (plan §8 + §4.3):
 *   - Forum supergroup with matching group id     → key
 *   - Forum supergroup with mismatched group id   → null
 *   - Supergroup but `is_forum=false`             → null
 *   - Private chat                                → null
 *   - Group (non-supergroup)                      → null
 *   - General topic, message_thread_id missing    → threadId = 1
 *   - General topic, message_thread_id = 1        → threadId = 1
 *   - Topic message, is_topic_message = true      → threadId = N
 *   - Reply-thread (thread_id set, is_topic_message=false) → null
 *   - Callback-query: route from cb.message       → key
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveThreadKey, checkIsGeneralTopic, GENERAL_THREAD_ID } from '../threadRouting';

const ALLOWED = -1001234567890;

test('R2: GENERAL_THREAD_ID constant is 1 (Telegram contract)', () => {
  // The General topic id is baked into Telegram's protocol; if this
  // ever changes we'd corrupt every persisted binding.
  assert.equal(GENERAL_THREAD_ID, 1);
});

test('R2: forum supergroup with matching id resolves a key', () => {
  const key = resolveThreadKey(
    {
      chat: { id: ALLOWED, type: 'supergroup', is_forum: true },
      message: { message_thread_id: 42, is_topic_message: true },
    },
    ALLOWED,
  );
  assert.deepEqual(key, { chatId: ALLOWED, threadId: 42 });
});

test('R2: forum supergroup with mismatched id is rejected', () => {
  const key = resolveThreadKey(
    {
      chat: { id: -1009999999999, type: 'supergroup', is_forum: true },
      message: { message_thread_id: 42, is_topic_message: true },
    },
    ALLOWED,
  );
  assert.equal(key, null);
});

test('R2: supergroup without is_forum is rejected (no topics → no threads)', () => {
  const key = resolveThreadKey(
    {
      chat: { id: ALLOWED, type: 'supergroup', is_forum: false },
      message: { message_thread_id: 42, is_topic_message: true },
    },
    ALLOWED,
  );
  assert.equal(key, null);
});

test('R2: private chat is rejected (the bot is forum-only)', () => {
  const key = resolveThreadKey(
    {
      chat: { id: 12345, type: 'private' },
      message: {},
    },
    ALLOWED,
  );
  assert.equal(key, null);
});

test('R2: plain group (not supergroup) is rejected', () => {
  const key = resolveThreadKey(
    {
      chat: { id: -42, type: 'group' },
      message: {},
    },
    ALLOWED,
  );
  assert.equal(key, null);
});

test('R2: undefined chat is rejected (defensive)', () => {
  const key = resolveThreadKey(
    {
      chat: undefined,
      message: { message_thread_id: 42, is_topic_message: true },
    },
    ALLOWED,
  );
  assert.equal(key, null);
});

test('R2: General topic with NO message_thread_id resolves to threadId=1', () => {
  // Some Telegram clients omit `message_thread_id` for messages in General.
  // Plan §4.3 point 3: normalise both forms to 1.
  const key = resolveThreadKey(
    {
      chat: { id: ALLOWED, type: 'supergroup', is_forum: true },
      message: {},
    },
    ALLOWED,
  );
  assert.deepEqual(key, { chatId: ALLOWED, threadId: 1 });
  assert.equal(checkIsGeneralTopic(key!), true);
});

test('R2: General topic with explicit message_thread_id=1 also resolves to threadId=1', () => {
  const key = resolveThreadKey(
    {
      chat: { id: ALLOWED, type: 'supergroup', is_forum: true },
      message: { message_thread_id: 1, is_topic_message: true },
    },
    ALLOWED,
  );
  assert.deepEqual(key, { chatId: ALLOWED, threadId: 1 });
});

test('R2: reply-thread with is_topic_message=false is rejected', () => {
  // Non-forum supergroups can still have reply chains that carry
  // `message_thread_id` — those are NOT topics. Even in a forum
  // supergroup, the General topic root can host a reply with
  // is_topic_message=false; we must not mis-route to a fake custom topic.
  const key = resolveThreadKey(
    {
      chat: { id: ALLOWED, type: 'supergroup', is_forum: true },
      message: { message_thread_id: 99, is_topic_message: false },
    },
    ALLOWED,
  );
  assert.equal(key, null);
});

test('R2: callback-query routes via callbackQueryMessage when ctx.message is absent', () => {
  // Telegraf delivers callback-button presses with no top-level
  // `ctx.message`; the originating message lives under `ctx.callbackQuery.message`.
  const key = resolveThreadKey(
    {
      chat: { id: ALLOWED, type: 'supergroup', is_forum: true },
      message: undefined,
      callbackQueryMessage: { message_thread_id: 42, is_topic_message: true },
    },
    ALLOWED,
  );
  assert.deepEqual(key, { chatId: ALLOWED, threadId: 42 });
});

test('R2: checkIsGeneralTopic returns true only for threadId=1', () => {
  assert.equal(checkIsGeneralTopic({ chatId: ALLOWED, threadId: 1 }), true);
  assert.equal(checkIsGeneralTopic({ chatId: ALLOWED, threadId: 2 }), false);
  assert.equal(checkIsGeneralTopic({ chatId: ALLOWED, threadId: 42 }), false);
});
