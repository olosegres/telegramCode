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
 *   2. **Token-bucket**. Keyed by **chatId**. Proactive shaping sized to
 *      Telegram's *sustained* per-supergroup ceiling (≈20 msg/min, see
 *      {@link groupMessagesPerMinute}) so multi-topic streaming doesn't
 *      systematically overrun it and trip a chat-wide 429 cooldown. A
 *      small burst capacity keeps interactive bursts snappy. Telegram's
 *      ceiling applies to the *whole* supergroup, so the bucket has to
 *      stay chat-wide; if threads each had their own bucket, N parallel
 *      threads would burst at ~N msgs/sec and get 429'd. The bucket
 *      grants tokens to waiting takers in **priority order** ({@link
 *      SendPriority}) so command confirmations never queue behind a
 *      firehose of disposable status edits. Threads awaiting the bucket
 *      do so on independent async paths (`bucket.take()` doesn't block
 *      the event loop), so the bucket no longer creates head-of-line
 *      blocking the way a single FIFO did.
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

/**
 * @name SendPriority
 * @description Priority class for a send competing for the chat-wide
 * token budget. The bucket grants the next token to the highest-priority
 * waiter, FIFO within a class.
 *
 * - `interactive` — command replies, menus, loaders, deletes tied to UX.
 *   The user is waiting on these *now*; they must win the budget.
 * - `output` — agent answer chunks streamed into a topic.
 * - `status` — rolling spinner/thinking frames. Disposable: a stale
 *   frame that never sends is no loss, so under congestion `status`
 *   **intentionally starves** behind `interactive`/`output`.
 */
export type SendPriority = 'interactive' | 'output' | 'status';

/** Highest-first order the bucket drains waiters in. */
const priorityOrder: readonly SendPriority[] = ['interactive', 'output', 'status'];

/**
 * Telegram's documented *group* ceiling is ~20 msg/min, but that is a soft,
 * conservative floor — the real per-chat limit is dynamic and higher (the
 * general guideline is ~1 msg/sec/chat = 60/min, and live probing never tripped
 * a 429 even with the limiter fully disabled). We sit between the two at
 * **40/min (≈0.67/s)** for noticeably snappier streaming/replies, well under the
 * ~1/s guideline. Any rare 429 from the overage is now caught losslessly by the
 * relay's bounded redelivery + final-flush (plan 2026-06-23-relay-429-resilience),
 * so the small extra 429 risk costs latency, never a dropped message.
 */
const groupMessagesPerMinute = 40;
const secondsPerMinute = 60;
/** Sustained refill ≈ 0.333 tokens/sec — the group ceiling expressed per second. */
const bucketRefillPerSec = groupMessagesPerMinute / secondsPerMinute;
/**
 * Burst capacity: a short interactive flurry (several quick command replies
 * back-to-back) drains the bucket instantly without waiting on the slow
 * sustained refill. Raised to 15 (from 6) so a realistic flurry — a few command
 * replies, or the opening frames of a streamed answer — lands immediately, while
 * the sustained refill still pulls the average down to the 40/min ceiling.
 */
const bucketCapacity = 15;

/** A taker parked on an empty bucket, waiting for a token. */
interface BucketWaiter {
  resolve: () => void;
}

/**
 * @description Injectable clock + timer, so timing tests can drive the
 * bucket deterministically with a tiny refill interval / fake clock
 * instead of real-time sleeps.
 */
export interface BucketClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => void;
}

