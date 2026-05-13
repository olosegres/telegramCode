import { EventEmitter } from 'events';

export interface AgentSession {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @description Routing key for the multi-thread bot architecture.
 *
 * Replaces the old `userId: number` everywhere a per-conversation state used to live.
 *
 * - `chatId` is the Telegram supergroup id (negative for forums).
 * - `threadId` is the `message_thread_id` of a forum topic; General topic = 1.
 *
 * Until §11 Этап 3 finishes the bot.ts routing migration, `bot.ts` produces keys
 * via a shim `{ chatId: userId, threadId: 0 }` so existing private-chat behaviour
 * keeps working without any adapter-level changes.
 *
 * The pair `(chatId, threadId)` is unique within one bot instance. We keep both
 * fields rather than collapsing to `threadId` alone so that `ALLOWED_GROUP_ID`
 * mismatches stay detectable and so multi-group setups remain possible without
 * a schema change (see plan §5.5, D3).
 */
export interface ThreadKey {
  chatId: number;
  threadId: number;
}

/**
 * @description Canonical serialization of `ThreadKey` for use as a `Map` key
 * and as a state.json field name (see plan §9). Format: `"<chatId>:<threadId>"`.
 *
 * Round-trips losslessly with `keyFromString`.
 */
export function keyToString(key: ThreadKey): string {
  return `${key.chatId}:${key.threadId}`;
}

/**
 * @description Inverse of `keyToString`. Throws on malformed input —
 * callers should only feed strings that came from `keyToString` or from
 * a trusted state file.
 */
export function keyFromString(s: string): ThreadKey {
  const idx = s.indexOf(':');
  if (idx <= 0 || idx === s.length - 1) {
    throw new Error(`Invalid ThreadKey string: "${s}"`);
  }
  const chatId = Number(s.slice(0, idx));
  const threadId = Number(s.slice(idx + 1));
  if (!Number.isFinite(chatId) || !Number.isFinite(threadId)) {
    throw new Error(`Invalid ThreadKey numbers in: "${s}"`);
  }
  return { chatId, threadId };
}

/** Convenience: structural equality for two keys. */
export function keysEqual(a: ThreadKey, b: ThreadKey): boolean {
  return a.chatId === b.chatId && a.threadId === b.threadId;
}

/**
 * @description Unified interface for AI agent backends (Claude CLI, OpenCode, etc.).
 * Each adapter manages sessions keyed by `ThreadKey` and communicates via EventEmitter.
 *
 * Events emitted (all carry the `ThreadKey` as the first argument):
 * - 'output'   (key: ThreadKey, text: string)   — permanent text response
 * - 'status'   (key: ThreadKey, text: string)   — transient status (tool calls, thinking); shown as editable message
 * - 'question' (key: ThreadKey, question: { requestId: string, questions: QuestionInfo[] }) — interactive question for user
 * - 'started'  (key: ThreadKey)                  — session is up and ready
 * - 'stopped'  (key: ThreadKey)                  — `stopSession` completed (explicit teardown)
 * - 'closed'   (key: ThreadKey)                  — session died on its own (process exit, SSE giveup, server crash)
 * - 'error'    (key: ThreadKey, error: Error)    — asynchronous failure AFTER successful startSession resolution
 *
 * Audit S10 / #16 contract clarifications (enforced by every adapter):
 *
 * - `startSession` / `resumeSession` rejects (throws) if the session
 *   could not be started or recovered. Successful resolution implies
 *   `checkIsActive(key) === true` and that subsequent events will fire.
 *
 * - `emit('error', …)` is for failures that happen AFTER a successful
 *   start (network blip, SSE drop with no recovery). Synchronous start
 *   failures must throw, never emit error+return.
 *
 * - `emit('closed', …)` is for unsolicited deaths only. If the user
 *   called `stopSession`, the adapter emits `stopped` instead. Both
 *   events MUST come with the same teardown (in-memory state freed).
 */
export interface AgentAdapter extends EventEmitter {
  /** Unique adapter identifier, e.g. 'claude', 'opencode' */
  readonly name: string;
  /** Human-readable label for Telegram UI */
  readonly label: string;

  // — Lifecycle —

  /**
   * Start a new session bound to `key` in `workDir`.
   *
   * `sessionId` is the externally-assigned id for backends that support it
   * (Claude CLI's `--session-id <uuid>`). The bot owns sessionId generation
   * and persists it in state.json so resumes survive bot restarts (see plan §13.1, D14).
   * If omitted, the adapter falls back to backend defaults — for Claude this means
   * a CLI-generated UUID that the adapter still exposes via `getClaudeSessionId(key)`.
   *
   * **Throws** if the session could not be started (audit S10 / #16). The
   * returned promise rejecting means no `started` event will fire and no
   * in-memory state was retained.
   */
  startSession(key: ThreadKey, workDir: string, args?: string, sessionId?: string): Promise<void>;
  stopSession(key: ThreadKey): void;
  checkIsActive(key: ThreadKey): boolean;

  // — Input —

  sendInput(key: ThreadKey, input: string): void;
  sendSignal(key: ThreadKey, signal: string): void;

  // — Session history —

  getSessions(key: ThreadKey): Promise<AgentSession[]>;
  /**
   * Resume an existing backend session under this `key` and `workDir`.
   *
   * `workDir` is now a required argument: the adapter cannot infer it after
   * a bot restart, and silently falling back to `process.env.WORK_DIR` was a
   * source of mis-routing in the old single-folder architecture (plan §10.3,
   * fix to openCodeAdapter.ts:599).
   */
  resumeSession(key: ThreadKey, workDir: string, sessionId: string): Promise<void>;

  // — Model selection —

  /**
   * Set model override. Returns error message on failure, `null` on
   * success. Audit S10 / #39: unified to `Promise<string | null>` —
   * callers used to branch on `void` vs `Promise<string | null>`.
   */
  setModel?(key: ThreadKey, modelId: string): Promise<string | null>;
  getCurrentModel?(key: ThreadKey): string | null;
  /** Get available models from backend */
  getAvailableModels?(): Promise<string[]>;

  // — Interactive questions (OpenCode) —

  /** Reply to a pending question with selected answers */
  answerQuestion?(key: ThreadKey, answers: string[][]): void;

  // — Output mode —

  /**
   * @description When true, adapter emits incremental text deltas (not accumulated content).
   * After a status/thinking break, the bot will force a new message to avoid
   * overwriting previous substantial content with new delta text.
   */
  readonly outputsDeltas?: boolean;

  // — Optional TUI controls (Claude CLI specific) —

  sendEnter?(key: ThreadKey): void;
  sendArrow?(key: ThreadKey, direction: 'Up' | 'Down'): void;
  sendTab?(key: ThreadKey): void;
  getFullOutput?(key: ThreadKey, lines?: number): string | null;
}
