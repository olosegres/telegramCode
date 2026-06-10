import type { ThreadKey } from '../types';

/**
 * @description Minimal slice of a concrete adapter that session-id persistence
 * reads: the backend-specific live session-id getter. Exactly one of the two
 * getters exists per adapter class (Claude exposes its tmux/CLI UUID, OpenCode
 * its server session id), so the persistence branch keys on method presence —
 * the structural, stub-friendly equivalent of `instanceof ClaudeCliAdapter` /
 * `instanceof OpenCodeAdapter`.
 */
export interface SessionIdSourceAdapter {
  /** Unique adapter identifier, e.g. 'claude', 'opencode' (persisted as agent name). */
  readonly name: string;
  getClaudeSessionId?: (key: ThreadKey) => string | null;
  getOpenCodeSessionId?: (key: ThreadKey) => string | null;
}

/**
 * @description Minimal slice of `StateStore` that session-id persistence
 * writes, so the helper is unit-testable with a recording stub.
 */
export interface SessionIdPersistenceStore {
  setClaudeSessionId(key: ThreadKey, uuid: string): Promise<void>;
  setOpenCodeSessionId(key: ThreadKey, id: string): Promise<void>;
  setAgent(key: ThreadKey, data: { name: string }): Promise<void>;
}

/**
 * @description Persist the adapter's CURRENT backend session id (+ the adapter
 * name) so a bot restart re-attaches to the same session. Shared by the fresh
 * start (`startAgentSession`) AND the user resume pick (`resumeSessionByIndex`)
 * — before extraction only the fresh start persisted, so a `/sessions` pick
 * was silently lost on the next restart and the thread fell back to an earlier
 * session (live incident 2026-06-10).
 *
 * An adapter reporting no live id (getter returns `null`) keeps the previously
 * persisted id untouched; the agent name is recorded unconditionally.
 */
export async function persistAdapterSessionIds(
  key: ThreadKey,
  adapter: SessionIdSourceAdapter,
  store: SessionIdPersistenceStore,
): Promise<void> {
  if (adapter.getClaudeSessionId) {
    const uuid = adapter.getClaudeSessionId(key);
    if (uuid) await store.setClaudeSessionId(key, uuid);
  } else if (adapter.getOpenCodeSessionId) {
    const sessionId = adapter.getOpenCodeSessionId(key);
    if (sessionId) await store.setOpenCodeSessionId(key, sessionId);
  }
  await store.setAgent(key, { name: adapter.name });
}
