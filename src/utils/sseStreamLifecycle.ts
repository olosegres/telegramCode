/**
 * @description Pure decision logic for the OpenCode adapter's per-directory SSE
 * streams — extracted from `openCodeAdapter.ts` so the "open on the first
 * session for a directory, close on the last" rule is unit-testable without a
 * live server or sockets.
 *
 * Background (plan 2026-06-05 S5): the adapter used to open one
 * `/global/event` stream PER bound thread, and the server multiplexed every
 * event to each — so every delta was JSON-parsed and owner-routed once per
 * thread. Now the adapter owns ONE `/event?directory=<workDir>` stream per
 * unique bound directory; threads sharing a folder share its stream. The
 * lifecycle is reference-counted by directory: the stream opens when the first
 * active session for that directory appears and closes when the last one goes
 * away.
 */

/**
 * @description Decide what to do with a directory's SSE stream after the count
 * of active sessions sharing it changes by one.
 *
 * `open`  — the directory went from zero active sessions to one: start a stream.
 * `close` — the directory went from one active session to zero: tear it down.
 * `none`  — a sibling session already keeps (or still keeps) the stream alive,
 *           or the change is a no-op.
 *
 * @param activeSessionCountBefore active sessions sharing the directory BEFORE
 *   the change (must be ≥ 0).
 * @param activeSessionCountAfter active sessions sharing the directory AFTER
 *   the change (must be ≥ 0).
 */
export function getSseStreamTransition(
  activeSessionCountBefore: number,
  activeSessionCountAfter: number,
): 'open' | 'close' | 'none' {
  if (activeSessionCountBefore <= 0 && activeSessionCountAfter > 0) return 'open';
  if (activeSessionCountBefore > 0 && activeSessionCountAfter <= 0) return 'close';
  return 'none';
}

/** A bound session reduced to the one field the stream-set computation needs. */
export interface DirectoryBoundSession {
  /** Working directory the session is bound to — the SSE stream selector. */
  workDir: string;
  /** Whether the session is currently active (only active ones want a stream). */
  isActive: boolean;
}

/**
 * @description Compute the set of unique directories that should currently have
 * an open SSE stream, given all bound sessions. A directory is "wanted" iff at
 * least one session bound to it is active. Used to reconcile streams after a
 * server restart (re-open exactly the directories that still have live
 * sessions) and as the source of truth the reference counting must agree with.
 */
export function getWantedStreamDirectories(
  sessions: readonly DirectoryBoundSession[],
): Set<string> {
  const wanted = new Set<string>();
  for (const session of sessions) {
    if (session.isActive) wanted.add(session.workDir);
  }
  return wanted;
}

/**
 * @description Count active sessions bound to `directory` across all sessions.
 * The reference count the lifecycle keys streams on — recomputed from the
 * session map rather than tracked separately so it can never drift.
 */
export function countActiveSessionsForDirectory(
  sessions: readonly DirectoryBoundSession[],
  directory: string,
): number {
  let count = 0;
  for (const session of sessions) {
    if (session.isActive && session.workDir === directory) count += 1;
  }
  return count;
}
