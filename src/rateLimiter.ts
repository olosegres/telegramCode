import { sleep } from './utils';
import type { ThreadKey } from './types';
import { keyToString } from './types';
import { SendRateTracker } from './utils/sendRateTracker';
import { formatRateLimit429Line, formatRateSummaryLine } from './utils/rateLimitLog';

/**
 * @description Telegram-side rate limiting for the multi-thread bot.
 *
 * Three layers, with different responsibilities:
 *
 *   1. **Per-thread FIFO queue** (`enqueueSend`). Keyed by **ThreadKey**
 *      (`chatId+threadId`). Its only job is to preserve ordering between
 *      *dependent* operations on the same Telegram thread — e.g. an
 *      `editMessageText` that depends on a preceding `sendMessage`. Two
 *      forum topics interleave freely; only within one thread is ordering
 *      guaranteed.
 *
 *   2. **Global send pacer** ({@link GlobalSendPacer}). ONE process-wide
 *      frequency gate: it releases at most one send every
 *      {@link globalSendIntervalMs} across ALL chats (supergroup + owner DM),
 *      FCFS among waiters. It is CLOCK-BASED and NON-BLOCKING: a permit is
 *      granted on a timer, decoupled from whether the previous send's `fn`
 *      finished, so a slow/stuck send never head-of-line-blocks the others.
 *      This replaced the old per-chat priority token bucket: at ~1 send / 2 s
 *      Telegram never 429s under normal multi-topic use, and pure temporal
 *      FCFS (no priority classes) keeps cross-topic output in the order it
 *      was produced.
 *
 *   3. **`withRateLimitRetry`.** Keyed by **chatId**. Reactive: if Telegram
 *      still returns 429, sleep `retry_after + jitter` and retry once. A
 *      second 429 marks the chat blocked for the cooldown and surfaces a
 *      typed {@link RateLimitedError}. 429-state is per-chat because that's
 *      how Telegram returns it.
 *
 * The layers compose: `enqueueSend(key, fn)` chains behind the previous send
 * for the *same thread*, then waits the global pacer, then runs `fn` through
 * `withRateLimitRetry`. `withRateLimitRetry` stays exported for callers that
 * need the retry without the proactive pacer (e.g. boot admin / health-check
 * operations).
 */

/**
 * @description The global frequency gate: at most one send is released every
 * {@link globalSendIntervalMs} across ALL chats. Steady state ≈ 1 send / 2 s,
 * so Telegram's per-chat budget is never overrun under multi-topic streaming.
 */
export const globalSendIntervalMs = 2000;

/**
 * @description Default bound (ms) for {@link drainPendingSends}: how long the
 * graceful-shutdown flush waits for the per-thread send FIFOs to empty before
 * giving up. Sized well under the 10s shutdown watchdog so the later steps
 * (transient-frame sweep, update drain, `state.flush()`) keep their budgets.
 */
export const shutdownDrainMaxMs = 6000;

/**
 * @description Injectable clock + timer so timing tests can drive the pacer
 * deterministically with a fake clock instead of real-time sleeps.
 */
export interface PacerClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => void;
}

const realPacerClock: PacerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { setTimeout(fn, ms); },
};

/**
 * @description Process-wide FCFS frequency gate. `acquire()` resolves when a
 * send permit is granted; permits are released one per {@link intervalMs},
 * granted to waiters in strict arrival order (FCFS).
 *
 * CLOCK-BASED + NON-BLOCKING by design: the "next permit" time advances on a
 * timer, never on the completion of a previous caller's send. A caller whose
 * `fn` hangs after `acquire()` therefore cannot delay any other waiter — there
 * is no head-of-line blocking through this gate.
 */
export class GlobalSendPacer {
  /** Waiters parked for a permit, resolved in FIFO (arrival) order. */
  private waiters: Array<() => void> = [];
  /** Earliest clock time the next permit may be granted. */
  private nextAllowedAt = 0;
  /** A drain timer is already armed for the current waiter set. */
  private timerArmed = false;
  /** Shutdown-drain mode: permits are granted immediately, no spacing. */
  private isShutdownDraining = false;

  constructor(
    private intervalMs: number,
    private clock: PacerClock = realPacerClock,
  ) {}

