import { sleep } from './utils';
import type { ThreadKey } from './types';
import { keyToString } from './types';

/**
 * @description Telegram-side rate limiting for the multi-thread bot.
 *
 * Three layers, with different keying because they protect against
 * different things:
 *
 *   1. **FIFO queue** (`enqueueSend`). Keyed by **ThreadKey**
 *      (`chatId+threadId`). Its only job is to preserve ordering between
 *      *dependent* operations on the same Telegram thread — e.g. an
 *      `editMessageText` that depends on a preceding `sendMessage`. There
 *      is no cross-thread ordering dependency: two forum topics in the
 *      same supergroup can interleave freely. Keying this queue by
 *      `chatId` alone (the pre-fix behaviour) caused a busy thread to
 *      block every other thread's sends in the same supergroup, and
 *      within a single thread it let a burst of `status` edits pile up
 *      ahead of a real `output` send.
 *
 *   2. **Token-bucket**. Keyed by **chatId**. Proactive shaping: 1 token
 *      per second, burst of 5. Telegram's documented per-chat ceiling
 *      applies to the *whole* supergroup, so the bucket has to stay
 *      chat-wide; if threads each had their own bucket, N parallel
 *      threads would burst at ~N msgs/sec and get 429'd. Threads
 *      awaiting the bucket do so on independent async paths
 *      (`bucket.take()` doesn't block the event loop), so the bucket no
 *      longer creates head-of-line blocking the way a single FIFO did.
 *
 *   3. **`withRateLimitRetry`.** Keyed by **chatId**. Reactive: if
 *      Telegram still returns 429, sleep `retry_after + jitter` and
 *      retry once. After a retry that also fails, the chat is marked
 *      blocked for the cooldown so the next send waits before even
 *      hitting the API. 429-state is per-chat because that's how
 *      Telegram returns it.
 *
 * The three layers compose: `enqueueSend(key, fn)` chains behind the
 * previous send for the *same thread*, then runs `fn` through the
 * chat-level bucket and `withRateLimitRetry`. Callers should always go
 * through `enqueueSend` for outgoing messages; `withRateLimitRetry` stays
 * exported for callers that need the retry without the proactive bucket
 * (e.g. one-off admin / health-check operations during boot).
 */

const BUCKET_CAPACITY = 5;
/** Tokens added per second. Telegram's documented ceiling is ~1 msg/sec per chat. */
const BUCKET_REFILL_PER_SEC = 1;

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private capacity: number, private refillPerSec: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** Block until at least one token is available, then consume it. */
  async take(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Sleep just long enough for the next token to be available.
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil((deficit / this.refillPerSec) * 1000);
      await sleep(waitMs);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }
}

/** One bucket per chat id — kept warm across the bot lifetime. */
const buckets = new Map<number, TokenBucket>();

function getBucket(chatId: number): TokenBucket {
  let bucket = buckets.get(chatId);
  if (!bucket) {
    bucket = new TokenBucket(BUCKET_CAPACITY, BUCKET_REFILL_PER_SEC);
    buckets.set(chatId, bucket);
  }
  return bucket;
}

/**
 * @description Per-thread FIFO of in-flight sends, keyed by serialised
 * `ThreadKey` (`"<chatId>:<threadId>"`).
 *
 * The bucket already paces sends globally per chat, but we additionally
 * chain sends within a single Telegram thread so `bot.telegram.sendMessage`
 * returns to callers in the order they were queued. This preserves
 * sequencing for operations that *do* depend on order (an `editMessageText`
 * after the `sendMessage` whose id it edits, a `pinChatMessage` after the
 * banner-send that produced the id) — but only within one thread, where
 * those dependencies actually live.
 *
 * Keying by chatId alone (pre-fix) coupled unrelated threads in the same
 * forum supergroup: a slow send in topic A held the queue tail and every
 * topic B/C/… waited behind it. With per-thread keying the queues are
 * independent and a 429 sleep / slow editMessageText in one thread no
 * longer freezes the others.
 */
const queues = new Map<string, Promise<unknown>>();

interface RateLimitState {
  /** Timestamp (ms) when rate limit cooldown expires */
  blockedUntil: number;
}

const rateLimitStates = new Map<number, RateLimitState>();

function getRateLimitState(chatId: number): RateLimitState {
  let state = rateLimitStates.get(chatId);
  if (!state) {
    state = { blockedUntil: 0 };
    rateLimitStates.set(chatId, state);
  }
  return state;
}

/**
 * @description Check if a chat is currently rate-limited by Telegram.
 * Used by the output debounce to lengthen delays during cooldown.
 */