const realClock: BucketClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { setTimeout(fn, ms); },
};

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  /** Waiters per priority class, FIFO within each class. */
  private waiters: Record<SendPriority, BucketWaiter[]> = {
    interactive: [],
    output: [],
    status: [],
  };
  /** A refill timer is already armed for the current waiter set. */
  private refillTimerArmed = false;

  constructor(
    private capacity: number,
    private refillPerSec: number,
    private clock: BucketClock = realClock,
  ) {
    this.tokens = capacity;
    this.lastRefill = clock.now();
  }

  /**
   * Block until a token is granted, then consume it. Tokens are granted in
   * priority order ({@link priorityOrder}), FIFO within a class, so an
   * `interactive` reply submitted *after* a backlog of `status` edits still
   * wins the next token.
   */
  take(priority: SendPriority = 'interactive'): Promise<void> {
    this.refill();
    // Fast path: a token is free AND nobody is already queued. If anyone is
    // waiting we must NOT jump them — queue and let priority dispatch decide,
    // otherwise a fresh low-priority taker could steal a token from an
    // already-waiting higher-priority one.
    if (this.tokens >= 1 && this.countWaiters() === 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.waiters[priority].push({ resolve });
      this.dispatch();
    });
  }

  private countWaiters(): number {
    return this.waiters.interactive.length
      + this.waiters.output.length
      + this.waiters.status.length;
  }

  /** Grant available tokens to waiting takers, highest priority first. */
  private dispatch(): void {
    this.refill();
    while (this.tokens >= 1) {
      const waiter = this.takeNextWaiter();
      if (!waiter) return; // no one waiting — keep the spare tokens
      this.tokens -= 1;
      waiter.resolve();
    }
    // Tokens exhausted but waiters remain → arm one timer to re-dispatch
    // when the next token will have accrued. One timer for the whole waiter
    // set, not one per waiter.
    if (this.countWaiters() > 0 && !this.refillTimerArmed) {
      this.refillTimerArmed = true;
      const deficitMs = Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
      this.clock.setTimeout(() => {
        this.refillTimerArmed = false;
        this.dispatch();
      }, Math.max(deficitMs, 1));
    }
  }

  private takeNextWaiter(): BucketWaiter | undefined {
    for (const priority of priorityOrder) {
      const next = this.waiters[priority].shift();
      if (next) return next;
    }
    return undefined;
  }

  private refill(): void {
    const now = this.clock.now();
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
    bucket = new TokenBucket(bucketCapacity, bucketRefillPerSec);
    buckets.set(chatId, bucket);
  }
  return bucket;
}

export const rateLimiterConstants = {
  groupMessagesPerMinute,
  bucketRefillPerSec,
  bucketCapacity,
} as const;

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

/**
 * @name RateLimitedError
 * @description Thrown by {@link withRateLimitRetry} when a send still gets a
 * 429 *after* the single retry. Carries the chat id and the remaining
 * cooldown so a caller that owns recoverable content (interactive command
 * replies) can schedule ONE redelivery after the cooldown instead of
 * dropping the message permanently (B14).
 *
 * The original Telegram error payload is preserved on `response` so the
 * existing classifier helpers (`checkIsApiError`, `getErrorCode`,
 * `getErrorDescription`) keep working unchanged on this error.
 */
export class RateLimitedError extends Error {
  readonly response?: TelegramErrorLike['response'];

  constructor(
    readonly chatId: number,
    readonly retryAfterMs: number,
    original?: TelegramErrorLike,
  ) {
    super(`Telegram rate limit on chat ${chatId}, cooldown ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitedError';
    this.response = original?.response;
  }
}

export function checkIsRateLimitedError(err: unknown): err is RateLimitedError {
  return err instanceof RateLimitedError;
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
        // Surface a typed error so a content-owning caller (interactive
        // replies) can decide to redeliver once after the cooldown instead
        // of dropping the message (B14). Cooldown is already set above so
        // the redelivery waits before re-hitting the API.
        throw new RateLimitedError(chatId, secondWaitMs, retryErr);
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
 *   Telegram. Bucket waits are async (don't block the event loop) and are
 *   granted in {@link SendPriority} order, so threads contending for the
 *   bucket interleave by priority as tokens become available.
 * - **Retry on 429**: reactive backoff via {@link withRateLimitRetry}.
 *
 * Errors from the operation are returned to the caller (we don't swallow
 * them — only the queue tail is swallowed so a single failure doesn't
 * poison every subsequent send on that thread).
 *
 * `priority` only affects which *waiting* send gets the next token under
 * congestion (across threads / independent chains). Per-thread FIFO
 * ordering is unchanged: a thread's earlier `enqueueSend` always reaches
 * `bucket.take()` before its later one regardless of priority, because the
 * later call's `exec` doesn't run until the earlier one settles.
 *
 * @example
 *   await enqueueSend(key, () =>
 *     bot.telegram.sendMessage(key.chatId, text, { message_thread_id: key.threadId }));
 */
export async function enqueueSend<T>(
  key: ThreadKey,
  fn: () => Promise<T>,
  priority: SendPriority = 'interactive',
): Promise<T> {
  const queueKey = keyToString(key);
  const prev = queues.get(queueKey);

  const exec = async (): Promise<T> => {
    await getBucket(key.chatId).take(priority);
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
