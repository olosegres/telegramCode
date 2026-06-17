/**
 * @description Pure decision logic for the OpenCode adapter's SSE stream
 * lifecycle — extracted from `openCodeAdapter.ts` so the "open on the first
 * session, close on the last" rule is unit-testable without a live server or
 * sockets.
 *
 * Background (plan 2026-06-17): the adapter owns ONE `/global/event` stream for
 * the whole server (it superseded both the per-thread `/global/event` model of
 * plan 2026-06-05 and the per-directory `/event?directory=` model, the latter
 * going silent for an aged sole subscriber on opencode 1.14.41). Every event is
 * JSON-parsed exactly once and routed by the envelope `directory` + `sessionID`.
 * The single stream's lifecycle is reference-counted by the TOTAL active-session
 * count: it opens when the FIRST active session (any folder) appears and closes
 * when the LAST one goes away — `getSseStreamTransition` is driven with those
 * totals.
 */

/**
 * @description Decide what to do with the SSE stream after the count of active
 * sessions changes by one. Driven with the TOTAL active-session count (plan
 * 2026-06-17): the single global stream opens on the first session anywhere and
 * closes on the last.
 *
 * `open`  — went from zero active sessions to one: start the stream.
 * `close` — went from one active session to zero: tear it down.
 * `none`  — a sibling session already keeps (or still keeps) the stream alive,
 *           or the change is a no-op.
 *
 * @param activeSessionCountBefore active sessions BEFORE the change (must be ≥ 0).
 * @param activeSessionCountAfter active sessions AFTER the change (must be ≥ 0).
 */
export function getSseStreamTransition(
  activeSessionCountBefore: number,
  activeSessionCountAfter: number,
): 'open' | 'close' | 'none' {
  if (activeSessionCountBefore <= 0 && activeSessionCountAfter > 0) return 'open';
  if (activeSessionCountBefore > 0 && activeSessionCountAfter <= 0) return 'close';
  return 'none';
}
