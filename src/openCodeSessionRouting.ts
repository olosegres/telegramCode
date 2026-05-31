/**
 * Decide whether an incoming OpenCode SSE event belongs to a thread's bound
 * session — directly, or because the event's session is a SUBAGENT child of
 * it.
 *
 * OpenCode runs subagents (e.g. `@explore` / Task) in CHILD sessions whose
 * `parentID` points at the originating session. Their events (deltas,
 * `session.idle`, …) carry the CHILD sessionID, not the parent's. The bot
 * binds the parent session to a topic, so a child event must be matched by
 * walking up the lineage chain to the bound session — otherwise subagent
 * output is dropped and the topic hangs on the ⏳ loader forever.
 *
 * The visited-set guards against cyclic lineage so a corrupt chain can never
 * spin.
 */
export function checkIsEventForSession(
  eventSessionId: string,
  ownedSessionId: string,
  childToParent: ReadonlyMap<string, string>,
): boolean {
  if (eventSessionId === ownedSessionId) return true;

  const visitedSessionIds = new Set<string>();
  let currentSessionId = eventSessionId;

  while (!visitedSessionIds.has(currentSessionId)) {
    visitedSessionIds.add(currentSessionId);

    const parentSessionId = childToParent.get(currentSessionId);
    if (parentSessionId === undefined) return false;
    if (parentSessionId === ownedSessionId) return true;

    currentSessionId = parentSessionId;
  }

  return false;
}

/** Prefix shared by every OpenCode session id (`ses_…`). Used to reject
 * non-session ids (e.g. a `msg_…` id) before recording a lineage link. */
export const openCodeSessionIdPrefix = 'ses_';

/**
 * Record a child→parent session link learned from a `session.updated` event,
 * keeping the map bounded (oldest insertion evicted past `maxEntries`).
 *
 * Returns `true` only when a genuinely new or changed link was stored, so the
 * caller can emit a diagnostic line for exactly the links worth knowing about.
 * Ignores root sessions (no `parentID`) and any non-`ses_` id.
 */
export function updateSessionLineage(
  childToParent: Map<string, string>,
  childSessionId: string | undefined,
  parentSessionId: string | undefined,
  maxEntries: number,
): boolean {
  if (
    typeof childSessionId !== 'string' ||
    typeof parentSessionId !== 'string' ||
    !childSessionId.startsWith(openCodeSessionIdPrefix) ||
    !parentSessionId.startsWith(openCodeSessionIdPrefix)
  ) {
    return false;
  }
  if (childToParent.get(childSessionId) === parentSessionId) return false;

  childToParent.set(childSessionId, parentSessionId);
  if (childToParent.size > maxEntries) {
    const oldestSessionId = childToParent.keys().next().value;
    if (oldestSessionId !== undefined) childToParent.delete(oldestSessionId);
  }
  return true;
}
