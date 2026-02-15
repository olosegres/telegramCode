import { sleep } from './utils';

interface RateLimitState {
  /** Timestamp (ms) when rate limit cooldown expires */
  blockedUntil: number;
}

const rateLimitStates = new Map<number, RateLimitState>();

function getRateLimitState(userId: number): RateLimitState {
  let state = rateLimitStates.get(userId);
  if (!state) {
    state = { blockedUntil: 0 };
    rateLimitStates.set(userId, state);
  }
  return state;
}

/**
 * @description Check if a user is currently rate-limited by Telegram.
 * Used by output queue to skip sending during cooldown.
 */
export function checkIsRateLimited(userId: number): boolean {
  const state = getRateLimitState(userId);
  return Date.now() < state.blockedUntil;
}

/** Get remaining cooldown time in ms, 0 if not limited */
export function getRateLimitRemainingMs(userId: number): number {
  const state = getRateLimitState(userId);
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
 * If second attempt also fails with 429: marks user as rate-limited, throws.
 */
export async function withRateLimitRetry<T>(
  userId: number,
  operation: () => Promise<T>,
): Promise<T> {
  const state = getRateLimitState(userId);

  // If currently rate-limited, wait for cooldown
  const remainingMs = state.blockedUntil - Date.now();
  if (remainingMs > 0) {
    console.log(`[RateLimit] User ${userId} blocked for ${Math.ceil(remainingMs / 1000)}s, waiting...`);
    await sleep(remainingMs);
  }

  try {
    return await operation();
  } catch (err) {
    if (!checkIsTelegramRateLimitError(err)) throw err;

    const waitMs = getRetryAfterMs(err);
    state.blockedUntil = Date.now() + waitMs;
    console.log(`[RateLimit] User ${userId} hit 429, waiting ${Math.ceil(waitMs / 1000)}s before retry`);

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
        console.error(`[RateLimit] User ${userId} still 429 after retry, blocked for ${Math.ceil(secondWaitMs / 1000)}s`);
      }
      throw retryErr;
    }
  }
}
