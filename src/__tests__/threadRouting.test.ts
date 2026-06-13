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
import {
  resolveThreadKey,
  resolveDmThreadKey,
  resolvePairingCandidate,
  checkIsGeneralTopic,
  checkIsChatMode,
  GENERAL_THREAD_ID,
  DM_GENERAL_THREAD_ID,
} from '../threadRouting';

const ALLOWED = -1001234567890;
const ALLOWED_USER = 555;
/** In DM mode the owner's private-chat id IS the owner's user id. */
const OWNER_USER_ID = 7000001;

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

// ─── auto-pairing decision (STRUCTURAL only) ────────────────────────────
//
// The actor's authority — they must be a creator/administrator of the group —
// is no longer part of this pure helper; it's verified asynchronously by the
// caller via `getChatAdministrators` (see bot.ts `checkIsForumAdmin`). So these
// tests cover structural eligibility only.

const forumChat = { id: ALLOWED, type: 'supergroup', is_forum: true };

test('pair: forum supergroup with no id yet → pairs that chat', () => {
  const id = resolvePairingCandidate({
    chat: forumChat,
    currentGroupId: null,
    isEnvLocked: false,
  });
  assert.equal(id, ALLOWED);
});

test('pair: env-locked id never pairs (env wins)', () => {
  const id = resolvePairingCandidate({
    chat: forumChat,
    currentGroupId: null,
    isEnvLocked: true,
  });
  assert.equal(id, null);
});

test('pair: already-paired (currentGroupId set) does not auto-pair again', () => {
  const id = resolvePairingCandidate({
    chat: { id: -1009999999999, type: 'supergroup', is_forum: true },
    currentGroupId: ALLOWED,
    isEnvLocked: false,
  });
  assert.equal(id, null);
});

test('pair: non-forum supergroup is rejected', () => {
  const id = resolvePairingCandidate({
    chat: { id: ALLOWED, type: 'supergroup', is_forum: false },
    currentGroupId: null,
    isEnvLocked: false,
  });
  assert.equal(id, null);
});

test('pair: private chat is rejected', () => {
  const id = resolvePairingCandidate({
    chat: { id: ALLOWED_USER, type: 'private' },
    currentGroupId: null,
    isEnvLocked: false,
  });
  assert.equal(id, null);
});

test('pair: undefined chat is rejected (defensive)', () => {
  const id = resolvePairingCandidate({
    chat: undefined,
    currentGroupId: null,
    isEnvLocked: false,
  });
  assert.equal(id, null);
});

// ─── DM-mode key resolution (P1+P2 foundation) ──────────────────────────
//
// `resolveDmThreadKey` is the owner-gated key resolver for the DM surface. It
// is the load-bearing decision for DM access control: the SAME equality both
// gates the chat (only the owner's private chat) and identifies the owner
// (the private-chat id equals the owner user id). These tests prove a wrong
// user / wrong chat type → null (no access), and the owner's DM → a key, plus
// the DM "General" normalisation (no message_thread_id → 0).

const ownerDmChat = { id: OWNER_USER_ID, type: 'private' };

test('DM: owner private chat with a topic thread → key (chatId=ownerId)', () => {
  const key = resolveDmThreadKey(
    { chat: ownerDmChat, message: { message_thread_id: 500001 } },
    OWNER_USER_ID,
  );
  assert.deepEqual(key, { chatId: OWNER_USER_ID, threadId: 500001 });
});

test('DM: owner private chat with NO message_thread_id → General (threadId=0)', () => {
  const key = resolveDmThreadKey({ chat: ownerDmChat, message: {} }, OWNER_USER_ID);
  assert.deepEqual(key, { chatId: OWNER_USER_ID, threadId: DM_GENERAL_THREAD_ID });
  assert.equal(DM_GENERAL_THREAD_ID, 0);
  assert.equal(checkIsGeneralTopic(key!, 'dm'), true);
});

test('DM: a DIFFERENT user’s private chat is rejected (owner gating)', () => {
  // Any user can DM a bot — only the configured owner is allowed. The chat id
  // of a non-owner DM is that user’s id, which must not equal OWNER_USER_ID.
  const key = resolveDmThreadKey(
    { chat: { id: 999, type: 'private' }, message: {} },
    OWNER_USER_ID,
  );
  assert.equal(key, null);
});

test('DM: a supergroup update is rejected in DM mode (private-only)', () => {
  const key = resolveDmThreadKey(
    {
      chat: { id: ALLOWED, type: 'supergroup', is_forum: true },
      message: { message_thread_id: 42, is_topic_message: true },
    },
    OWNER_USER_ID,
  );
  assert.equal(key, null);
});

test('DM: undefined chat is rejected (defensive)', () => {
  const key = resolveDmThreadKey({ chat: undefined, message: {} }, OWNER_USER_ID);
  assert.equal(key, null);
});

test('DM: callback-query routes via callbackQueryMessage when ctx.message is absent', () => {
  const key = resolveDmThreadKey(
    {
      chat: ownerDmChat,
      message: undefined,
      callbackQueryMessage: { message_thread_id: 500001 },
    },
    OWNER_USER_ID,
  );
  assert.deepEqual(key, { chatId: OWNER_USER_ID, threadId: 500001 });
});

// ─── mode-aware checkIsGeneralTopic ─────────────────────────────────────

test('checkIsGeneralTopic: General marker is 1 in group mode, 0 in DM mode', () => {
  // Group surface: threadId 1 is General, 0 is not.
  assert.equal(checkIsGeneralTopic({ chatId: ALLOWED, threadId: 1 }, 'group'), true);
  assert.equal(checkIsGeneralTopic({ chatId: ALLOWED, threadId: 0 }, 'group'), false);
  // DM surface: threadId 0 is General, 1 is not.
  assert.equal(checkIsGeneralTopic({ chatId: OWNER_USER_ID, threadId: 0 }, 'dm'), true);
  assert.equal(checkIsGeneralTopic({ chatId: OWNER_USER_ID, threadId: 1 }, 'dm'), false);
  // Default mode is group → unchanged for existing callers/tests.
  assert.equal(checkIsGeneralTopic({ chatId: ALLOWED, threadId: 1 }), true);
});

// ─── CHAT_MODE validation guard ─────────────────────────────────────────

test('checkIsChatMode accepts only the two known surfaces', () => {
  assert.equal(checkIsChatMode('group'), true);
  assert.equal(checkIsChatMode('dm'), true);
  assert.equal(checkIsChatMode('supergroup'), false);
  assert.equal(checkIsChatMode('DM'), false); // case-sensitive, mirrors env intent
  assert.equal(checkIsChatMode(''), false);
});
