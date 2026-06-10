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

/** A bound (active) thread session, reduced to the two fields routing needs. */
export interface BoundSessionRef {
  /** Serialised `ThreadKey` (`"<chatId>:<threadId>"`). */
  keyStr: string;
  /** Server-assigned OpenCode session id (`ses_…`) this thread owns. */
  sessionId: string;
}

/**
 * @description Resolve the SINGLE bound thread that owns an incoming SSE event,
 * so an event is delivered to at most one topic (single-owner delivery).
 *
 * Even with one stream per bound folder (threads sharing a folder share it),
 * the same event reaches the dispatcher once and may match more than one bound
 * thread: a false lineage link OR a duplicated session id (two threads
 * accidentally bound to the same server session) would make the event match —
 * and emit to — more than one topic (bug B20: the same answer appeared in two
 * threads). The single-owner rule picks exactly one.
 *
 * Ownership priority:
 *   1. A thread whose own `sessionId` directly equals `eventSessionId` is the
 *      canonical owner. Direct ownership always beats lineage descent — a
 *      session that IS bound to a thread can never be a routing *descendant* of
 *      another thread, so a real (parent) session is never stolen by a topic
 *      that merely has it in its lineage chain.
 *   2. Otherwise the event is a subagent (child-session) event: the bound
 *      thread whose `sessionId` is the nearest ancestor up the lineage chain
 *      owns it.
 *
 * Determinism on collision: if two threads claim the same `sessionId` (the
 * corruption case the prevention layer guards against), the first in iteration
 * order wins — exactly one owner, never two.
 *
 * @returns the owning thread's `keyStr`, or `null` if no bound thread owns it.
 */
export function getEventOwnerKey(
  eventSessionId: string,
  boundSessions: readonly BoundSessionRef[],
  childToParent: ReadonlyMap<string, string>,
): string | null {
  // 1. Direct id match is canonical — a bound session is never a mere descendant.
  for (const bound of boundSessions) {
    if (bound.sessionId === eventSessionId) return bound.keyStr;
  }

  // 2. Subagent event: find the bound thread reachable up the lineage chain.
  //    Walk once, recording the depth at which each bound session is reached,
  //    and pick the nearest (smallest depth) so a child routes to its closest
  //    bound ancestor rather than a higher one.
  let nearestOwnerKey: string | null = null;
  let nearestDepth = Number.POSITIVE_INFINITY;
  for (const bound of boundSessions) {
    const depth = getLineageDepthToAncestor(eventSessionId, bound.sessionId, childToParent);
    if (depth !== null && depth < nearestDepth) {
      nearestDepth = depth;
      nearestOwnerKey = bound.keyStr;
    }
  }
  return nearestOwnerKey;
}

/**
 * @description Decide whether a "drop" diagnostic for `(eventType,
 * eventSessionId)` should be logged now, throttled to once per `throttleMs`.
 * An orphaned session streams hundreds of deltas; logging each (× each bound
 * thread) floods the diag log (B19). Mutates `lastLoggedAtByKey` to record the
 * log time, evicting the oldest entry past `maxEntries` so the map stays
 * bounded. Pure-ish (single mutation of the passed map) so the throttle is
 * unit-testable without any I/O.
 *
 * @returns `true` if this drop is the first in its window (caller should log).
 */
export function checkShouldLogDrop(
  lastLoggedAtByKey: Map<string, number>,
  eventType: string,
  eventSessionId: string,
  now: number,
  throttleMs: number,
  maxEntries: number,
): boolean {
  const throttleKey = `${eventType}|${eventSessionId}`;
  const lastLoggedAt = lastLoggedAtByKey.get(throttleKey);
  if (lastLoggedAt !== undefined && now - lastLoggedAt < throttleMs) return false;

  lastLoggedAtByKey.set(throttleKey, now);
  if (lastLoggedAtByKey.size > maxEntries) {
    const oldestKey = lastLoggedAtByKey.keys().next().value;
    if (oldestKey !== undefined) lastLoggedAtByKey.delete(oldestKey);
  }
  return true;
}

/**
 * @description Number of lineage hops from `eventSessionId` up to
 * `ancestorSessionId`, or `null` if the ancestor is not on the chain. A
 * visited-set guards against a corrupt cyclic chain. Returns `null` (not 0) for
 * an equal id — a *direct* match is handled separately in `getEventOwnerKey` so
 * it always wins over descent. Exported (besides the routing internals) for the
 * adapter's busy tracking, which must verify a STRICT descendant before
 * recording a busy child — a dir-fallback-routed foreign sibling must never
 * count.
 */
export function getLineageDepthToAncestor(
  eventSessionId: string,
  ancestorSessionId: string,
  childToParent: ReadonlyMap<string, string>,
): number | null {
  if (eventSessionId === ancestorSessionId) return null;

  const visitedSessionIds = new Set<string>();
  let currentSessionId = eventSessionId;
  let depth = 0;

  while (!visitedSessionIds.has(currentSessionId)) {
    visitedSessionIds.add(currentSessionId);

    const parentSessionId = childToParent.get(currentSessionId);
    if (parentSessionId === undefined) return null;
    depth += 1;
    if (parentSessionId === ancestorSessionId) return depth;

    currentSessionId = parentSessionId;
  }

  return null;
}

