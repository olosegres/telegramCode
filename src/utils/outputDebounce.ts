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

/**
 * Group-mode debounce (S2). Raised 1s → 3s so each topic coalesces its own
 * stream to at most ~1 update / 3s: fewer, larger edits that compose with the
 * global 1/2s send pacer instead of a trickle of tiny sends.
 */
export const OUTPUT_DEBOUNCE_MS = 3000;

/**
 * @description The output debounce window. Group-only now (DM finalizes the
 * draft at boundaries instead of debouncing the persist), so there is a single
 * value — the original group cadence.
 */
export function getOutputDebounceMs(): number {
  return OUTPUT_DEBOUNCE_MS;
}
