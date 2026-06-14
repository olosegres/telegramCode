/**
 * @description The output-debounce constant, extracted as a pure helper so the
 * value is unit-testable WITHOUT booting Telegraf.
 *
 * DM v2: the persist/`queueOutput` path runs in GROUP mode ONLY — DM streams its
 * reply through the native-draft cursor (`bot.ts` draft manager) and finalizes
 * at explicit boundaries, so it never debounces here. There is therefore one
 * window left: the original group cadence. The function keeps a thin accessor
 * shape so the regression test can assert the exact value against the same
 * source `bot.ts` uses — no drift.
 */

/** Group-mode debounce. Telegram tolerates ~1 msg/sec/chat. */
export const OUTPUT_DEBOUNCE_MS = 1000;

/**
 * @description The output debounce window. Group-only now (DM finalizes the
 * draft at boundaries instead of debouncing the persist), so there is a single
 * value — the original group cadence.
 */
export function getOutputDebounceMs(): number {
  return OUTPUT_DEBOUNCE_MS;
}
