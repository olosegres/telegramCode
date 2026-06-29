/**
 * @description Decouples Telegraf's long-polling intake from per-handler
 * latency so load in one topic can no longer delay intake (or the read-✓✓
 * receipt) of another.
 *
 * **The problem.** Telegraf 4.16.3 long-polling runs
 * `for await (updates) await Promise.all(updates.map(handleUpdate))`. The next
 * `getUpdates` — which BOTH acknowledges the previous batch (flips the user's
 * second checkmark) AND fetches new messages for every thread — cannot fire
 * until every handler in the current batch resolves. One handler stuck on a
 * Telegram send (worse: under a 429 cooldown), an agent start, or a folder
 * mkdir holds the whole loop, so unrelated topics stall.
 *
 * **The fix.** Wrap `bot.handleUpdate` so it ENQUEUES the real work into a
 * per-thread serial queue and resolves immediately. `Promise.all` then resolves
 * at once, the next `getUpdates` (ACK + new batch) fires now, and the real
 * middleware chain runs off the polling loop — per-thread-serial, cross-thread
 * parallel.
 *
 * **ACK-before-process is accepted** (matches the existing `voiceQueue`): the
 * offset is sent as soon as the update is enqueued, so an update queued but not
 * yet processed at a HARD crash is lost (Telegram won't redeliver). Graceful
 * shutdown drains the queues (bounded), so only an actual crash can drop work.
 */

import type { ServerResponse } from 'http';
import type { Update } from 'telegraf/typings/core/types/typegram';
import { createSerialQueue, type SerialQueue } from './utils/serialQueue';

/** Key for updates that carry no chat (inline query, poll, etc.) — one queue. */
const globalQueueKey = 'global';
/** Stand-in thread id for chats without a forum topic (DMs, basic groups). */
const noThreadId = 0;

function buildQueueKey(chatId: number, threadId: number | undefined): string {
  return `${chatId}:${threadId ?? noThreadId}`;
}

/**
 * @description Coarse serialization key for a RAW Telegram update:
 * `"<chatId>:<threadId>"`, or `"global"` for updates with no chat. It governs
 * ONLY queue serialization + cross-thread parallelism — routing correctness
 * stays inside the unchanged handler chain, which re-resolves the real
 * `ThreadKey` itself. Narrowed on the `Update` union (no `any`).
 */
export function getUpdateQueueKey(update: Update): string {
  if ('message' in update) {
    return buildQueueKey(update.message.chat.id, update.message.message_thread_id);
  }
  if ('edited_message' in update) {
    return buildQueueKey(update.edited_message.chat.id, update.edited_message.message_thread_id);
  }
  if ('channel_post' in update) {
    return buildQueueKey(update.channel_post.chat.id, update.channel_post.message_thread_id);
  }
  if ('edited_channel_post' in update) {
    return buildQueueKey(
      update.edited_channel_post.chat.id,
      update.edited_channel_post.message_thread_id,
    );
  }
  if ('callback_query' in update) {
    const message = update.callback_query.message;
    // An inline-mode callback carries no message (only inline_message_id) → no chat.
    if (!message) return globalQueueKey;
    // `message_thread_id` exists only on the accessible Message variant.
    const threadId = 'message_thread_id' in message ? message.message_thread_id : undefined;
    return buildQueueKey(message.chat.id, threadId);
  }
  if ('message_reaction' in update) {
    return buildQueueKey(update.message_reaction.chat.id, undefined);
  }
  if ('message_reaction_count' in update) {
    return buildQueueKey(update.message_reaction_count.chat.id, undefined);
  }
  if ('my_chat_member' in update) {
    return buildQueueKey(update.my_chat_member.chat.id, undefined);
  }
  if ('chat_member' in update) {
    return buildQueueKey(update.chat_member.chat.id, undefined);
  }
  if ('chat_join_request' in update) {
    return buildQueueKey(update.chat_join_request.chat.id, undefined);
  }
  if ('chat_boost' in update) {
    return buildQueueKey(update.chat_boost.chat.id, undefined);
  }
  if ('removed_chat_boost' in update) {
    return buildQueueKey(update.removed_chat_boost.chat.id, undefined);
  }
  // inline_query / chosen_inline_result / shipping_query / pre_checkout_query /
  // poll / poll_answer carry no chat.
  return globalQueueKey;
}

