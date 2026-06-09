import { EventEmitter } from 'events';

export interface AgentSession {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @description One conversational turn (a single user OR assistant message that
 * carries renderable text) of a resumable session, used to build the short
 * "↩️ Resumed — last N messages" context block shown on resume instead of
 * flooding the topic with the whole restored transcript. Tool-call / step /
 * meta records are NOT turns. See `src/resumeContext.ts`.
 */
export interface RecentTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * @description Options for {@link AgentAdapter.resumeSession}.
 */
export interface ResumeSessionOptions {
  /**
   * Post the "↩️ Resumed — last N messages" context block to the topic.
   * Set ONLY on the explicit user resume (`/sessions` pick) — silent
   * re-attach after a bot restart and crash-recovery resumes must stay
   * quiet, otherwise every hot rebuild spams every active topic.
   */
  isWithRecentContext?: boolean;
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
 * @description One tappable option of an interactive agent question
 * (OpenCode's `ask`/question tool). `description` is shown beneath the label
 * when present.
 */
export interface OpenCodeQuestionOption {
  label: string;
  description?: string;
}

/**
 * @description One question of an interactive agent prompt. `multiple` means
 * several options may be selected. The bot renders one Telegram message per
 * question with an inline button per option.
 */
export interface OpenCodeQuestion {
  question: string;
  header?: string;
  options: OpenCodeQuestionOption[];
  multiple?: boolean;
}

/**
 * @description A pending interactive question the agent is blocked on, awaiting
 * the user's answer. Plain serialisable data (no functions / class instances)
 * so it can be persisted in `state.json` and restored after a bot restart —
 * which is the whole point: without persistence the in-memory pending-question
 * map is lost on restart, the agent's question tool hangs forever, and the
 * existing Telegram option buttons go dead. Lives here (a leaf module both
 * `bot.ts` and `state.ts` already import) rather than in `openCodeAdapter.ts`
 * so persisting it does not create a `state.ts → adapter → types` import cycle.
 */
export interface OpenCodePendingQuestion {
  requestId: string;
  questions: OpenCodeQuestion[];
  /**
   * Project-instance directory that owns the question request (from the
   * `/global/event` envelope). The reply must select the same instance via
   * `?directory=` — see `buildDirectoryScopedPath` in `openCodeAdapter.ts`.
   */
  directory?: string;
}

/**
 * @description The bot's per-thread record of an interactive question on screen:
 * the question {@link OpenCodePendingQuestion} plus the Telegram `messageId`
 * of the posted option-button message (`null` until `replyToThread` resolves).
 * Both fields are serialisable, so the whole record is persisted to `state.json`
 * and restored at boot for threads whose session reattached — re-arming the
 * existing buttons so a restart no longer hangs the agent.
 */
export interface PendingQuestionState {
  data: OpenCodePendingQuestion;
  messageId: number | null;
}

/**
 * @description Classification of a provider-side API error surfaced by either
 * agent backend (Claude terminal "API Error" line or OpenCode `session.error`).
 * Drives the auto-retry decision: `transient` (rate-limit / overloaded — short
 * backoff) vs `usageLimit` (subscription / quota exhausted — long wait). Auth /
 * non-retryable errors are NOT represented here — the classifier returns `null`
 * for those so they are never retried.
 */
export interface AgentApiErrorClass {
  kind: 'transient' | 'usageLimit';
  /** Epoch ms when a usage window resets, if the error text exposed one. */
  resetAt?: number;
}

/**
 * @description The bot's per-thread record of an armed auto-retry after a
 * provider-side API error: the error {@link AgentApiErrorClass.kind} that armed
 * it, the 1-based attempt already scheduled, and the epoch-ms `fireAt` when the
 * retry timer should fire. No prompt is stored — the kick is a neutral "continue"
 * nudge that resumes the agent's intact session, not a re-send of the original
 * prompt. No adapter name either — the kick reuses the thread's existing
 * last-used adapter via `ensureAgentSession`. All fields are serialisable, so the
 * whole record is persisted to `state.json` and re-armed at boot — a multi-hour
 * usage-limit wait survives a restart.
 */
export interface ApiRetryState {
  kind: AgentApiErrorClass['kind'];
  /** 1-based attempt already scheduled. */
  attempt: number;
  /** Epoch ms when the retry timer should fire. */
  fireAt: number;
}

/**
 * @description Metadata riding an `output` event alongside the text.
 */
export interface OutputEventMeta {
  /**
   * True when this text directly continues the previous `output` emit of the
   * same in-flight response (a streaming tail cut mid-sentence, possibly
   * mid-word). The bot appends it to the message it is already rendering —
   * concatenated as-is, no separator — instead of starting a new message.
   * Absent/false = a standalone output (new logical message).
   */
  isContinuation?: boolean;
  /**
   * True when this `output` is the LAST frame of a turn (emitted as the session
   * goes idle). The bot flushes it promptly instead of waiting out the
   * possibly-429-stretched debounce, so the final message never lingers behind
   * a cooldown. Only affects flush TIMING — append/continuation semantics are
   * unchanged.
   */
  isFinal?: boolean;
}

/**
 * @description One option of a Claude CLI bare-digit survey (e.g. the periodic
 * session-feedback prompt: `1: Bad  2: Fine  3: Good  0: Dismiss`). The TUI
 * submits on the bare digit alone — no Enter — so `digit` is exactly the
 * keystroke to send.
 */
export interface ClaudeSurveyOption {
  /** The bare digit keystroke that selects this option (e.g. `'1'`, `'0'`). */
  digit: string;
  /** Human-readable label shown on the button (e.g. `'Bad'`, `'Dismiss'`). */
  label: string;
}

/**
 * @description Payload of the adapter `survey` event — a Claude CLI fixed-shape
 * bare-digit prompt the bot should render with tappable buttons. Distinct from
 * the OpenCode `question` event (a real AskUserQuestion); a survey is lighter
 * and answered by a single keystroke with NO Enter.
 */
export interface ClaudeSurveyEvent {
  /** The survey header line (e.g. `How is Claude doing this session?`). */
  header: string;
  /** Each selectable option, in display order. */
  options: ClaudeSurveyOption[];
}

/**
 * @description Per-call options for {@link AgentAdapter.sendInput}.
 */
export interface SendInputOptions {
  /**
   * Whether the adapter appends an Enter after the literal keystrokes. Defaults
   * to `true` so every existing caller is byte-for-byte unchanged. A Claude CLI
   * bare-digit survey auto-submits on the keypress, so the survey answer path
   * passes `false` to suppress the spurious Enter (which would otherwise submit
   * an empty prompt line after the survey resolved).
   */
  appendEnter?: boolean;
}

/**
 * @description Unified interface for AI agent backends (Claude CLI, OpenCode, etc.).
 * Each adapter manages sessions keyed by `ThreadKey` and communicates via EventEmitter.
 *
 * Events emitted (all carry the `ThreadKey` as the first argument):
 * - 'output'   (key: ThreadKey, text: string, meta?: OutputEventMeta) — permanent text response
 * - 'status'   (key: ThreadKey, text: string)   — transient status (tool calls, thinking); shown as editable message
 * - 'question' (key: ThreadKey, question: { requestId: string, questions: QuestionInfo[] }) — interactive question for user
 * - 'survey'   (key: ThreadKey, survey: ClaudeSurveyEvent) — Claude CLI bare-digit survey to render with answerable buttons
 * - 'apiError' (key: ThreadKey, error: AgentApiErrorClass) — provider-side API error at the proxy boundary (auto-retry trigger; only when {@link AgentApiErrorClass} classification matched)
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

  /**
   * @description Whether the session bound to `key` is mid-turn (an in-progress
   * reply). `false` when there is no session or it is idle. Sync and read from
   * in-memory state only (no tmux/HTTP call) so a caller can poll it cheaply —
   * the scheduler's wait-for-idle loop polls this before forwarding a scheduled
   * prompt, so a fire never interrupts live work.
   *
   * Per-backend signal:
   *  - **Claude** — the same pane busy marker `interruptAndWaitIdle` polls
   *    (`esc to interrupt` footer), evaluated against the session's last cached
   *    capture.
   *  - **OpenCode** — the in-flight response state tracked from SSE (own
   *    generation running, a sub-agent running, or context compacting).
   *
   * Optional (optional-method pattern, like {@link setModel}): adapters that
   * can't report busy-ness omit it and a caller treats the session as never
   * busy.
   */
  checkIsBusy?(key: ThreadKey): boolean;

  // — Input —

  sendInput(key: ThreadKey, input: string, options?: SendInputOptions): void;
  sendSignal(key: ThreadKey, signal: string): void;

  // — Session history —

  /**
   * List resumable sessions for this `key`. `workDir` is supplied by the
   * bot from the thread's binding because a thread may have NO live
   * adapter session when listing (e.g. right after a restart, or to pick
   * up a conversation started by hand on the laptop), so the folder can't
   * be inferred from adapter state. Claude reads real
   * `~/.claude/projects/<cwd>/*.jsonl` transcripts filtered to `workDir`;
   * OpenCode ignores `workDir` (its server API exposes no folder field).
   */
  getSessions(key: ThreadKey, workDir: string): Promise<AgentSession[]>;
  /**
   * Rename the CURRENT live session bound to `key` to `title`. Same
   * convention as {@link setModel}: resolves to `null` on success, or a
   * short user-facing error string on failure.
   *
   * Optional (optional-method pattern, like {@link setModel}): only backends
   * with a real session-title concept implement it. OpenCode does
   * (`PATCH /session/:id { title }`); Claude does NOT — its transcripts have
   * no title — so the bot replies "not supported" for adapters lacking it.
   *
   * A manual rename is final: it must suppress any later automatic title
   * overwrite (OpenCode's bot-side auto-name fallback).
   */
  renameSession?(key: ThreadKey, title: string): Promise<string | null>;

  /**
   * Resume an existing backend session under this `key` and `workDir`.
   *
   * `workDir` is now a required argument: the adapter cannot infer it after
   * a bot restart, and silently falling back to `process.env.WORK_DIR` was a
   * source of mis-routing in the old single-folder architecture (plan §10.3,
   * fix to openCodeAdapter.ts:599).
   *
   * `options.isWithRecentContext` posts the short "↩️ Resumed — last N
   * messages" context block. ONLY the explicit user resume (`/sessions` pick)
   * sets it: the same method also runs on silent re-attach after every bot
   * restart (hot reload) and on opencode crash-recovery, and posting the
   * block there spammed every active topic on every rebuild.
   */
  resumeSession(key: ThreadKey, workDir: string, sessionId: string, options?: ResumeSessionOptions): Promise<void>;

  /**
   * @description Read the last `limit` conversational turns (user/assistant
   * messages with renderable text, oldest→newest) of `sessionId` from the
   * backend's own transcript — Claude reads its `.jsonl`, OpenCode calls
   * `GET /session/:id/message`. Optional (optional-method pattern, like
   * {@link setModel}): adapters that can't cheaply read history omit it and
   * the resume context block is simply skipped. The result is already capped
   * to `limit`; an empty array means no renderable turns (brand-new / pruned
   * session). Used by `resumeSession` to post the short resume context block.
   */
  getRecentTurns?(key: ThreadKey, workDir: string, sessionId: string, limit: number): Promise<RecentTurn[]>;

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

  // — Reasoning-effort selection (per-thread, per-backend) —

  /**
   * Set the reasoning-effort level for this thread. Same convention as
   * {@link setModel}: returns `null` on success, a short user-facing
   * message on failure / notice (e.g. "level X is not valid for model Y").
   *
   * Per-backend semantics:
   *
   * - **Claude** applies immediately by writing `/effort <level>` into the
   *   running TUI; the value is also stored for menu/banner display.
   * - **OpenCode** persists the choice but does NOT mutate the live session
   *   here — the level (a model variant) is applied **per-prompt** inside the
   *   adapter's prompt-send path, sent as `body.variant` alongside the model
   *   override (no separate request, no env configuration).
   */
  setEffort?(key: ThreadKey, level: string): Promise<string | null>;

  /**
   * Currently selected reasoning-effort level for this thread, or `null`
   * if none has been chosen (adapter default in effect). Mirrors
   * {@link getCurrentModel}'s sync read pattern.
   */
  getEffort?(key: ThreadKey): string | null;

  /**
   * Levels valid for the thread's current backend + model. Returns an
   * empty array when the adapter has no opinion on effort (e.g. an OpenCode
   * model that declares no `variants`) — the caller surfaces a "not
   * supported" notice instead of an empty picker.
   *
   * Async because OpenCode needs to query `/config/providers`; Claude
   * resolves locally and just wraps the canonical list in `Promise.resolve`.
   */
  getAvailableEffortLevels?(key: ThreadKey): Promise<string[]>;

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

  /**
   * @description Interrupt the current turn and resolve only once the agent is
   * idle again, so the caller can forward a fresh prompt without it being
   * queued behind the running turn. Implement it ONLY when the backend ignores
   * queued input while busy: Claude's TUI does (Escape — which also cancels an
   * on-screen selector — then a poll until the busy state clears). OpenCode
   * deliberately does NOT implement it — `prompt_async` queues the new prompt
   * and the turn picks it up quickly, so aborting live work would only lose it
   * (user decision 2026-06-06). Adapters without the method forward directly.
   */
  interruptAndWaitIdle?(key: ThreadKey): Promise<void>;

  /**
   * @description Whether an interactive selector/question is currently on the
   * TUI screen. Lets the bot decide whether a short reply (a bare option
   * number or y/n) should DRIVE the selector, versus a free-form message that
   * should break out of it (Escape + send as a fresh instruction).
   */
  isQuestionPending?(key: ThreadKey): boolean;

  /**
   * @description Whether a Claude CLI bare-digit survey (the periodic
   * session-feedback prompt) is currently on the TUI screen. Distinct from
   * {@link isQuestionPending} (a real AskUserQuestion selector). A real
   * question takes PRECEDENCE: when both could match, the bot treats the reply
   * as a selector answer, not a survey answer. Only Claude implements it.
   */
  isSurveyPending?(key: ThreadKey): boolean;

  getFullOutput?(key: ThreadKey, lines?: number): string | null;
}