/**
 * Record a child→parent session link learned from an event that exposes both
 * ids, keeping the map bounded (oldest insertion evicted past `maxEntries`).
 *
 * Originally fed only by `session.updated`, but a child's lineage must be known
 * BEFORE that beat or its earliest events drop "no owner" — so the adapter now
 * records from ANY event whose properties expose `parentID` (S2 lineage
 * durability), not just `session.updated`.
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
  // A session can never be its own parent — a self-link would make the lineage
  // walk treat the session as its own ancestor and corrupt single-owner routing.
  if (childSessionId === parentSessionId) return false;
  if (childToParent.get(childSessionId) === parentSessionId) return false;

  childToParent.set(childSessionId, parentSessionId);
  if (childToParent.size > maxEntries) {
    const oldestSessionId = childToParent.keys().next().value;
    if (oldestSessionId !== undefined) childToParent.delete(oldestSessionId);
  }
  return true;
}

/**
 * @description Mark every lineage hop walked to route `eventSessionId` to one of
 * its bound ancestors as MOST-recently-used, so an actively-routing child is
 * never the eviction victim.
 *
 * Why this exists: the lineage map is bounded by `maxEntries` and evicts the
 * OLDEST INSERTION first (a Map preserves insertion order). A long-lived
 * subagent that keeps streaming but never re-emits its `parentID` would, after
 * `maxEntries` newer links land, be evicted mid-turn and its remaining events
 * would drop "no owner" (the ~9 min gap proven live for a child of thread 688).
 * Re-inserting a USED link (delete + set — a plain `set` on an existing key does
 * NOT reorder a JS Map) moves it to the tail, so the entries doing real routing
 * work are evicted LAST. The cap is untouched; only the victim choice changes
 * from "oldest inserted" to "oldest unused".
 *
 * Walks the same chain as {@link getLineageDepthToAncestor} (visited-set guards
 * a corrupt cycle) and touches each link UP TO `ancestorSessionId` inclusive.
 */
export function touchLineageOnUse(
  childToParent: Map<string, string>,
  eventSessionId: string,
  ancestorSessionId: string,
): void {
  const visitedSessionIds = new Set<string>();
  let currentSessionId = eventSessionId;

  while (!visitedSessionIds.has(currentSessionId)) {
    visitedSessionIds.add(currentSessionId);

    const parentSessionId = childToParent.get(currentSessionId);
    if (parentSessionId === undefined) return;

    // Re-insert to move this link to the tail (most-recently-used).
    childToParent.delete(currentSessionId);
    childToParent.set(currentSessionId, parentSessionId);

    if (parentSessionId === ancestorSessionId) return;
    currentSessionId = parentSessionId;
  }
}

/**
 * @description Resolve an event's owner by DIRECTORY when id/lineage resolution
 * has already failed — the SSE-routing fallback (S2). The stream is opened per
 * bound folder (`?directory=<dir>`), so an event arriving on it provably belongs
 * to one of the threads bound to THAT folder, even when the per-session lineage
 * map briefly disagrees (the child's `parentID` link was evicted or not yet
 * recorded). Pure: the caller passes the directory's ACTIVE bound sessions, so
 * it is unit-testable without a live server.
 *
 * Decision rule (never guess a topic — a wrong topic is worse than a logged
 * drop):
 *   - exactly ONE active session in the directory → it owns the event;
 *   - more than one → disambiguate ONLY via in-memory lineage: route to the one
 *     active session that is a lineage ancestor of `eventSessionId`. If zero or
 *     several active sessions are ancestors → ambiguous → `null`;
 *   - zero active sessions → `null`.
 *
 * @returns the owning thread's `keyStr`, or `null` when it cannot be resolved
 *   unambiguously (the caller then loud-drops).
 */
export function resolveOwnerByDirectoryFallback(
  eventSessionId: string,
  directoryActiveSessions: readonly BoundSessionRef[],
  childToParent: ReadonlyMap<string, string>,
): string | null {
  if (directoryActiveSessions.length === 0) return null;
  if (directoryActiveSessions.length === 1) return directoryActiveSessions[0].keyStr;

  // >1 active in the same folder (two topics on one project): only route when
  // exactly one of them is a genuine lineage ancestor of the event's session.
  let ancestorOwnerKey: string | null = null;
  for (const bound of directoryActiveSessions) {
    if (bound.sessionId === eventSessionId) return bound.keyStr;
    if (getLineageDepthToAncestor(eventSessionId, bound.sessionId, childToParent) !== null) {
      if (ancestorOwnerKey !== null) return null; // two ancestors → ambiguous
      ancestorOwnerKey = bound.keyStr;
    }
  }
  return ancestorOwnerKey;
}
