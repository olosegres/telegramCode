/**
 * @description Minimal shape of the bot's per-thread output queue that
 * {@link clearThreadOutputQueues} needs to drop. Mirrors the load-bearing
 * fields of `bot.ts`'s `OutputQueueState` so the clear logic stays a pure,
 * unit-testable function instead of reaching into module-private maps.
 */
export interface ClearableOutputQueue {
  /** Coalesced, not-yet-sent agent output. `null` = nothing queued. */
  pendingOutput: string | null;
  /** Armed debounce timer that would flush `pendingOutput`. `null` = none. */
  debounceTimer: NodeJS.Timeout | null;
}

/**
 * @description Minimal shape of the bot's per-thread status coalescer that
 * {@link clearThreadOutputQueues} needs to drop. Mirrors the load-bearing
 * field of `bot.ts`'s `StatusCoalesceState`.
 */
export interface ClearableStatusCoalescer {
  /** Latest status frame not yet sent. `null` = nothing pending. */
  pendingText: string | null;
}

/**
 * @description Atomically drop a thread's bot-side queued-but-unsent agent
 * output when its session stops.
 *
 * Without this, output that was coalesced before the user stopped the agent
 * keeps draining into the topic *after* the "stopped" confirmation — observed
 * live when a Telegram 429 backlog delayed the flush. We only touch the
 * bot-side queues: the stop confirmation and any already-in-flight Telegram
 * send (`processOutputQueue` has already taken `out` locally; `flushStatusCoalescer`
 * has already taken `text`) are at the API layer and are intentionally left
 * alone — that single in-flight message may still land, but nothing queued
 * behind it does.
 *
 * Idempotent: clearing an already-empty queue is a no-op.
 */
export function clearThreadOutputQueues(
  queue: ClearableOutputQueue | undefined,
  coalescer: ClearableStatusCoalescer | undefined,
): void {
  if (queue) {
    queue.pendingOutput = null;
    if (queue.debounceTimer) {
      clearTimeout(queue.debounceTimer);
      queue.debounceTimer = null;
    }
  }
  if (coalescer) {
    // The status coalescer has no timer of its own — it is a `pendingText` +
    // `inFlight` loop. Nulling `pendingText` makes the running loop (if any)
    // exit on its next iteration without sending a stale frame.
    coalescer.pendingText = null;
  }
}
