/**
 * @description Pure helper that decides whether a fresh `startBot()` call is
 * a **hot reload** (nodemon swapped the process; agents and Telegram
 * backlog should be treated as still-connected) or a **cold start** (the
 * bot was actually down — reconnect notices are appropriate; stale
 * Telegram backlog should be dropped).
 *
 * Decision is based on the gap between `now` and the last persisted
 * heartbeat stamp (`StateStore.getDowntimeMs`):
 *
 *   - unknown (no stamp at all) → cold start.
 *     Fresh install or a pre-heartbeat state file. Conservative default —
 *     "I don't know how long I was down, assume long".
 *   - `< HOT_RELOAD_THRESHOLD_MS` → hot reload.
 *     Old PID exited and new PID started within the threshold — basically
 *     a nodemon swap or a `kill -HUP` followed by an immediate respawn.
 *   - `≥ threshold` → cold start.
 *     Operator manually stopped the bot and restarted it later; stale
 *     pending updates are probably no longer interesting.
 *
 * The threshold is generous (60s) so an unusually slow tsc build during a
 * hot reload still classifies correctly. Tightening it later is safe;
 * loosening would only widen the window where we'd quietly resubscribe to
 * a long-dead session.
 */

/** Cap (ms) below which a boot is treated as a hot reload, not a cold start. */
export const HOT_RELOAD_THRESHOLD_MS = 60_000;

export interface BootClassification {
  /** True iff the gap since the last heartbeat is below the threshold. */
  isHotReload: boolean;
  /**
   * Whether `bot.launch({ dropPendingUpdates: ... })` should drop the
   * Telegram backlog. Inverse of {@link isHotReload}: hot reload keeps
   * messages typed during the ~1s reload gap so they reach the live
   * agents; cold start discards stale updates that piled up while the bot
   * was actually down.
   */
  dropPendingUpdates: boolean;
}

/**
 * @description Map a measured downtime (in ms, or `null` for unknown) to
 * the boot-mode flags consumed by `startBot()`. Pure / synchronous — easy
 * to unit-test without touching state or telegraf.
 */
export function classifyBoot(
  downtimeMs: number | null,
  thresholdMs: number = HOT_RELOAD_THRESHOLD_MS,
): BootClassification {
  if (downtimeMs === null || downtimeMs >= thresholdMs) {
    return { isHotReload: false, dropPendingUpdates: true };
  }
  return { isHotReload: true, dropPendingUpdates: false };
}
