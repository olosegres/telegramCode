/**
 * @description Pure decision for the pinned-banner refresh in
 * `updatePinnedStatus`: given the freshly-computed banner text, the in-memory
 * dedup cache, and the text persisted in `state.json`, decide whether the
 * `editMessageText` API call can be skipped because nothing changed.
 *
 * Extracted from `bot.ts` so the rule is unit-testable without the Telegraf /
 * state machinery (same pattern as `statusFlushDecision.ts`). The persisted
 * fallback is the B8 fix: the in-memory cache is empty on every restart, so the
 * boot-time refresh wave used to re-edit every banner with identical text,
 * each call earning a wasted `400 "message is not modified"` that burns the
 * chat-wide send budget. Seeding the decision with the persisted text lets the
 * wave skip those edits entirely.
 *
 * @name PinnedBannerSkipDecision
 * @description
 * - `skip`        — computed text equals what is already displayed; no API
 *   call. The in-memory cache already matched.
 * - `seedAndSkip` — cache miss, but the persisted text equals the computed
 *   text (the on-disk banner is already current after a restart): seed the
 *   in-memory cache from it and skip the API call.
 * - `send`        — text differs (or there is no known prior text at all): the
 *   banner must be edited/sent.
 */
export type PinnedBannerSkipDecision = 'skip' | 'seedAndSkip' | 'send';

export interface PinnedBannerSkipInput {
  /** Banner text just computed from live adapter + state. */
  computedText: string;
  /** In-memory dedup cache value for this thread, or undefined on a miss. */
  cachedText: string | undefined;
  /** Banner text persisted in state.json for this thread, or undefined. */
  persistedText: string | undefined;
}

/**
 * @description Decide whether the pinned-banner edit can be skipped.
 *
 * In-memory cache wins first (hot path during a busy turn); on a miss we fall
 * back to the persisted text so a restart's refresh wave skips identical
 * banners. A stale persisted text must never suppress a needed edit, so callers
 * clear `persistedText` whenever the banner message id is nulled / unpinned —
 * once cleared, `persistedText` is undefined and this returns `send`.
 */
export function getPinnedBannerSkipDecision(
  input: PinnedBannerSkipInput,
): PinnedBannerSkipDecision {
  if (input.cachedText === input.computedText) return 'skip';
  if (input.persistedText === input.computedText) return 'seedAndSkip';
  return 'send';
}