  /** How many sends are currently parked waiting for a permit. */
  getPendingCount(): number {
    return this.waiters.length;
  }

  /**
   * Flip the pacer into shutdown-drain mode: every parked waiter is released
   * NOW (in FIFO order) and every subsequent `acquire()` resolves immediately.
   * ONLY for the graceful-shutdown flush — during live operation the spacing is
   * what keeps Telegram from 429ing; `withRateLimitRetry` stays on every send
   * either way, so the small shutdown burst remains 429-safe. One-way: the
   * process is exiting, so there is no leave-drain path.
   */
  enterShutdownDrain(): void {
    this.isShutdownDraining = true;
    const parked = this.waiters;
    this.waiters = [];
    for (const waiter of parked) waiter();
  }

  /**
   * Resolve when a send permit is granted. Fast path: when nobody is waiting
   * and the window is already open, grant immediately (so a send after a ≥
   * interval-long idle never eats a needless delay). Otherwise queue FIFO and
   * let the clock-driven drain grant it in turn.
   */
  acquire(): Promise<void> {
    if (this.isShutdownDraining) return Promise.resolve();
    const now = this.clock.now();
    if (this.waiters.length === 0 && now >= this.nextAllowedAt) {
      this.nextAllowedAt = now + this.intervalMs;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.armDrain();
    });
  }

  /** Arm a single timer to grant the head waiter when the window next opens. */
  private armDrain(): void {
    if (this.timerArmed || this.waiters.length === 0) return;
    const waitMs = Math.max(this.nextAllowedAt - this.clock.now(), 0);
    this.timerArmed = true;
    this.clock.setTimeout(() => {
      this.timerArmed = false;
      this.drainOne();
    }, Math.max(waitMs, 1));
  }

  /** Grant exactly one permit (the head waiter), advance the clock, re-arm. */
  private drainOne(): void {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    // Advance from whichever is later — the scheduled slot or NOW — so a late
    // timer never bunches two grants closer than the interval.
    this.nextAllowedAt = Math.max(this.nextAllowedAt, this.clock.now()) + this.intervalMs;
    waiter();
    if (this.waiters.length > 0) this.armDrain();
  }
}

/** The process-wide pacer. Swappable in tests via {@link __setGlobalPacerForTest}. */
let globalPacer = new GlobalSendPacer(globalSendIntervalMs, realPacerClock);

/**
 * @description Test-only seam: replace the process pacer with one on a
 * deterministic clock so `enqueueSend` integration tests run instantly instead
 * of waiting real 2 s windows. Never called in production.
 */
export function __setGlobalPacerForTest(pacer: GlobalSendPacer): void {
  globalPacer = pacer;
}

export const rateLimiterConstants = {
  globalSendIntervalMs,
} as const;

/**
 * @description Always-on per-chat outbound send-rate instrumentation
 * (plan 2026-06-24-rate-limit-429-metrics). Records every outbound send at the
 * single chokepoint ({@link enqueueSend}), so the rich 429 log line and the
 * periodic rate summary can characterise how hard each chat's channel is being
 * pushed. Bounded + best-effort — it never throws into the send hot path.
 */
const sendRateTracker = new SendRateTracker();

/**
 * @description Snapshot of one chat's recent outbound rate, for the periodic
 * summary in `bot.ts`. Returned together with the chat id by
 * {@link getActiveChatRateSummaries}.
 */
export interface ChatRateSummary {
  chatId: number;
  sentPerMin: number;
  peak10s: number;
}

/**
 * @description Per-chat outbound-rate snapshots for every chat with activity in
 * the rolling minute (silent chats omitted). The `bot.ts` periodic janitor logs
 * these as `[RateLimit] rate …` lines — see {@link formatRateSummaryLine}.
 */
export function getActiveChatRateSummaries(nowMs: number = Date.now()): ChatRateSummary[] {
  return sendRateTracker.getActiveChats(nowMs).map((chatId) => ({
    chatId,
    sentPerMin: sendRateTracker.getSendsPerMin(chatId, nowMs),
    peak10s: sendRateTracker.getPeakInSubWindow(chatId, undefined, nowMs),
  }));
}

