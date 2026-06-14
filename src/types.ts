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
 * All fields are serialisable, so the whole record is persisted to `state.json`
 * and restored at boot for threads whose session reattached — re-arming the
 * existing buttons so a restart no longer hangs the agent.
 *
 * Sequential multi-question: when the agent asks more than one question in a
 * turn, the bot shows them ONE AT A TIME and collects the answers locally,
 * replying to the agent only once EVERY question is answered (OpenCode's reply
 * API takes the whole answer matrix at once). The progress lives here so it
 * survives a restart:
 *  - `answers` — one slot per question (same order as `data.questions`), `null`
 *    until that question is answered, then the chosen labels/text;
 *  - `currentIndex` — which question is currently on screen;
 *  - `messageId` — the Telegram message id of the CURRENTLY shown question.
 */
export interface PendingQuestionState {
  data: OpenCodePendingQuestion;
  messageId: number | null;
  /** One slot per question (null = unanswered). Length === questions.length. */
  answers: (string[] | null)[];
  /** Index into `data.questions` of the question currently on screen. */
  currentIndex: number;
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
 * @description THE unified verbosity vocabulary for every per-thread display
 * preference (`/thinking`, `/tool_results`, `/subagent`). Per-thread, persisted
 * (see `state.ts` `displayPrefs`). A bot-RENDERING concern only — it never
 * changes what is sent to the agent. Default for every pref is `minimal`.
 *
 * Per-command semantics (the live "working" indicators show in ALL modes;
 * the mode only controls what REMAINS in the topic):
 *
 * - thinking:
 *   - `full`    → the full reasoning text streams in and STAYS after the answer.
 *   - `short`   → live "thinking …" while reasoning, then collapses to a single
 *                 "thought for {N}s" line that STAYS.
 *   - `minimal` → live "thinking …" shown, but REMOVED once the answer starts.
 * - toolResults:
 *   - `full`    → the tool result is rendered in full, fenced.
 *   - `short`   → the result is truncated to a cap (lines + chars) with a footer.
 *   - `minimal` → only the transient "🔧 …" status, no result body.
 * - subagent (OpenCode: child session; Claude: Task-tool child, tailed from its
 *   on-disk transcript) — the "working" indicator is NEVER hidden (locked):
 *   - `full`    → child TEXT is additionally streamed, each chunk marked as
 *                 sub-agent.
 *   - `short`   → child transcript is NOT streamed (OpenCode shows a single live
 *                 "🤖 sub-agent: <title> …" status; Claude's own ◯ task-panel
 *                 line rolls inside the coalesced status frame).
 *   - `minimal` → v1: EXACTLY the same as `short` (status-only) — accepted so
 *                 the vocabulary stays uniform across the three commands.
 *
 * Old persisted/typed names (`detailed`/`brief`/`hide`/`compact`) are mapped
 * to this vocabulary at read/parse time — see
 * `utils/displayVerbosity.normalizeDisplayVerbosityMode`.
 */
export type DisplayVerbosityMode = 'minimal' | 'short' | 'full';

/**
 * @description Reader for a thread's FULL resolved display preferences, injected
 * into BOTH adapters at boot (`createAdapter.registerDisplayPrefsReader`, S4).
 * Generalises the former single-pref `SubagentModeReader`: the adapters now need
 * more than the sub-agent mode at PRODUCE time — Claude's relay classifies each
 * scraped chunk and routes tool / panel segments per the `toolResults` pref too
 * (S4), so one reader returning every pref is wired instead of N parallel
 * injections. The sub-agent branch still derives `.subagent` from it.
 *
 * Why a live read (not the bot's render-time resolution used for thinking /
 * tool-result OpenCode events): OpenCode branches a child part on its SSE hot
 * path (compact refreshes a status, full streams into a separate child
 * accumulator) and Claude's poll loop decides whether to read + relay tool
 * bodies — both are adapter-side decisions that cannot be deferred. Until
 * registered, both adapters fall back to all-fields-`minimal`.
 */
export type DisplayPrefsReader = (key: ThreadKey) => ResolvedThreadDisplayPrefs;

/**
 * @description Per-thread bot-rendering preferences for agent output
 * verbosity. Each field is optional: an absent field means "use the locked
 * default" (`minimal` for all three), so the persisted record only stores
 * non-default overrides — keeping `state.json` clean (same
 * delete-when-default idiom as the `/trace` toggle).
 *
 * On disk a field may still hold a LEGACY mode name
 * (`detailed`/`brief`/`hide`/`compact`) written before the vocabulary was
 * unified; `state.ts`'s `getDisplayPrefs` normalizes those at read time, so
 * the declared {@link DisplayVerbosityMode} type holds for every consumer.
 *
 * These are bot-side rendering concerns, NOT agent behavior: they live in
 * `state.json` per-thread (NOT the adapter pref files) and do not change what
 * is sent to the agent.
 */
export interface ThreadDisplayPrefs {
  thinking?: DisplayVerbosityMode;
  toolResults?: DisplayVerbosityMode;
  subagent?: DisplayVerbosityMode;
}

/**
 * @description Fully-resolved per-thread display preferences — every field is
 * present because the locked default is applied when the persisted record omits
 * it. Returned by the state store's getter so callers on the hot path never have
 * to re-apply defaults themselves.
 */
export interface ResolvedThreadDisplayPrefs {
  thinking: DisplayVerbosityMode;
  toolResults: DisplayVerbosityMode;
  subagent: DisplayVerbosityMode;
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
  /**
   * True when this `output` is a COMPLETE one-shot block, whole at emit time
   * (e.g. the "↩️ Resumed — last N messages" context block) rather than a live
   * streaming tail. The bot posts it instantly as a single message: in DM mode
   * it SKIPS the native draft channel (whose typing animation would otherwise
   * "draw" already-ready text progressively), and flushes the persist
   * immediately (like {@link OutputEventMeta.isFinal}) instead of waiting out
   * the debounce.
   */
  isComplete?: boolean;
  /**
   * True when this text comes from a SUB-AGENT (OpenCode: child session SSE;
   * Claude: on-disk transcript tail), only emitted in `/subagent full` mode.
   * The bot renders the chunk visibly marked ("🤖 ⤷ …") and OUTSIDE the parent
   * reply's edit-in-place continuation chain — a child transcript must never
   * become the base the parent's next continuation is appended to (it would
   * corrupt the answer's accounting).
   */
  isSubagent?: boolean;
}

/**
 * @description Lifecycle phase of a {@link ThinkingEvent}.
 *
 * - `live` → the agent is actively reasoning; the bot shows the live
 *   "thinking …" indicator (and, in `full` mode, the accumulated text).
 * - `done` → reasoning ended for this response; `durationMs` is how long it
 *   took, used to render the collapsed "thought for {N}s" line in `short` mode.
 */
export type ThinkingPhase = 'live' | 'done';

/**
 * @description Payload of the adapter `thinking` event — a chain-of-thought
 * lifecycle signal for ONE response. Emitted on a DEDICATED channel (not the
 * generic `status` coalescer) so the thinking indicator can persist
 * independently of transient tool status.
 *
 * The adapter stays MODE-AGNOSTIC: it emits the raw accumulated reasoning text
 * and the phase, and the BOT applies the per-thread thinking
 * {@link DisplayVerbosityMode} (which controls only what remains AFTER
 * reasoning ends). Reasoning text is kept SEPARATE from the answer accumulator
 * and never leaks into `output`.
 */
export interface ThinkingEvent {
  /** Lifecycle phase of this emit. */
  phase: ThinkingPhase;
  /**
   * Reasoning text accumulated so far for this response. Grows across `live`
   * emits; carried on `done` too so a late-arriving `full`-mode render has
   * the full text. Empty until the first reasoning delta produces content.
   */
  text: string;
  /**
   * How long reasoning took, in ms. Present only on the `done` phase — the bot
   * formats it into the collapsed "thought for {N}s" line for `short` mode.
   */
  durationMs?: number;
}

/**
 * @description Payload of the adapter `toolResult` event — a completed tool
 * call's OUTPUT for one response (S3). Emitted on a DEDICATED channel so the
 * result is rendered as its own message and never pollutes the answer
 * accumulator (`currentResponseText`) or its continuation accounting.
 *
 * The adapter stays MODE-AGNOSTIC: it emits every completed tool output once,
 * and the BOT applies the per-thread tool-results {@link DisplayVerbosityMode}
 * (`minimal` drops it, `short` truncates, `full` renders the whole body).
 */
export interface ToolResultEvent {
  /** Tool name as reported by the tool part (e.g. `bash`, `read`). */
  tool: string;
  /** Human-readable title from the tool state (e.g. the command description),
   * when the backend provided one. */
  title?: string;
  /** The tool's output body, untruncated. Non-empty by adapter contract. */
  output: string;
}

/**
 * @description Payload of the adapter `subagentStatus` event — the lifecycle of
 * a single OpenCode delegation (sub-agent) for the `minimal`/`short`
 * `/subagent` modes. Emitted on a DEDICATED channel (not the generic `status`
 * coalescer) so the "working" indicator gets its OWN message + ticking elapsed
 * timer in the bot, edited in place, instead of riding the shared transient
 * status (which re-`sendMessage`d a new message on every child-text burst — the
 * flood bug). `/subagent full` does NOT use this event (the streamed child
 * transcript IS the indicator there).
 *
 * The adapter stays MODE-AGNOSTIC about presentation: it only signals whether a
 * delegation is in flight (`active`) and the current sticky title; the BOT owns
 * the message lifecycle and the elapsed counter.
 */
export interface SubagentStatusEvent {
  /**
   * `true` = a delegation is in flight (start / keep-alive / title refresh) →
   * the bot opens or refreshes the dedicated status message.
   * `false` = the delegation ended → the bot removes the message.
   */
  active: boolean;
  /**
   * The delegation's sticky title (last non-null one seen for this run), or
   * `null` when the `task` part never carried a title/description — the bot
   * falls back to the localized generic label.
   */
  title: string | null;
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
 * - 'thinking' (key: ThreadKey, payload: ThinkingEvent) — chain-of-thought lifecycle (OpenCode); the bot applies the per-thread thinking {@link DisplayVerbosityMode}
 * - 'toolResult' (key: ThreadKey, payload: ToolResultEvent) — a completed tool call's output (OpenCode); the bot applies the per-thread tool-results {@link DisplayVerbosityMode}
 * - 'subagentStatus' (key: ThreadKey, payload: SubagentStatusEvent) — OpenCode delegation lifecycle for `minimal`/`short` `/subagent` modes; the bot owns a dedicated self-updating status message with a ticking elapsed timer
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

  /**
   * @description Whether this session's turn is wedged behind an open
   * interactive question (the agent's `question` tool is blocking the turn and
   * the bot has no `pendingQuestions` entry to break out with). OpenCode-only:
   * a queued `prompt_async` would sit behind the dead turn forever, so the bot
   * aborts the turn before forwarding a fresh prompt. The check is strict —
   * `true` only when the server reports an open question for THIS session, so a
   * genuinely streaming turn / live sub-agent is never reported wedged (and the
   * normal queue-and-pick-up behaviour is preserved). Async because the
   * authoritative signal is `GET /question` on the owning instance.
   */
  checkIsWedgedOnQuestion?(key: ThreadKey): Promise<boolean>;

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
  sendEscape?(key: ThreadKey): void;

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

  /**
   * @description Whether Claude's `/login` OAuth "Paste code here" box is on
   * the TUI screen. While it is, the bot routes ANY text reply verbatim into
   * the box (the pasted code is a long free-form string, not a control reply),
   * skipping the prompt path whose Escape would cancel the login and whose
   * preamble would corrupt the code. Only Claude implements it.
   */
  isLoginPastePending?(key: ThreadKey): boolean;

  getFullOutput?(key: ThreadKey, lines?: number): string | null;
}