export interface UpdateDispatcherDeps {
  /** Map a raw update to its serialization key (FIFO per key, parallel across keys). */
  getKey: (update: Update) => string;
  /**
   * Backstop for an unexpected rejection of the wrapped chain. The original
   * `bot.handleUpdate` already routes handler errors to `bot.catch`, so this
   * only fires if the chain rejects outside that — never swallow it silently.
   */
  onError?: (error: unknown, update: Update) => void;
}

export interface UpdateDispatcher {
  /**
   * Append `run` to the update's per-key serial queue and return SYNCHRONOUSLY
   * (does not await `run`). Preserves arrival order within a key; never throws.
   */
  dispatch(update: Update, run: () => Promise<void>): void;
  /**
   * Await all outstanding work to settle, raced against `timeoutMs` so it can
   * never outlast the shutdown watchdog. Used by the graceful-shutdown drain.
   */
  drainIdle(timeoutMs: number): Promise<void>;
  /** Outstanding (queued + in-flight) task count — for tests / metrics. */
  size(): number;
}

/**
 * @description Build the per-thread serial dispatcher. One {@link SerialQueue}
 * per key (created lazily; the map is bounded by the number of active topics);
 * different keys run concurrently.
 */
export function createUpdateDispatcher(deps: UpdateDispatcherDeps): UpdateDispatcher {
  const queues = new Map<string, SerialQueue>();
  const outstanding = new Set<Promise<void>>();

  function getQueue(key: string): SerialQueue {
    let queue = queues.get(key);
    if (!queue) {
      queue = createSerialQueue();
      queues.set(key, queue);
    }
    return queue;
  }

  function dispatch(update: Update, run: () => Promise<void>): void {
    const key = deps.getKey(update);
    const queue = getQueue(key);
    // `createSerialQueue` recovers its internal tail past a rejection, so a
    // throwing `run` neither breaks this key's queue nor any sibling key.
    const task = queue.run(run).then(
      () => undefined,
      (error: unknown) => {
        deps.onError?.(error, update);
      },
    );
    outstanding.add(task);
    void task.finally(() => {
      outstanding.delete(task);
    });
  }

  function drainIdle(timeoutMs: number): Promise<void> {
    // Snapshot now: shutdown has already stopped polling, so no new task is
    // enqueued past this point; tasks still WAITING in their queue are already
    // in `outstanding` (each `dispatch` adds its task before it starts).
    const settled = Promise.allSettled(Array.from(outstanding)).then(() => undefined);
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, timeoutMs);
    });
    // Clear the loser so a fast drain never leaves a ref'd timer pinning the
    // event loop open (which would delay process exit on shutdown).
    return Promise.race([settled, timeout]).finally(() => {
      if (handle) clearTimeout(handle);
    });
  }

  function size(): number {
    return outstanding.size;
  }

  return { dispatch, drainIdle, size };
}

/**
 * Minimal seam over Telegraf's reassignable `handleUpdate`. The polling loop
 * calls `this.handleUpdate(update)` per update, so reassigning the instance
 * property before `bot.launch` re-routes every update through the dispatcher.
 */
interface DispatchableBot {
  handleUpdate(update: Update, webhookResponse?: ServerResponse): Promise<void>;
}

/**
 * @description Reassign `bot.handleUpdate` to enqueue via `dispatcher` and
 * resolve immediately, so the polling loop's `Promise.all` settles at once and
 * the next `getUpdates` (ACK + fetch) fires without waiting on the handlers.
 *
 * **Polling-only.** The captured `webhookResponse` is forwarded to the original
 * for completeness, but a webhook deployment would need its response written
 * synchronously per update — this offload model only fits long polling, which
 * is the bot's sole transport (`bot.launch`).
 */
export function installUpdateDispatcher(bot: DispatchableBot, dispatcher: UpdateDispatcher): void {
  const original = bot.handleUpdate.bind(bot);
  bot.handleUpdate = (update: Update, webhookResponse?: ServerResponse): Promise<void> => {
    dispatcher.dispatch(update, () => original(update, webhookResponse));
    return Promise.resolve();
  };
}