/** Re-export the pure summary formatter so `bot.ts` has one import surface. */
export { formatRateSummaryLine };

/**
 * @description Per-thread FIFO of in-flight sends, keyed by serialised
 * `ThreadKey` (`"<chatId>:<threadId>"`).
 *
 * The global pacer already spaces sends across the whole process; we
 * additionally chain sends within a single Telegram thread so
 * `bot.telegram.sendMessage` returns to callers in the order they were queued.
 * This preserves sequencing for operations that *do* depend on order (an
 * `editMessageText` after the `sendMessage` whose id it edits, a
 * `pinChatMessage` after the banner-send that produced the id) — but only
 * within one thread, where those dependencies actually live. Different threads
 * stay independent, so a slow send / 429 sleep in one thread never freezes the
 * others.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * @description Flip the process pacer into shutdown-drain mode (immediate
 * release, no 2s spacing). ONLY called from the graceful-shutdown output flush
 * — never during live operation, where the spacing is the 429 protection.
 * Sends drained in this mode still run through {@link withRateLimitRetry}.
 */
export function enterShutdownDrain(): void {
  globalPacer.enterShutdownDrain();
}

/** Verdict of {@link drainPendingSends}: did the FIFOs empty within the bound? */
export type ShutdownDrainVerdict = 'drained' | 'timeout';

/**
 * @description Resolve once every per-thread send FIFO is empty, or after
 * `maxWaitMs` — whichever comes first — reporting which. Pure bookkeeping over
 * the existing {@link queues} map: it awaits the current queue tails (which
 * never reject — `enqueueSend` tracks them settled-only) and loops, because a
 * send finishing may have chained a successor onto the same thread's queue.
 * Used by the graceful-shutdown flush after {@link enterShutdownDrain} so
 * already-enqueued output lands before the process exits.
 */
export async function drainPendingSends(
  maxWaitMs: number = shutdownDrainMaxMs,
): Promise<ShutdownDrainVerdict> {
  const deadline = Date.now() + maxWaitMs;
  while (queues.size > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return 'timeout';
    const tails = [...queues.values()];
    const isTimedOut = await Promise.race([
      Promise.all(tails).then(() => false),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), remainingMs);
        timer.unref?.();
      }),
    ]);
    if (isTimedOut) return 'timeout';
    // The settled tails delete their map entries in `enqueueSend`'s `finally`,
    // which runs a microtask after the tracked promise resolves — yield one
    // macrotask so those deletes land before the emptiness re-check.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return 'drained';
}

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
 * 429 *after* the single retry. Carries the chat id and the remaining cooldown
 * as a typed signal. The global pacer makes a sustained 429 essentially
 * impossible, so this no longer drives any redelivery re-arm — it stays a typed
 * error so a caller can recognise the 429 class if it ever surfaces.
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

/** Default cooldown when Telegram omits `retry_after` (mirrors {@link getRetryAfterMs}). */
const defaultRetryAfterSec = 30;

function getRetryAfterMs(err: TelegramErrorLike): number {
  const retryAfterSec = err.response?.parameters?.retry_after ?? defaultRetryAfterSec;
  // Add jitter: multiply by random factor 1.0–1.3 to avoid thundering herd
  const jitter = 1 + Math.random() * 0.3;
  return Math.ceil(retryAfterSec * 1000 * jitter);
}

/** The raw `retry_after` Telegram returned (seconds) — the value we log. */
function getRawRetryAfterSec(err: TelegramErrorLike): number {
  return err.response?.parameters?.retry_after ?? defaultRetryAfterSec;
}

/**
 * @description Emit the rich, greppable `[RateLimit] 429` instrumentation line
 * for one 429, gathering the measured send-rate (from the tracker) and the
 * global pacer's current queue depth. Best-effort: a failure to build the line
 * must never mask the 429 handling itself.
 */
function logRateLimit429(chatId: number, err: TelegramErrorLike, isAfterRetry: boolean): void {
  try {
    const line = formatRateLimit429Line({
      chatId,
      retryAfterSec: getRawRetryAfterSec(err),
      sentPerMin: sendRateTracker.getSendsPerMin(chatId),
      peak10s: sendRateTracker.getPeakInSubWindow(chatId),
      queuedSends: globalPacer.getPendingCount(),
      isAfterRetry,
    });
    if (isAfterRetry) console.error(line);
    else console.log(line);
  } catch { /* instrumentation must never break 429 handling */ }
}

