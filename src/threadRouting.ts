/**
 * @description Pure routing-decision logic — extracted from `bot.ts` so
 * the gating rules (plan §8) can be unit-tested without booting Telegraf,
 * parsing ENV, or pulling in 30+ adapter dependencies.
 *
 * The Telegram `Context` object carries everything we need:
 *   - `ctx.chat` → forum supergroup detection + chat-id allowlist gate
 *   - `ctx.message` (or `ctx.callbackQuery.message`) →
 *     `message_thread_id` + `is_topic_message`
 *
 * Both fields are passed in by `bot.ts:getThreadKey` after pulling them
 * from the live context, so this module can stay free of Telegraf imports.
 *
 * The `GENERAL_THREAD_ID = 1` constant is the magic number for the
 * General forum topic — Telegram returns the thread id either as `1` or
 * (sometimes) as `undefined` for posts in General; we normalise both to 1.
 *
 * Plan §11 Этап 7 / R2.
 */

import type { ThreadKey } from './types';

/** Telegram's stable id for the General forum topic. */
export const GENERAL_THREAD_ID = 1;

/**
 * @description Minimal shape of the bits of `ctx.chat` we read. We accept
 * `unknown` widths on optional fields so callers can pass a Telegraf
 * `Chat` union without casting.
 */
export interface RouteChat {
  id: number;
  type?: string;
  /** Present (and `true`) only on forum-enabled supergroups. */
  is_forum?: boolean;
}

/**
 * @description Minimal shape of the bits of `ctx.message` /
 * `ctx.callbackQuery.message` we read.
 */
export interface RouteMessage {
  message_thread_id?: number;
  is_topic_message?: boolean;
}

export interface RouteInput {
  chat: RouteChat | undefined;
  /** From `ctx.message` (top-level update). */
  message?: RouteMessage | undefined;
  /** From `ctx.callbackQuery?.message` (inline-button presses). */
  callbackQueryMessage?: RouteMessage | undefined;
}

/**
 * @description Compute the `ThreadKey` for an incoming Telegram update,
 * or return `null` if the bot should silently ignore it.
 *
 * Gating rules (plan §8):
 *   1. Chat is a forum supergroup (`type === 'supergroup'` AND `is_forum`).
 *   2. `chat.id === allowedGroupId`.
 *   3. If a `message_thread_id` is present, `is_topic_message` must be
 *      `true` — guards against plain reply-threads in non-forum
 *      supergroups, which also carry `message_thread_id` but are NOT
 *      topics (plan §4.3 point 2, T7).
 *   4. Missing `message_thread_id` → General topic (id 1).
 */
export function resolveThreadKey(input: RouteInput, allowedGroupId: number): ThreadKey | null {
  const chat = input.chat;
  if (!chat || chat.type !== 'supergroup') return null;
  if (!chat.is_forum) return null;
  if (chat.id !== allowedGroupId) return null;

  // Callback-query updates carry the originating message under
  // `ctx.callbackQuery.message`. Either source is fine — they share the
  // forum-topic fields by Telegram's data model.
  const msg = input.message ?? input.callbackQueryMessage;

  const rawThreadId = msg?.message_thread_id;
  const isTopicMessage = msg?.is_topic_message;

  // Reply-threads in non-forum supergroups also carry message_thread_id.
  // We've already gated on `is_forum`, but a forum supergroup can still
  // host a reply on the General-topic root — `is_topic_message` is `false`
  // in that case and we should NOT mis-route it to a custom topic id.
  if (rawThreadId && !isTopicMessage) return null;

  const threadId = rawThreadId ?? GENERAL_THREAD_ID;
  return { chatId: chat.id, threadId };
}

/**
 * @description Convenience: is this the General topic? Used by command
 * handlers that have different semantics in General vs. a thematic topic
 * (e.g. `/ls` is General-only, `/bind` is topic-only).
 */
export function checkIsGeneralTopic(key: ThreadKey): boolean {
  return key.threadId === GENERAL_THREAD_ID;
}

/** Inputs for the auto-pairing decision (side-effect free). */
export interface PairingInput {
  chat: RouteChat | undefined;
  /** Already-effective group id (env or previously paired), or `null`. */
  currentGroupId: number | null;
  /** True when `ALLOWED_GROUP_ID` env is set numerically — pairing disabled. */
  isEnvLocked: boolean;
}

/**
 * @description Decide whether an incoming update's chat is STRUCTURALLY a
 * pairing candidate. Returns the chat id to pair, or `null`.
 *
 * Eligible only when ALL hold:
 *   1. Not locked by a numeric `ALLOWED_GROUP_ID` env.
 *   2. No effective group id yet (`currentGroupId === null`).
 *   3. The chat is a forum supergroup (same gate as {@link resolveThreadKey}).
 *
 * The actor's authority — they must be a creator/administrator of the group, so
 * a random group can't hijack pairing — is verified separately and
 * asynchronously by the caller via `getChatAdministrators`; it can't live in a
 * pure helper.
 */
export function resolvePairingCandidate(input: PairingInput): number | null {
  if (input.isEnvLocked) return null;
  if (input.currentGroupId !== null) return null;
  const { chat } = input;
  if (!chat || chat.type !== 'supergroup' || !chat.is_forum) return null;
  return chat.id;
}
