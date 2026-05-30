/**
 * @description Ordered, deterministic graceful-shutdown sequence shared by
 * every signal-driven exit path (`SIGINT`, `SIGTERM`) of the bot.
 *
 * **Why a dedicated module:**
 *
 *   - **Single owner of exit ordering.** The previous code had two SIGTERM
 *     handlers: `installLockCleanupHandlers()` (in `cli/lock.ts`) was
 *     registered first and called `releaseLock(); process.exit(0)` *synchronously*,
 *     pre-empting the bot's own async `state.flush()`. Frequent reloads
 *     under nodemon could therefore lose the last <500ms of state (one
 *     debounce window). The fix is to remove the lock module's signal
 *     handlers entirely and route every signal through this orchestrator,
 *     which awaits the flush before releasing the lock.
 *
 *   - **Bounded by a watchdog.** If `state.flush()` hangs (disk full,
 *     network FS that lost its mount), the sequence still terminates
 *     within {@link DEFAULT_WATCHDOG_MS} so the next nodemon respawn can
 *     reclaim the lock instead of waiting forever.
 *
 *   - **Testable.** Dependencies are injected, so a unit test can assert
 *     ordering (`state.flush()` resolves before `releaseLock()`) and
 *     watchdog behaviour without spinning up Telegram or the lockfile.
 *
 * **What it deliberately does NOT do:** stop tmux sessions or kill the
 * OpenCode HTTP server. Both run in external process groups and survive
 * the bot process by design — the reattach path on the next boot picks
 * them up. Killing them here would defeat the whole "hot reload keeps
 * agents alive" property the surrounding plan rests on.
 */

const DEFAULT_WATCHDOG_MS = 3000;

export interface ShutdownDeps {
  /** Name of the triggering signal (`SIGINT` / `SIGTERM` / etc.), for logs. */
  signal: string;
  /** Telegraf bot; only `.stop(signal)` is called. */
  bot: { stop: (signal?: string) => void };
  /** State store; only `.flush()` is awaited. */
  state: { flush: () => Promise<void> };
  /** Release the single-instance lockfile (idempotent — owner-checked inside). */
  releaseLock: () => void;
  /** Terminate the process. Real prod value: `(code) => process.exit(code)`. */
  exit: (code: number) => void;
  /** Optional: clear any setInterval handles the bot kept (GC sweep, etc.). */
  cleanupTimers?: () => void;
  /** Logger; defaults to `console.log`. Tests pass a sink to silence output. */
  log?: (msg: string) => void;
  /** Override the watchdog for tests. */
  watchdogMs?: number;
}

/**
 * @description Run the ordered shutdown sequence:
 *
 *   1. `cleanupTimers()` — drop any background `setInterval`s so they
 *      don't fire mid-shutdown and re-dirty state.
 *   2. `bot.stop(signal)` — Telegraf stops long-polling. Synchronous in
 *      Telegraf 4.x, so safe to call before the flush.
 *   3. `await state.flush()` — atomic-write any pending state changes.
 *      THIS is the step the old `releaseLock(); process.exit(0)` raced;
 *      we wait for the on-disk rename to land here.
 *   4. `releaseLock()` — drop the lockfile so the incoming nodemon
 *      respawn can claim it. Idempotent and owner-checked, so the
 *      `process.on('exit')` safety net in `lock.ts` finding nothing to do
 *      is fine.
 *   5. `exit(0)` — let Node tear the rest down.
 *
 * The watchdog races the whole sequence (steps 2-4): if it fires first,
 * we still call `releaseLock(); exit(0)` so the operator's terminal
 * unblocks and nodemon's next iteration finds a free lock.
 */
export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  const watchdogMs = deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const log = deps.log ?? ((m: string) => console.log(m));

  log(`\n${deps.signal} received, shutting down...`);

  let alreadyExited = false;
  const finishExit = (code: number): void => {
    if (alreadyExited) return;
    alreadyExited = true;
    try {
      deps.releaseLock();
    } catch (e) {
      console.error('[shutdown] releaseLock failed:', e);
    }
    deps.exit(code);
  };

  // Race the shutdown sequence against the watchdog. We MUST `Promise.race`
  // (not just `await` the sequence with a separate watchdog timer that
  // calls `exit`): if the sequence's `await state.flush()` hangs, the
  // outer function would otherwise never resolve and any caller awaiting
  // `gracefulShutdown(...)` (the bot's signal handler, our tests) would
  // hang along with it. The race lets the watchdog branch return control
  // immediately while the hung flush stays pending in the background —
  // harmless once we've called `exit(code)`.
  const sequence = (async (): Promise<'sequence'> => {
    if (deps.cleanupTimers) {
      try {
        deps.cleanupTimers();
      } catch (e) {
        console.error('[shutdown] cleanupTimers failed:', e);
      }
    }
    try {
      deps.bot.stop(deps.signal);
    } catch (e) {
      console.error('[shutdown] bot.stop failed:', e);
    }
    try {
      await deps.state.flush();
    } catch (e) {
      console.error('[shutdown] state.flush failed:', e);
    }
    return 'sequence';
  })();

  let watchdogHandle: NodeJS.Timeout | undefined;
  const watchdogPromise = new Promise<'watchdog'>((resolve) => {
    watchdogHandle = setTimeout(() => resolve('watchdog'), watchdogMs);
    // Don't let the watchdog keep the event loop alive on its own — once
    // the sequence resolves first and we clear the timer below, this just
    // avoids edge-case timer leaks in long-running test suites.
    watchdogHandle.unref?.();
  });

  const winner = await Promise.race([sequence, watchdogPromise]);
  if (watchdogHandle) clearTimeout(watchdogHandle);

  if (winner === 'watchdog') {
    log(
      `[shutdown] watchdog fired after ${watchdogMs}ms — forcing exit ` +
        `(state.flush() did not resolve in time)`,
    );
  }
  finishExit(0);
}