/**
 * @description Wraps a Telegram API call with 429 retry-after handling.
 * On 429: waits the specified retry_after + jitter, retries once.
 * If second attempt also fails with 429: marks chat as rate-limited, throws.
 *
 * Most call sites should prefer {@link enqueueSend}, which runs `fn` through
 * the global pacer *and* `withRateLimitRetry`. Use this function directly only
 * when you must bypass the proactive pacer (e.g. admin / health-check
 * operations during boot).
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
    logRateLimit429(chatId, err, /* isAfterRetry */ false);

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
        logRateLimit429(chatId, retryErr, /* isAfterRetry */ true);
        // Surface a typed error so a caller can recognise the 429 class. The
        // global pacer makes a sustained double-429 essentially impossible, so
        // this no longer re-arms any redelivery.
        throw new RateLimitedError(chatId, secondWaitMs, retryErr);
      }
      throw retryErr;
    }
  }
}

/**
 * @description The shared send tail both the paced and unpaced paths end in:
 * record the outbound send for the per-chat rate summary (best-effort — never
 * throws into the send path), then run `fn` through the reactive 429 retry.
 * Keeping it in one place stops {@link enqueueSend} and {@link sendUnpaced} from
 * drifting on 429-safety or instrumentation.
 */
function recordAndRetry<T>(key: ThreadKey, fn: () => Promise<T>): Promise<T> {
  // Record exactly one outbound send per logical send (best-effort
  // instrumentation — never let it break a send).
  try { sendRateTracker.recordSend(key.chatId); } catch { /* never throw into the send path */ }
  return withRateLimitRetry(key.chatId, fn);
}

/**
 * @description Send a Telegram operation OUTSIDE the global message pacer and
 * the per-thread FIFO — still 429-safe ({@link withRateLimitRetry}) and still
 * counted by {@link sendRateTracker}, but WITHOUT taking a
 * {@link globalSendIntervalMs} permit and WITHOUT chaining behind the thread's
 * other sends. Runs immediately.
 *
 * Reserved for the rare, non-output sends that must not consume the paced
 * message budget nor queue behind streaming agent output:
 *  - the typing indicator (`sendChatAction` — not a Telegram message, not
 *    subject to the flood limit, so pacing it just wastes ~60% of the budget);
 *  - the voice-transcript echo (the user's own input being acknowledged, which
 *    should surface ahead of queued agent output).
 *
 * Do NOT route ordinary agent-output `sendMessage`s through this — that would
 * break the FCFS ordering the pacer guarantees.
 */
export async function sendUnpaced<T>(
  key: ThreadKey,
  fn: () => Promise<T>,
): Promise<T> {
  return recordAndRetry(key, fn);
}

/**
 * @description Send a Telegram operation through the per-thread FIFO queue, the
 * global send pacer, and per-chat 429 retry.
 *
 * - **Serialised per thread**: the next send for the same `ThreadKey` only runs
 *   after this one settles (success or failure). Sends for *different* threads
 *   run concurrently, gated only by the global pacer.
 * - **Paced globally**: {@link GlobalSendPacer} releases ≤1 send /
 *   {@link globalSendIntervalMs} across all chats, FCFS. Permits are granted on
 *   a clock, so a slow send never blocks another thread's permit.
 * - **Retry on 429**: reactive backoff via {@link withRateLimitRetry}.
 *
 * Errors from the operation are returned to the caller (we don't swallow
 * them — only the queue tail is swallowed so a single failure doesn't poison
 * every subsequent send on that thread).
 *
 * @example
 *   await enqueueSend(key, () =>
 *     bot.telegram.sendMessage(key.chatId, text, { message_thread_id: key.threadId }));
 */
export async function enqueueSend<T>(
  key: ThreadKey,
  fn: () => Promise<T>,
): Promise<T> {
  const queueKey = keyToString(key);
  const prev = queues.get(queueKey);

  const exec = async (): Promise<T> => {
    await globalPacer.acquire();
    return recordAndRetry(key, fn);
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