export function checkIsRateLimited(chatId: number): boolean {
  const state = getRateLimitState(chatId);
  return Date.now() < state.blockedUntil;
}

/** Get remaining cooldown time in ms, 0 if not limited. */
export function getRateLimitRemainingMs(chatId: number): number {
  const state = getRateLimitState(chatId);
  return Math.max(0, state.blockedUntil - Date.now());
}

interface TelegramErrorLike {
  response?: {
    error_code?: number;
    parameters?: {
      retry_after?: number;
    };
  };
}

function checkIsTelegramRateLimitError(err: unknown): err is TelegramErrorLike {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as TelegramErrorLike;
  return e.response?.error_code === 429;
}

function getRetryAfterMs(err: TelegramErrorLike): number {
  const retryAfterSec = err.response?.parameters?.retry_after ?? 30;
  // Add jitter: multiply by random factor 1.0–1.3 to avoid thundering herd
  const jitter = 1 + Math.random() * 0.3;
  return Math.ceil(retryAfterSec * 1000 * jitter);
}

/**
 * @description Wraps a Telegram API call with 429 retry-after handling.
 * On 429: waits the specified retry_after + jitter, retries once.
 * If second attempt also fails with 429: marks chat as rate-limited, throws.
 *
 * Most call sites should prefer {@link enqueueSend}, which runs `fn` through
 * the per-chat token bucket *and* `withRateLimitRetry`. Use this function
 * directly only when you must bypass the proactive bucket (e.g. admin /
 * health-check operations during boot).
 */
export async function withRateLimitRetry<T>(
  chatId: number,
  operation: () => Promise<T>,
): Promise<T> {
  const state = getRateLimitState(chatId);

  // If currently rate-limited, wait for cooldown
  const remainingMs = state.blockedUntil - Date.now();
  if (remainingMs > 0) {
    console.log(`[RateLimit] chat ${chatId} blocked for ${Math.ceil(remainingMs / 1000)}s, waiting...`);
    await sleep(remainingMs);
  }

  try {
    return await operation();
  } catch (err) {
    if (!checkIsTelegramRateLimitError(err)) throw err;

    const waitMs = getRetryAfterMs(err);
    state.blockedUntil = Date.now() + waitMs;
    console.log(`[RateLimit] chat ${chatId} hit 429, waiting ${Math.ceil(waitMs / 1000)}s before retry`);

    await sleep(waitMs);

    // Single retry
    try {
      const result = await operation();
      state.blockedUntil = 0;
      return result;
    } catch (retryErr) {
      if (checkIsTelegramRateLimitError(retryErr)) {
        const secondWaitMs = getRetryAfterMs(retryErr);
        state.blockedUntil = Date.now() + secondWaitMs;
        console.error(`[RateLimit] chat ${chatId} still 429 after retry, blocked for ${Math.ceil(secondWaitMs / 1000)}s`);
      }
      throw retryErr;
    }
  }
}

/**
 * @description Send a Telegram operation through the per-thread queue,
 * per-chat token bucket, and per-chat 429 retry.
 *
 * - **Serialised per thread**: the next send for the same `ThreadKey`
 *   only runs after this one settles (success or failure). Sends for
 *   *different* threads in the same chat run concurrently, gated only
 *   by the chat-wide token bucket.
 * - **Paced per chat**: token bucket waits before passing the call to
 *   Telegram. Bucket waits are async (don't block the event loop), so
 *   threads contending for the bucket interleave fairly as tokens
 *   become available.
 * - **Retry on 429**: reactive backoff via {@link withRateLimitRetry}.
 *
 * Errors from the operation are returned to the caller (we don't swallow
 * them — only the queue tail is swallowed so a single failure doesn't
 * poison every subsequent send on that thread).
 *
 * @example
 *   await enqueueSend(key, () =>
 *     bot.telegram.sendMessage(key.chatId, text, { message_thread_id: key.threadId }));
 */
export async function enqueueSend<T>(key: ThreadKey, fn: () => Promise<T>): Promise<T> {
  const queueKey = keyToString(key);
  const prev = queues.get(queueKey);

  const exec = async (): Promise<T> => {
    await getBucket(key.chatId).take();
    return withRateLimitRetry(key.chatId, fn);
  };

  // Chain: wait for prev (ignore its errors), then run our exec.
  const current: Promise<T> = (async () => {
    if (prev) {
      try { await prev; } catch { /* swallow predecessor errors */ }
    }
    return exec();
  })();

  const tracked = current.then(
    () => undefined,
    () => undefined,
  );
  queues.set(queueKey, tracked);

  try {
    return await current;
  } finally {
    if (queues.get(queueKey) === tracked) {
      queues.delete(queueKey);
    }
  }
}
