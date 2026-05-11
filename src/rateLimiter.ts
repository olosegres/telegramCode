import { sleep } from './utils';

/**
 * @description Telegram-side rate limiting for the multi-thread bot.
 *
 * Two layers, both keyed by **chat id** (not user id — Telegram's
 * per-chat budget is what matters for forum supergroups where N threads
 * share one `chat.id`, plan §13.16, T5):
 *
 *   1. **Token-bucket** (`enqueueSend`). Proactive shaping: 1 token per
 *      second, burst of 5. Sends are serialised per chat behind this
 *      bucket so multiple threads in one supergroup don't pile up faster
 *      than Telegram accepts. This prevents most 429s in the first place.
 *
 *   2. **`withRateLimitRetry`.** Reactive: if Telegram still returns 429,
 *      sleep `retry_after + jitter` and retry once. After a retry that
 *      also fails, the chat is marked blocked for the cooldown so the
 *      next send waits before even hitting the API.
 *
 * The two layers compose: `enqueueSend(chatId, fn)` runs `fn` through the
 * bucket and also wraps it in `withRateLimitRetry`. Callers should always
 * go through `enqueueSend` for outgoing messages; `withRateLimitRetry`
 * stays exported for the legacy `bot.ts` shim (Этап 1 callers — removed
 * by Этап 3) and for any future caller that needs the retry without the
 * proactive bucket (e.g. one-off admin commands).
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
 * @description Per-chat FIFO of in-flight sends. The bucket already paces
 * sends, but we also chain them so `bot.telegram.sendMessage` returns to
 * callers in the order they were queued. This prevents subtle UI bugs
 * where an "edit" arrives at Telegram before the "create" it depends on.
 */
const queues = new Map<number, Promise<unknown>>();

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
 * @description Send a Telegram operation through the per-chat queue and
 * token bucket, with 429 retry on top.
 *
 * - **Serialised per chat**: the next send for the same `chatId` only runs
 *   after this one settles (success or failure).
 * - **Paced**: token bucket waits before passing the call to Telegram.
 * - **Retry on 429**: reactive backoff via {@link withRateLimitRetry}.
 *
 * Errors from the operation are returned to the caller (we don't swallow
 * them — only the queue tail is swallowed so a single failure doesn't
 * poison every subsequent send on that chat).
 *
 * @example
 *   await enqueueSend(key.chatId, () =>
 *     bot.telegram.sendMessage(key.chatId, text, { message_thread_id: key.threadId }));
 */
export async function enqueueSend<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(chatId);

  const exec = async (): Promise<T> => {
    await getBucket(chatId).take();
    return withRateLimitRetry(chatId, fn);
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
  queues.set(chatId, tracked);

  try {
    return await current;
  } finally {
    if (queues.get(chatId) === tracked) {
      queues.delete(chatId);
    }
  }
}
