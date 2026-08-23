import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import type {
  AgentAdapter,
  AgentSession,
  AgentRuntimeInfo,
  DisplayPrefsReader,
  JsonStreamTailOffset,
  JsonStreamTailWriter,
  OpenCodeQuestion,
  OutputEventMeta,
  RecentTurn,
  ReattachRecap,
  ResolvedThreadDisplayPrefs,
  ResumeSessionOptions,
  SeenWatermark,
  SeenWatermarkWriter,
  ThreadKey,
} from '../types';
import { keyToString } from '../types';
import type { OpenCodePendingQuestion } from './openCodeAdapter';
import { classifyAgentApiError } from '../apiErrorRetry';
import { checkIsInstalled, installTool } from '../installManager';
import { prepareMcpFlags, cleanupMcpTempFiles } from '../mcpConfig';
import { resolveDataDir } from '../state';
import { resolveClaudeBinary } from '../utils/resolveBinary';
import { t } from '../i18n';
import { formatResumeContext, resumeContextTurnLimit } from '../resumeContext';
import { getClaudeAvailableLevels, checkIsClaudeEffortLevel, defaultEffortLevel } from '../effortLevels';
import {
  checkIsValidUuid,
  getClaudeProjectsRoot,
  getClaudeTranscriptPath,
  listClaudeSessionsForWorkDir,
  readRecentClaudeTurns,
  readClaudeReattachTranscript,
  loadEffortPrefs,
  saveEffortPref,
} from './claudeCliAdapter';
import {
  ClaudeStreamLineReader,
  checkIsStreamRecord,
  parseStreamJsonLine,
  classifyClaudeStreamMessage,
  buildCanUseToolAllow,
  buildCanUseToolDeny,
  type ClaudeStreamAction,
} from '../utils/claudeStreamJson';
import { execFilePromise, tmuxAsync, tmuxOrThrowAsync } from '../utils/tmuxExec';
import { basePollIntervalMs, getNextPollDelay } from '../utils/pollBackoff';
import { readClaudeRuntimeInfo } from '../utils/claudeRuntimeInfo';
import { busyIdleWatchdogMs, checkShouldClearBusyOnIdle } from '../utils/jsonStreamBusyWatchdog';
import {
  buildJsonStreamTmuxSessionName,
  buildWrapperScript,
  checkIsPidAlive,
  createStdoutTailState,
  decodeStdoutTailChunk,
  getFileSize,
  getJsonStreamSessionPaths,
  getStdoutLineBoundaryOffset,
  getStdoutTailDecision,
  openFifoWriterNonBlocking,
  parseJsonStreamTmuxSessionName,
  readExitCodeFile,
  readFileByteRange,
  readPidFile,
  readStderrTail,
  resolveJsonStreamSessionDir,
  stdoutOversizeWarnBytes,
  waitForPidFile,
  writeFifoText,
  type JsonStreamSessionPaths,
  type StdoutTailState,
} from '../utils/jsonStreamHost';

/** Adapter name (the `state.agents[key].name` value + factory key). */
export const claudeJsonStreamAdapterName = 'claude-json-stream';

/**
 * @description Coalesce window for streamed answer/thinking deltas before an
 * `output`/`thinking` emit — the CLI streams per-token, so raw per-delta emits
 * would flood Telegram with edits. Mirrors OpenCode's `sseOutputBatchMs` (500).
 */
const streamOutputBatchMs = 350;

/** How long to wait for the `initialize` control-response handshake before
 *  proceeding without the interactive control channel (questions unavailable). */
const initializeHandshakeTimeoutMs = 15000;

/** The pending answer to a live AskUserQuestion control_request. */
interface PendingStreamQuestion {
  /** The control_request `request_id` the control_response must echo. */
  requestId: string;
  /** The AskUserQuestion `tool_use_id` (echoed as `toolUseID`). */
  toolUseId: string;
  /** The raw `input` (`{questions:[…]}`) — passed back verbatim + `answers`. */
  rawInput: Record<string, unknown>;
  /** The parsed questions (order matches the answer matrix). */
  questions: OpenCodeQuestion[];
}

interface StreamSession {
  key: ThreadKey;
  workDir: string;
  /** The `--session-id` UUID (== Claude on-disk transcript id, shared with the
   *  tmux backend's `claudeSessionId`). */
  sessionId: string;
  // — external process transport (plan 2026-07-05-jsonstream-restart-isolation:
  //   claude is tmux-hosted, NOT a bot child, so bot restarts never touch it) —
  /** pid of the external claude process (from the wrapper's `pid` file). */
  pid: number;
  /** Host-file layout (stdin fifo / stdout log / pid / exitcode / …). */
  paths: JsonStreamSessionPaths;
  /** Non-blocking write fd on the stdin FIFO. */
  fifoFd: number;
  /** Serialises FIFO writes so control frames and user turns keep wire order. */
  stdinWriteChain: Promise<void>;
  /** `stdout.jsonl` tail bookkeeping (byte offsets + stateful utf8 decode). */
  tail: StdoutTailState;
  pollTimer: NodeJS.Timeout | null;
  pollDelayMs: number;
  unchangedStreak: number;
  /** One-shot oversize warning (no stdout rotation in v1 — locked decision). */
  isOversizeWarned: boolean;
  /** Last line-boundary offset handed to the tail writer (monotonic guard). */
  lastPersistedTailOffset: number;
  reader: ClaudeStreamLineReader;
  isActive: boolean;
  /** True between an explicit stop and process exit → emit `stopped` not `closed`. */
  isStopping: boolean;
  /** True while re-spawning for a model/effort change → suppress closed/stopped. */
  isRespawning: boolean;
  /** True from a user turn sent until its `result` → drives `checkIsBusy`. */
  isBusy: boolean;
  /** `Date.now()` of the last consumed stdout byte / turn-start kick. Feeds the
   *  idle watchdog (`utils/jsonStreamBusyWatchdog`): stdout silence with nothing
   *  in flight is how a stuck-busy session (a missed terminal `result`) is
   *  detected and cleared, so the typing indicator can't hang for an hour. */
  lastStdoutActivityAt: number;
  /** `tool_use` ids started but whose `tool_result` hasn't returned. A non-empty
   *  set means the agent is legitimately waiting on a tool (possibly silent, e.g.
   *  a long Bash) → the idle watchdog must NOT clear busy. */
  outstandingToolUseIds: Set<string>;
  /** The model PINNED by an explicit `/model` pick — the `--model` spawn flag,
   *  replayed verbatim on every effort/model re-spawn. `null` means "no pick,
   *  claude runs its own default", so it must NOT be overwritten with the
   *  resolved live id (that would silently pin the session to one snapshot). */
  model: string | null;
  /** The model claude itself reports in `system/init` (the resolved id, e.g.
   *  `claude-opus-4-5-20251101`) — the only source of the LIVE model when no
   *  explicit pick was made, which is every default start, every resume, and
   *  every boot-time adopt. Read by {@link ClaudeJsonStreamAdapter.getCurrentModel}
   *  so `/status` and the pinned banner can name the running model at all. */
  reportedModel: string | null;
  effort: string | null;
  // — answer accumulation —
  currentResponseText: string;
  emittedLength: number;
  outputTimer: NodeJS.Timeout | null;
  // — reasoning —
  reasoningText: string;
  reasoningStartedAt: number | null;
  reasoningTimer: NodeJS.Timeout | null;
  reasoningActive: boolean;
  // — tools —
  toolNamesById: Map<string, string>;
  /** AskUserQuestion `tool_use_id`s — their tool_result is the internal
   *  "questions have been answered" echo, never rendered as a tool result. */
  questionToolUseIds: Set<string>;
  // — sub-agent (v1: status-only in non-full; streamed text in full) —
  subagentActive: boolean;
  childResponseText: string;
  childEmittedLength: number;
  childOutputTimer: NodeJS.Timeout | null;
  // — control channel —
  pendingInitResolve: (() => void) | null;
  initRequestId: string | null;
  // — question —
  pendingQuestion: PendingStreamQuestion | null;
  // — api error one-shot guard (re-armed on recovery) —
  apiErrorFired: boolean;
  /**
   * One-shot: swallow the NEXT terminal `result{is_error}` because it is the
   * direct consequence of an interrupt WE issued (`sendInterrupt`), not a real
   * provider error. Without it a user-initiated abort — a `/esc`, or the
   * question-cancel path's SIGINT — surfaces the CLI's contentless error result
   * as a bogus "Claude error: API error" line (`claudeStreamJson` falls back to
   * the literal `'API error'` for an `is_error` result carrying no text).
   * Consumed by the first `handleTurnEnd` after the interrupt.
   */
  swallowNextAbortError: boolean;
  /** Last transcript byte offset persisted as the seen-watermark (S7 monotonic
   *  guard). `-1` until the first advance so a never-advanced session writes on
   *  its first relayed message. */
  lastWatermarkOffset: number;
}

/**
 * @description SECOND Claude backend: drives the `claude` CLI over its
 * documented `--input-format stream-json --output-format stream-json` protocol
 * (typed events, no TUI scrape) as an EXTERNAL tmux-hosted process per
 * {@link ThreadKey} (plan 2026-07-05-jsonstream-restart-isolation): a `#!/bin/sh`
 * wrapper backgrounds claude with stdin on a FIFO the process itself holds
 * `0<>` and stdout appended to a `stdout.jsonl` the adapter TAILS — so a bot
 * restart (every hot reload) neither EOFs claude's stdin nor loses its output;
 * the restarted bot re-adopts the tmux session and replays the missed tail.
 * Same structured events, on the SAME subscription billing (proven
 * `apiKeySource:"none"` + `seven_day` rate-limit event; the wrapper runs
 * `env -u ANTHROPIC_API_KEY`, never `--bare`).
 *
 * Structural template is {@link import('./openCodeAdapter').OpenCodeAdapter}
 * (event-driven, own process, per-key session map); the Claude on-disk
 * transcript readers are reused for `/sessions` / resume / recap.
 *
 * Interactive questions (`AskUserQuestion`) reach Telegram through the same
 * `question` event + pin flow as OpenCode: the CLI surfaces them as a
 * `control_request` (`subtype:"can_use_tool"`, `tool_name:"AskUserQuestion"`)
 * on stdout, answered with a `control_response` carrying
 * `updatedInput.answers` on stdin — a wire protocol reverse-engineered from a
 * live capture + the open-source `@anthropic-ai/claude-agent-sdk`. Ordinary
 * tool permissions are auto-allowed (operator trusts their own agent — parity
 * with the tmux backend's `bypassPermissions`), so only questions block.
 *
 * A topic flips between it and the tmux-scrape backend via `/claude_mode`
 * (they share the on-disk transcript, so the switch resumes the same
 * conversation). The DEFAULT Claude backend (`getDefaultClaudeBackendName`):
 * `/login` is handled out-of-band by the bot (`claude auth login` in a pty),
 * so it no longer needs a TUI to sign in.
 */
export class ClaudeJsonStreamAdapter extends EventEmitter implements AgentAdapter {
  readonly name = claudeJsonStreamAdapterName;
  readonly label = 'Claude Code (stream)';
  /** Emits incremental text deltas (like the tmux scrape) → the transports
   *  synthesise continuation (`getDmDraftContinuation` / group delta path). */
  readonly outputsDeltas = true;
  /** No TUI banner → keep the bot's `agent.ready` cue + one-shot boot ping (L2). */
  readonly selfGreetsOnStart = false;

  private readonly sessions = new Map<string, StreamSession>();
  private readonly claudePath = resolveClaudeBinary();

  private displayPrefsReader: DisplayPrefsReader | null = null;
  private seenWatermarkWriter: SeenWatermarkWriter | null = null;
  private jsonStreamTailWriter: JsonStreamTailWriter | null = null;
  /** In-flight explicit stops, per key — a second stop (or a start's implicit
   *  stop) AWAITS the first instead of racing it: the delayed first
   *  `tmux kill-session` could otherwise land AFTER a fresh same-name spawn
   *  and kill the new session. */
  private readonly stopsInFlight = new Map<string, Promise<void>>();

  setDisplayPrefsReader(reader: DisplayPrefsReader): void {
    this.displayPrefsReader = reader;
  }

  setSeenWatermarkWriter(writer: SeenWatermarkWriter): void {
    this.seenWatermarkWriter = writer;
  }

  setJsonStreamTailWriter(writer: JsonStreamTailWriter): void {
    this.jsonStreamTailWriter = writer;
  }

  private getDisplayPrefs(key: ThreadKey): ResolvedThreadDisplayPrefs {
    return this.displayPrefsReader?.(key) ?? { thinking: 'minimal', toolResults: 'minimal', subagent: 'minimal' };
  }

  private advanceSeenWatermark(key: ThreadKey, watermark: SeenWatermark): void {
    this.seenWatermarkWriter?.(key, watermark);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Lifecycle (S1)
  // ─────────────────────────────────────────────────────────────────────────

  async startSession(key: ThreadKey, workDir: string, _args?: string, sessionId?: string): Promise<void> {
    await this.stopSessionInternal(key);
    const id = sessionId && checkIsValidUuid(sessionId) ? sessionId : randomUUID();
    const effort = this.getEffort(key) ?? defaultEffortLevel;
    await this.spawnSession(key, workDir, id, { effort, model: null, resume: false });
  }

  async resumeSession(key: ThreadKey, workDir: string, sessionId: string, options?: ResumeSessionOptions): Promise<void> {
    await this.stopSessionInternal(key);
    if (!checkIsValidUuid(sessionId)) throw new Error(`Invalid sessionId: ${sessionId}`);
    const effort = this.getEffort(key) ?? defaultEffortLevel;
    await this.spawnSession(key, workDir, sessionId, { effort, model: null, resume: true });

    // Post the short last-N-turn context block ONLY on the explicit user resume
    // (`/sessions` pick) — a silent re-attach stays quiet (ResumeSessionOptions).
    if (options?.isWithRecentContext) {
      try {
        const turns = await this.getRecentTurns(key, workDir, sessionId, resumeContextTurnLimit);
        const rendered = formatResumeContext(turns);
        if (rendered) this.emit('output', key, rendered, { isComplete: true } satisfies OutputEventMeta);
      } catch (e) {
        console.warn(`[ClaudeJson] resume context block failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  /**
   * @description Spawn (or re-spawn) the CLI process for a thread as an
   * EXTERNAL tmux-hosted process (wrapper + FIFO stdin + stdout file — the
   * probe-proven layout in `utils/jsonStreamHost.ts`), start the stdout tail
   * poller, and complete the `initialize` control handshake (which enables the
   * `AskUserQuestion` control channel). Rejects — with the wrapper's exit code
   * and a stderr excerpt — if the process fails to come up. Reused by start /
   * resume / effort-respawn.
   */
  private async spawnSession(
    key: ThreadKey,
    workDir: string,
    sessionId: string,
    opts: { effort: string | null; model: string | null; resume: boolean },
  ): Promise<void> {
    if (!checkIsInstalled('claude')) {
      this.emit('output', key, 'Installing Claude Code...');
      await installTool('claude');
    }

    const mcpFlags = await prepareMcpFlags({ key, dataDir: resolveDataDir() });
    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--replay-user-messages',
      // Bypass ALL permission checks (tmux-backend parity) so the operator's own
      // agent never stalls on a permission prompt. `--dangerously-skip-permissions`
      // + `bypassPermissions` means regular tools (Bash/Read/…) never route through
      // the stdio prompt tool at all. `--permission-prompt-tool stdio` STAYS: it is
      // what keeps `AskUserQuestion` in the tool list AND still routes it through the
      // control channel even under bypass (verified live on v2.1.201 — bypass does
      // NOT suppress AskUserQuestion, and `apiKeySource` stays `none`). The residual
      // circuit-breakers claude never bypasses (`rm -rf /`, `rm -rf ~`) still arrive
      // as `can_use_tool` and are answered by the generic auto-allow below.
      '--dangerously-skip-permissions',
      '--permission-mode', 'bypassPermissions',
      '--permission-prompt-tool', 'stdio',
    ];
    if (opts.resume) args.push('--resume', sessionId);
    else args.push('--session-id', sessionId);
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    args.push(...mcpFlags);

    // Subscription billing: the wrapper runs `env -u ANTHROPIC_API_KEY` (a set
    // key would meter the API). The CLI reads the OAuth login from ~/.claude —
    // `apiKeySource:"none"` (probe-verified under the wrapper).
    const sessionDir = resolveJsonStreamSessionDir(resolveDataDir(), key);
    const paths = getJsonStreamSessionPaths(sessionDir);
    const tmuxName = buildJsonStreamTmuxSessionName(key);
    console.log(`[ClaudeJson] spawn ${keyToString(key)} session=${sessionId} resume=${opts.resume} effort=${opts.effort} model=${opts.model ?? 'default'} (tmux ${tmuxName})`);

    let pid: number;
    let fifoFd: number;
    try {
      // Fresh host layout — a stale dir/fifo from a crashed run must not be reused.
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      await execFilePromise('mkfifo', [paths.stdinFifo]);
      fs.writeFileSync(paths.wrapperFile, buildWrapperScript(this.claudePath, args, workDir, paths), { mode: 0o755 });
      // A stale same-name tmux session (crashed bot / pre-adopt build) would make
      // `new-session` fail — and must not keep running unowned next to ours.
      await tmuxAsync('kill-session', '-t', tmuxName);
      await tmuxOrThrowAsync('new-session', '-d', '-s', tmuxName, paths.wrapperFile);
      const pidRead = await waitForPidFile(paths.pidFile);
      if (pidRead === null) throw new Error(`claude never wrote its pid file${describeSpawnFailure(paths)}`);
      pid = pidRead;
      const fdRead = await openFifoWriterNonBlocking(paths.stdinFifo);
      if (fdRead === null) throw new Error(`claude is not holding its stdin FIFO${describeSpawnFailure(paths)}`);
      fifoFd = fdRead;
    } catch (e) {
      cleanupMcpTempFiles({ key, dataDir: resolveDataDir() });
      await tmuxAsync('kill-session', '-t', tmuxName);
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      throw new Error(`Failed to start Claude stream session: ${e instanceof Error ? e.message : String(e)}`);
    }

    const session: StreamSession = {
      key, workDir, sessionId,
      pid, paths, fifoFd,
      stdinWriteChain: Promise.resolve(),
      tail: createStdoutTailState(0),
      pollTimer: null, pollDelayMs: basePollIntervalMs, unchangedStreak: 0,
      isOversizeWarned: false, lastPersistedTailOffset: 0,
      reader: new ClaudeStreamLineReader(),
      isActive: true, isStopping: false, isRespawning: false, isBusy: false,
      lastStdoutActivityAt: Date.now(), outstandingToolUseIds: new Set(),
      model: opts.model, reportedModel: null, effort: opts.effort,
      currentResponseText: '', emittedLength: 0, outputTimer: null,
      reasoningText: '', reasoningStartedAt: null, reasoningTimer: null, reasoningActive: false,
      toolNamesById: new Map(), questionToolUseIds: new Set(),
      subagentActive: false, childResponseText: '', childEmittedLength: 0, childOutputTimer: null,
      pendingInitResolve: null, initRequestId: null,
      pendingQuestion: null, apiErrorFired: false, swallowNextAbortError: false,
      lastWatermarkOffset: -1,
    };
    this.sessions.set(keyToString(key), session);
    // A fresh spawn starts a fresh stdout file — reset the persisted tail offset
    // so a later adopt never resumes from a previous run's position.
    this.jsonStreamTailWriter?.(key, { sessionId, offsetBytes: 0 });
    this.schedulePoll(session, basePollIntervalMs);

    // Initialize handshake: declares the interactive control channel (permission
    // prompts + AskUserQuestion route to stdio). Without it AskUserQuestion is not
    // even in the tool list (verified). Best-effort — proceed on timeout so a
    // handshake hiccup never blocks a plain-output session. The response arrives
    // through the tail poller started above.
    await this.performInitialize(session);

    this.emit('started', key);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  External-process transport: stdout tail poll + exit detection
  // ─────────────────────────────────────────────────────────────────────────

  /** Arm the next tail poll (single-flight `setTimeout` chain, mirroring the
   *  scrape backend's `schedulePoll` — never overlapping ticks). */
  private schedulePoll(session: StreamSession, delayMs: number): void {
    if (!session.isActive) return;
    if (session.pollTimer) clearTimeout(session.pollTimer);
    session.pollDelayMs = delayMs;
    session.pollTimer = setTimeout(() => {
      session.pollTimer = null;
      this.pollTailTick(session);
    }, delayMs);
  }

  /** Snap the tail cadence back to base — called on every stdin write, when
   *  fresh output is expected shortly (mirrors the scrape backend's write snap). */
  private snapPollToBase(session: StreamSession): void {
    if (!session.isActive) return;
    session.unchangedStreak = 0;
    this.schedulePoll(session, basePollIntervalMs);
  }

  private pollTailTick(session: StreamSession): void {
    if (!session.isActive || this.sessions.get(keyToString(session.key)) !== session) return;
    let isChanged = false;
    try {
      isChanged = this.drainStdoutTail(session);
    } catch (e) {
      console.warn(`[ClaudeJson] stdout tail read failed for ${keyToString(session.key)}:`, e instanceof Error ? e.message : e);
    }
    // Exit detection (locked decision): the wrapper writes `exitcode` when
    // claude exits; pid-alive covers a hard-killed wrapper that never wrote it.
    const exitCode = readExitCodeFile(session.paths.exitCodeFile);
    if (exitCode !== null || !checkIsPidAlive(session.pid)) {
      // Final drain — bytes flushed at process exit may postdate the read above.
      try { this.drainStdoutTail(session); } catch { /* already reported above */ }
      this.finalizeExternalExit(session, exitCode ?? readExitCodeFile(session.paths.exitCodeFile));
      return;
    }
    // Backstop: a busy session gone silent with nothing in flight lost its
    // terminal `result` — clear the stuck flag so the typing indicator can't hang.
    this.maybeClearBusyOnIdle(session);
    const next = getNextPollDelay({ isChanged, currentDelayMs: session.pollDelayMs, unchangedStreak: session.unchangedStreak });
    session.unchangedStreak = next.unchangedStreak;
    this.schedulePoll(session, next.delayMs);
  }

  /**
   * @description Idle watchdog (bounded safety net). `isBusy` is cleared in
   * exactly one place — a processed terminal `result` (`handleTurnEnd`) — so a
   * single missed `result` (an aborted `interrupt`, a process gone quiet after
   * the answer, a future CLI dropping the line) hangs the native typing
   * indicator indefinitely. When the session is busy but stdout has been silent
   * past {@link busyIdleWatchdogMs} and nothing is genuinely in flight, the turn
   * has really ended: clear the flag. The pure decision + its rationale live in
   * `utils/jsonStreamBusyWatchdog` — every in-flight signal (tool / sub-agent /
   * question / batched answer) vetoes the clear, so a legitimately long-running
   * turn is never truncated (a working agent never goes silent with nothing in
   * flight — it streams deltas or waits on a tool/sub-agent/user).
   */
  private maybeClearBusyOnIdle(session: StreamSession): void {
    const shouldClear = checkShouldClearBusyOnIdle({
      isBusy: session.isBusy,
      msSinceStdoutActivity: Date.now() - session.lastStdoutActivityAt,
      idleTimeoutMs: busyIdleWatchdogMs,
      outstandingToolCount: session.outstandingToolUseIds.size,
      subagentActive: session.subagentActive,
      hasPendingQuestion: session.pendingQuestion !== null,
      hasUnflushedAnswer: session.currentResponseText.length !== session.emittedLength,
    });
    if (!shouldClear) return;
    console.warn(`[ClaudeJson] busy-idle watchdog: ${keyToString(session.key)} idle ${busyIdleWatchdogMs}ms with nothing in flight — clearing stuck busy (missed terminal result?)`);
    session.isBusy = false;
    this.finishReasoning(session);
  }

  /**
   * @description Read whatever `stdout.jsonl` grew since the last poll and feed
   * it through the SAME decode → line-reader → classifier pipeline the stdio
   * pipe used to feed. Returns whether anything new was consumed (drives the
   * adaptive poll backoff). After consuming, persists the line-boundary tail
   * offset so a bot restart resumes exactly where processing stopped.
   */
  private drainStdoutTail(session: StreamSession): boolean {
    const size = getFileSize(session.paths.stdoutFile);
    if (size === null) return false; // not created yet (claude still booting)
    if (size > stdoutOversizeWarnBytes && !session.isOversizeWarned) {
      session.isOversizeWarned = true;
      console.warn(`[ClaudeJson] stdout log for ${keyToString(session.key)} exceeds ${stdoutOversizeWarnBytes} bytes (no rotation in v1)`);
    }
    const decision = getStdoutTailDecision(session.tail, size);
    if (decision.kind === 'reseed') {
      // External truncation — the retained partial line died with the old file.
      session.reader = new ClaudeStreamLineReader();
      return false;
    }
    if (decision.kind === 'none') return false;
    const chunk = readFileByteRange(session.paths.stdoutFile, decision.startOffset, decision.endOffset);
    if (chunk.length === 0) return false;
    const text = decodeStdoutTailChunk(session.tail, chunk);
    if (text) {
      // Any new stdout — even a `tool_progress` frame the classifier ignores —
      // means the process is alive and working; feed the idle watchdog's clock.
      session.lastStdoutActivityAt = Date.now();
      this.onStdout(session, text);
    }
    // Persist the consumption boundary ONLY when nothing sits in the answer /
    // child batchers: the offset means "everything before here has LEFT the
    // adapter", so text still waiting in a 350ms batch must hold it back —
    // otherwise a reload in that window skips the batched text on replay
    // (live seam-loss 2026-07-05 on topic 9085: lines 216–221 were consumed
    // into the batch, the offset moved past them, and the kill dropped them).
    // A deferred persist happens in `flushAnswer` / the child flush, right
    // after the batched text is emitted.
    if (checkIsEmitCaughtUp(session)) this.persistTailOffset(session);
    return true;
  }

  /** Persist the tail's line-boundary offset (monotonic; inert until the
   *  writer is registered — same idiom as the seen-watermark writer). */
  private persistTailOffset(session: StreamSession): void {
    const boundary = getStdoutLineBoundaryOffset(session.tail, session.reader.pending);
    if (boundary <= session.lastPersistedTailOffset) return;
    session.lastPersistedTailOffset = boundary;
    this.jsonStreamTailWriter?.(session.key, { sessionId: session.sessionId, offsetBytes: boundary });
  }

  /**
   * @description Single teardown convergence point for the external process —
   * both the explicit stop (`isStopping` → `stopped`) and the poll tick's exit
   * detection (→ `closed`, with the wrapper-reported exit code and a stderr
   * excerpt). Kills any tmux leftovers, removes the host dir, and cleans the
   * MCP temp files. A respawn owns its own transition (`isRespawning`).
   */
  private finalizeExternalExit(session: StreamSession, exitCode: number | null): void {
    if (session.isRespawning) return; // an effort/model re-spawn owns the transition
    const key = session.key;
    // Only act if this session is still the current one for the key.
    if (this.sessions.get(keyToString(key)) !== session) return;
    this.clearTimers(session);
    session.isActive = false;
    this.sessions.delete(keyToString(key));
    this.closeFifo(session);
    const stderrTail = session.isStopping ? '' : readStderrTail(session.paths.stderrFile);
    void tmuxAsync('kill-session', '-t', buildJsonStreamTmuxSessionName(key));
    try { fs.rmSync(session.paths.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    cleanupMcpTempFiles({ key, dataDir: resolveDataDir() });
    if (session.isStopping) {
      console.log(`[ClaudeJson] session ${keyToString(key)} stopped (code=${exitCode})`);
      this.emit('stopped', key);
    } else {
      console.warn(`[ClaudeJson] session ${keyToString(key)} exited unexpectedly (code=${exitCode})${stderrTail ? ` stderr: ${stderrTail}` : ''}`);
      this.emit('closed', key);
    }
  }

  /** Close the FIFO fd AFTER any queued writes settle, so an in-flight write
   *  never hits a closed fd (EBADF noise on every stop). */
  private closeFifo(session: StreamSession): void {
    const fd = session.fifoFd;
    session.stdinWriteChain = session.stdinWriteChain
      .catch(() => { /* write failures were already logged */ })
      .then(() => { try { fs.closeSync(fd); } catch { /* already closed */ } });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Reattach at boot (S3) — adopt the external process, resume the tail
  // ─────────────────────────────────────────────────────────────────────────

  /** Scan tmux for `cjson-…` sessions that outlived the bot (mirror of the
   *  scrape backend's scan). The bot decides adopt-vs-orphan per key — this
   *  method only lists. */
  async listExistingTmuxSessions(): Promise<Array<{ key: ThreadKey; sessionName: string }>> {
    const raw = await tmuxAsync('list-sessions', '-F', '#{session_name}');
    if (!raw) return [];
    const result: Array<{ key: ThreadKey; sessionName: string }> = [];
    for (const name of raw.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const key = parseJsonStreamTmuxSessionName(name);
      if (key) result.push({ key, sessionName: name });
    }
    return result;
  }

  /** Kill an orphan `cjson-…` tmux session AND its host dir (the dir is
   *  per-thread, derived from the parsed name; an unparseable name only
   *  kills the tmux session). */
  async killOrphanTmuxSession(sessionName: string): Promise<void> {
    console.log(`[ClaudeJson] kill orphan tmux session: ${sessionName}`);
    await tmuxAsync('kill-session', '-t', sessionName);
    const key = parseJsonStreamTmuxSessionName(sessionName);
    if (!key) return;
    try {
      fs.rmSync(resolveJsonStreamSessionDir(resolveDataDir(), key), { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  /**
   * @description Adopt an external json-stream process that survived a bot
   * restart: reopen the stdin FIFO writer and resume the stdout tail from the
   * persisted line-boundary offset — everything claude produced during the
   * downtime replays through the normal pipeline, so the in-flight turn is
   * delivered end-to-end (which is why the bot posts NO reattach recap for an
   * adopt). An unknown / foreign-session offset seeds to the CURRENT EOF (no
   * backlog flood — the first-migration case). No initialize handshake — the
   * surviving process completed it at spawn; a pending question is restored
   * from the sidecar so its buttons stay answerable. Returns `false` — after
   * killing the leftovers — when the process is dead (exitcode present / pid
   * gone / FIFO unheld): the caller falls back to the dead-process `--resume`
   * reopen.
   */
  async adoptExistingTmuxSession(
    key: ThreadKey,
    sessionName: string,
    workDir: string,
    claudeSessionId: string,
    persistedTail: JsonStreamTailOffset | null,
  ): Promise<boolean> {
    const names = await tmuxAsync('list-sessions', '-F', '#{session_name}');
    if (!names.split('\n').includes(sessionName)) {
      console.log(`[ClaudeJson] adopt: tmux session ${sessionName} no longer exists`);
      return false;
    }
    const k = keyToString(key);
    if (this.sessions.has(k)) {
      console.log(`[ClaudeJson] adopt: already tracking ${k}, skipping`);
      return true;
    }
    const sessionDir = resolveJsonStreamSessionDir(resolveDataDir(), key);
    const paths = getJsonStreamSessionPaths(sessionDir);
    const pid = readPidFile(paths.pidFile);
    const exitCode = readExitCodeFile(paths.exitCodeFile);
    if (pid === null || exitCode !== null || !checkIsPidAlive(pid)) {
      console.log(`[ClaudeJson] adopt: ${sessionName} process is dead (pid=${pid} exit=${exitCode}), cleaning up`);
      await this.killOrphanTmuxSession(sessionName);
      return false;
    }
    const fifoFd = await openFifoWriterNonBlocking(paths.stdinFifo);
    if (fifoFd === null) {
      console.log(`[ClaudeJson] adopt: ${sessionName} is not holding its stdin FIFO, cleaning up`);
      await this.killOrphanTmuxSession(sessionName);
      return false;
    }
    const size = getFileSize(paths.stdoutFile) ?? 0;
    const isTailTrusted = persistedTail !== null && persistedTail.sessionId === claudeSessionId;
    const startOffset = isTailTrusted ? Math.min(persistedTail.offsetBytes, size) : size;

    console.log(`[ClaudeJson] adopt: re-attaching to ${sessionName} in ${workDir} (pid=${pid}, tail=${startOffset}/${size})`);
    const session: StreamSession = {
      key, workDir, sessionId: claudeSessionId,
      pid, paths, fifoFd,
      stdinWriteChain: Promise.resolve(),
      tail: createStdoutTailState(startOffset),
      pollTimer: null, pollDelayMs: basePollIntervalMs, unchangedStreak: 0,
      isOversizeWarned: false, lastPersistedTailOffset: startOffset,
      reader: new ClaudeStreamLineReader(),
      // isBusy=false: the replayed/live events reconstruct it (deltas/toolUse
      // set it, `result` clears it) — see `applyAction`.
      isActive: true, isStopping: false, isRespawning: false, isBusy: false,
      lastStdoutActivityAt: Date.now(), outstandingToolUseIds: new Set(),
      model: null, reportedModel: null, effort: null,
      currentResponseText: '', emittedLength: 0, outputTimer: null,
      reasoningText: '', reasoningStartedAt: null, reasoningTimer: null, reasoningActive: false,
      toolNamesById: new Map(), questionToolUseIds: new Set(),
      subagentActive: false, childResponseText: '', childEmittedLength: 0, childOutputTimer: null,
      pendingInitResolve: null, initRequestId: null,
      pendingQuestion: this.readQuestionSidecar(paths),
      apiErrorFired: false, swallowNextAbortError: false,
      lastWatermarkOffset: -1,
    };
    if (session.pendingQuestion) {
      // The external process is still blocked on this question — busy, and the
      // question's internal tool_result echo must stay suppressed after answer.
      session.isBusy = true;
      session.questionToolUseIds.add(session.pendingQuestion.toolUseId);
    }
    this.sessions.set(k, session);
    this.schedulePoll(session, basePollIntervalMs);
    this.emit('started', key);
    return true;
  }

  /** Restore a pending question persisted by a previous bot life (see
   *  {@link writeQuestionSidecar}). Parse-boundary narrowing; the questions
   *  array re-runs the same validator as a live control_request, so a corrupt
   *  sidecar yields `null`, never a malformed pending question. */
  private readQuestionSidecar(paths: JsonStreamSessionPaths): PendingStreamQuestion | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(paths.questionFile, 'utf8'));
    } catch {
      return null; // absent (the common case) or corrupt
    }
    if (!checkIsStreamRecord(parsed)) return null;
    const { requestId, toolUseId, rawInput, questions } = parsed;
    if (typeof requestId !== 'string' || typeof toolUseId !== 'string') return null;
    if (!checkIsStreamRecord(rawInput) || !Array.isArray(questions)) return null;
    const revalidated = this.parseQuestions({ questions });
    if (revalidated.length === 0) return null;
    return { requestId, toolUseId, rawInput, questions: revalidated };
  }

  private performInitialize(session: StreamSession): Promise<void> {
    const requestId = 'init_' + randomUUID();
    session.initRequestId = requestId;
    const request = {
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'initialize', supportedDialogKinds: ['refusal_fallback_prompt'] },
    };
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; session.pendingInitResolve = null; resolve(); } };
      session.pendingInitResolve = done;
      this.writeStdin(session, request);
      setTimeout(() => {
        if (!settled) console.warn(`[ClaudeJson] initialize handshake timed out for ${keyToString(session.key)} — questions may be unavailable`);
        done();
      }, initializeHandshakeTimeoutMs);
    });
  }

  stopSession(key: ThreadKey): void {
    void this.stopSessionInternal(key);
  }

  private async stopSessionInternal(key: ThreadKey): Promise<void> {
    const k = keyToString(key);
    const inFlight = this.stopsInFlight.get(k);
    if (inFlight) return inFlight; // join the running stop instead of racing it
    const session = this.sessions.get(k);
    if (!session) return;
    const stopPromise = this.performStop(session).finally(() => { this.stopsInFlight.delete(k); });
    this.stopsInFlight.set(k, stopPromise);
    return stopPromise;
  }

  /** Explicit stop = hard-kill the EXTERNAL process (released sessions are
   *  never adopted — locked decision): SIGTERM the pid, kill the tmux session,
   *  then converge through {@link finalizeExternalExit} (dir removal + `stopped`). */
  private async performStop(session: StreamSession): Promise<void> {
    // Reject a pending question server-side before teardown so the model's
    // AskUserQuestion turn is unblocked (deny), mirroring OpenCode's reject.
    this.rejectQuestion(session.key);
    session.isStopping = true;
    // Let the reject (and any queued frame) reach the FIFO before the kill.
    await session.stdinWriteChain.catch(() => { /* already logged */ });
    try { process.kill(session.pid, 'SIGTERM'); } catch { /* already gone */ }
    await tmuxAsync('kill-session', '-t', buildJsonStreamTmuxSessionName(session.key));
    this.finalizeExternalExit(session, null);
  }

  checkIsActive(key: ThreadKey): boolean {
    const session = this.sessions.get(keyToString(key));
    return session?.isActive === true;
  }

  checkIsBusy(key: ThreadKey): boolean {
    return this.sessions.get(keyToString(key))?.isBusy === true;
  }

  async getRuntimeInfo(key: ThreadKey): Promise<AgentRuntimeInfo> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) {
      return { version: null, model: null, contextWindowTokens: null, contextUsedTokens: null };
    }
    const filePath = getClaudeTranscriptPath(session.workDir, session.sessionId);
    try {
      return await readClaudeRuntimeInfo(filePath);
    } catch {
      return { version: null, model: null, contextWindowTokens: null, contextUsedTokens: null };
    }
  }

  getClaudeSessionId(key: ThreadKey): string | null {
    return this.sessions.get(keyToString(key))?.sessionId ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Input (S3)
  // ─────────────────────────────────────────────────────────────────────────

  sendInput(key: ThreadKey, input: string): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) {
      console.warn(`[ClaudeJson] sendInput to inactive session ${keyToString(key)} dropped`);
      return;
    }
    // A fresh user turn begins → reset the answer cursor so its first tail is a
    // new message (the bot also flips `needsNewMessage` for delta adapters).
    session.currentResponseText = '';
    session.emittedLength = 0;
    session.apiErrorFired = false;
    session.isBusy = true;
    // A fresh turn resets the idle-watchdog clock: without this a session that
    // sat idle for minutes (busy=false, clock stale) would trip the watchdog on
    // its very next poll — before claude has a chance to emit the first token.
    session.lastStdoutActivityAt = Date.now();
    this.writeStdin(session, { type: 'user', message: { role: 'user', content: input } });
  }

  sendSignal(key: ThreadKey, _signal: string): void {
    this.sendInterrupt(key);
  }

  sendEscape(key: ThreadKey): void {
    this.sendInterrupt(key);
  }

  private sendInterrupt(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;
    this.writeStdin(session, {
      type: 'control_request',
      request_id: 'interrupt_' + randomUUID(),
      request: { subtype: 'interrupt' },
    });
    // An interrupt ABORTS the current turn. The CLI does not reliably emit a
    // terminal `result` for an aborted turn, so clearing `isBusy` here (rather
    // than waiting on the idle watchdog) makes the explicit stop deterministic —
    // the typing indicator drops immediately. If output resumes, a delta re-arms
    // busy; if a `result` does arrive, `handleTurnEnd` is a harmless no-op.
    session.isBusy = false;
    session.outstandingToolUseIds.clear();
    // When the CLI DOES emit a terminal `result{is_error}` for this abort, it
    // carries no text → `claudeStreamJson` labels it the literal `'API error'`.
    // Arm the one-shot so `handleTurnEnd` swallows it instead of relaying a bogus
    // "Claude error: API error" (the reported triple-message on question-cancel,
    // and any bare `/esc` mid-turn). Consumed by the next `handleTurnEnd`.
    session.swallowNextAbortError = true;
  }

  /** Enqueue one stream-json frame onto the stdin FIFO. Fire-and-forget for
   *  callers (sync signature preserved); the per-session chain keeps wire
   *  order and absorbs transient `EAGAIN` (see `writeFifoText`). */
  private writeStdin(session: StreamSession, obj: unknown): void {
    const line = JSON.stringify(obj) + '\n';
    session.stdinWriteChain = session.stdinWriteChain
      .then(() => writeFifoText(session.fifoFd, line))
      .catch((e) => console.error(`[ClaudeJson] stdin write failed for ${keyToString(session.key)}:`, e instanceof Error ? e.message : e));
    // New input → output expected shortly; snap the tail poll back to base.
    this.snapPollToBase(session);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Output parsing (S2) + control channel (S4)
  // ─────────────────────────────────────────────────────────────────────────

  private onStdout(session: StreamSession, chunk: string): void {
    for (const line of session.reader.push(chunk)) {
      const msg = parseStreamJsonLine(line);
      if (!msg) continue;
      // control_response for our own outbound requests (initialize handshake).
      if (msg.type === 'control_response') { this.handleControlResponse(session, msg); continue; }
      for (const action of classifyClaudeStreamMessage(msg)) {
        this.applyAction(session, action);
      }
      // S7: advance the seen-watermark as each PARENT assistant message settles
      // (is relayed), not only at turn end. The external process normally
      // SURVIVES a bot restart now (adopt replays the stdout tail — no recap),
      // but when the process itself DIES mid-turn the dead-process `--resume`
      // fallback recaps from this watermark: without the per-message advance
      // the aborted turn's already-relayed assistant messages would re-count
      // as a false "missed N" (same shared recap reader as the tmux backend,
      // the 2026-07-04 bug). A settled `assistant` message is on disk here, so
      // the transcript EOF includes it. A CHILD (sub-agent) message
      // (`parent_tool_use_id` set) must never advance the watermark.
      if (msg.type === 'assistant' && msg.parent_tool_use_id == null) {
        this.advanceWatermarkFromTranscript(session);
      }
    }
  }

  private handleControlResponse(session: StreamSession, msg: Record<string, unknown>): void {
    const response = typeof msg.response === 'object' && msg.response !== null ? (msg.response as Record<string, unknown>) : null;
    const requestId = response ? response.request_id : undefined;
    if (session.pendingInitResolve && requestId === session.initRequestId) {
      session.pendingInitResolve();
    }
  }

  private applyAction(session: StreamSession, action: ClaudeStreamAction): void {
    switch (action.kind) {
      case 'init':
        // Per-turn `init` re-emits; the id is fixed by our `--session-id`, so the
        // id itself is nothing to act on. The MODEL it carries is load-bearing:
        // it is the only report of what claude actually runs. Without capturing
        // it `/status` and the pinned banner showed no model at all on a default
        // start / resume / adopt (nothing ever set the `--model` pick).
        if (action.model) session.reportedModel = action.model;
        return;
      case 'textDelta':
        // Mid-turn activity marks the session busy: `sendInput` normally set it,
        // but an ADOPTED session (bot restart mid-turn) reconstructs the busy
        // state purely from the replayed/live events; `turnEnd` clears it.
        session.isBusy = true;
        if (action.isSubagent) this.handleSubagentText(session, action.text);
        else this.appendAnswerDelta(session, action.text);
        return;
      case 'thinkingDelta':
        session.isBusy = true;
        if (action.isSubagent) return; // child reasoning never rendered (parity)
        this.appendThinkingDelta(session, action.text);
        return;
      case 'toolUse':
        session.isBusy = true;
        this.handleToolUse(session, action);
        return;
      case 'toolResult':
        this.handleToolResult(session, action);
        return;
      case 'turnEnd':
        this.handleTurnEnd(session, action);
        return;
      case 'controlRequest':
        this.handleControlRequest(session, action);
        return;
      case 'apiRetry':
        this.maybeEmitApiError(session, action.text);
        return;
      case 'rateLimit':
        // Subscription usage-window signal; not surfaced to the topic (parity).
        return;
      case 'userEcho':
        return;
    }
  }

  // — answer text —

  private appendAnswerDelta(session: StreamSession, text: string): void {
    // Reasoning is over the moment the answer starts (Claude closes the thinking
    // block before the text block).
    this.finishReasoning(session);
    session.currentResponseText += text;
    if (session.outputTimer) return; // a flush is already scheduled
    session.outputTimer = setTimeout(() => {
      session.outputTimer = null;
      this.flushAnswer(session, false);
    }, streamOutputBatchMs);
  }

  private flushAnswer(session: StreamSession, isFinal: boolean): void {
    if (session.outputTimer) { clearTimeout(session.outputTimer); session.outputTimer = null; }
    const tail = session.currentResponseText.slice(session.emittedLength);
    if (tail) {
      session.emittedLength = session.currentResponseText.length;
      const meta: OutputEventMeta = isFinal ? { isFinal: true } : {};
      // NO isContinuation: `outputsDeltas` adapters let the transports synthesise it.
      this.emit('output', session.key, tail, meta);
    }
    // The answer batcher is drained — the held-back consumption boundary is now
    // safe to persist (see `drainStdoutTail`).
    if (checkIsEmitCaughtUp(session)) this.persistTailOffset(session);
  }

  // — reasoning / thinking —

  private appendThinkingDelta(session: StreamSession, text: string): void {
    if (!session.reasoningActive) { session.reasoningActive = true; session.reasoningStartedAt = Date.now(); session.reasoningText = ''; }
    session.reasoningText += text;
    if (session.reasoningTimer) return;
    session.reasoningTimer = setTimeout(() => {
      session.reasoningTimer = null;
      this.emit('thinking', session.key, { phase: 'live', text: session.reasoningText });
    }, streamOutputBatchMs);
  }

  private finishReasoning(session: StreamSession): void {
    if (!session.reasoningActive) return;
    if (session.reasoningTimer) { clearTimeout(session.reasoningTimer); session.reasoningTimer = null; }
    const durationMs = session.reasoningStartedAt ? Date.now() - session.reasoningStartedAt : undefined;
    this.emit('thinking', session.key, { phase: 'done', text: session.reasoningText, durationMs });
    session.reasoningActive = false;
    session.reasoningStartedAt = null;
  }

  // — tools —

  private handleToolUse(session: StreamSession, action: Extract<ClaudeStreamAction, { kind: 'toolUse' }>): void {
    // AskUserQuestion never renders as a tool (it is intercepted on the control
    // channel); guard defensively.
    if (action.tool === 'AskUserQuestion') return;
    if (action.isSubagent) { this.markSubagentActive(session); return; }
    session.toolNamesById.set(action.toolUseId, action.tool);
    // Track it as in flight until its tool_result returns — a busy session with
    // an outstanding tool (e.g. a long silent Bash) must NOT trip the idle
    // watchdog even though stdout goes quiet while the tool runs.
    session.outstandingToolUseIds.add(action.toolUseId);
    // Transient status only; the completed body arrives as a toolResult.
    this.emit('status', session.key, `🔧 ${action.tool}`);
  }

  private handleToolResult(session: StreamSession, action: Extract<ClaudeStreamAction, { kind: 'toolResult' }>): void {
    // The tool returned — no longer in flight (do this before any early return so
    // the outstanding-tool set can never leak and pin the idle watchdog open).
    session.outstandingToolUseIds.delete(action.toolUseId);
    // Skip AskUserQuestion's internal "questions have been answered" tool_result.
    if (session.questionToolUseIds.has(action.toolUseId)) return;
    const tool = session.toolNamesById.get(action.toolUseId) ?? 'tool';
    if (!action.output.trim()) return;
    // Mode-agnostic emit — the bot applies the per-thread `/tool_results` pref.
    this.emit('toolResult', session.key, { tool, output: action.output });
  }

  // — sub-agent (v1) —

  private markSubagentActive(session: StreamSession): void {
    session.subagentActive = true;
    this.emit('subagentStatus', session.key, { active: true, title: null });
  }

  private handleSubagentText(session: StreamSession, text: string): void {
    if (this.getDisplayPrefs(session.key).subagent === 'full') {
      session.childResponseText += text;
      if (session.childOutputTimer) return;
      session.childOutputTimer = setTimeout(() => {
        session.childOutputTimer = null;
        const tail = session.childResponseText.slice(session.childEmittedLength);
        if (!tail.trim()) return;
        session.childEmittedLength = session.childResponseText.length;
        this.emit('output', session.key, tail, { isSubagent: true } satisfies OutputEventMeta);
        // Child batcher drained — release the held-back tail offset (see
        // `drainStdoutTail`).
        if (checkIsEmitCaughtUp(session)) this.persistTailOffset(session);
      }, streamOutputBatchMs);
    } else {
      this.markSubagentActive(session);
    }
  }

  private clearSubagent(session: StreamSession): void {
    if (session.childOutputTimer) { clearTimeout(session.childOutputTimer); session.childOutputTimer = null; }
    session.childResponseText = '';
    session.childEmittedLength = 0;
    if (session.subagentActive) {
      session.subagentActive = false;
      this.emit('subagentStatus', session.key, { active: false, title: null });
    }
  }

  // — turn end —

  private handleTurnEnd(session: StreamSession, action: Extract<ClaudeStreamAction, { kind: 'turnEnd' }>): void {
    session.isBusy = false;
    session.outstandingToolUseIds.clear();
    this.finishReasoning(session);
    this.clearSubagent(session);
    // One-shot: consume the interrupt's swallow flag for THIS terminal result
    // (read-and-clear so it can never leak onto a later, unrelated turn).
    const swallowAbortError = session.swallowNextAbortError;
    session.swallowNextAbortError = false;

    if (action.isError && action.errorText) {
      // Our own interrupt produced this error result — relay nothing (no bogus
      // "Claude error", no spurious retry). A REAL provider error arriving
      // WITHOUT a preceding interrupt still classifies / surfaces normally.
      if (swallowAbortError) {
        console.log(`[ClaudeJson] swallowed interrupt-aborted turn error for ${keyToString(session.key)}: ${action.errorText}`);
        return;
      }
      const emitted = this.maybeEmitApiError(session, action.errorText);
      if (!emitted) this.emit('output', session.key, `Claude error: ${action.errorText}`, { isFinal: true });
      return;
    }

    // Reconciliation backstop: if the delta stream under-delivered vs the final
    // `result` text, append the gap so the answer is never short.
    if (action.resultText && action.resultText.length > session.currentResponseText.length
        && action.resultText.startsWith(session.currentResponseText)) {
      session.currentResponseText = action.resultText;
    }
    this.flushAnswer(session, true);

    // Advance the seen watermark to the transcript's current byte size so a bot
    // restart can count assistant messages produced while it was down. Also runs
    // per settled parent message (see `onStdout`); this turn-end call is the
    // safety-net catch-up for the final assistant line.
    this.advanceWatermarkFromTranscript(session);
  }

  /**
   * @description Advance the persisted seen-watermark to the transcript's current
   * byte size when it grew past the last write (S7). A cheap `fs.statSync().size`
   * (NOT a whole-file read — this runs per settled parent assistant message, not
   * only at turn end) plus a monotonic guard, mirroring the tmux backend's
   * {@link import('./claudeCliAdapter').ClaudeCliAdapter} advance so both Claude
   * paths track "relayed up to here". Best-effort — a transcript not yet on disk
   * leaves the watermark where it was; the next relayed message re-tries.
   */
  private advanceWatermarkFromTranscript(session: StreamSession): void {
    try {
      const filePath = getClaudeTranscriptPath(session.workDir, session.sessionId);
      const eof = fs.statSync(filePath).size;
      if (eof <= session.lastWatermarkOffset) return; // monotonic: only real growth writes
      session.lastWatermarkOffset = eof;
      this.advanceSeenWatermark(session.key, { sessionId: session.sessionId, claudeTranscriptOffset: eof });
    } catch {
      // Transcript not yet on disk (UUID just born) / stat failed — retry next relay.
    }
  }

  // — api error —

  /** Classify + emit an `apiError` once per episode; returns whether it fired. */
  private maybeEmitApiError(session: StreamSession, text: string): boolean {
    if (session.apiErrorFired) return false;
    const apiError = classifyAgentApiError(text, Date.now());
    if (!apiError) return false;
    session.apiErrorFired = true;
    this.emit('apiError', session.key, apiError);
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Questions & permissions — control channel (S4)
  // ─────────────────────────────────────────────────────────────────────────

  private handleControlRequest(session: StreamSession, action: Extract<ClaudeStreamAction, { kind: 'controlRequest' }>): void {
    if (action.subtype === 'can_use_tool') {
      if (action.toolName === 'AskUserQuestion' && action.input && action.toolUseId) {
        session.questionToolUseIds.add(action.toolUseId);
        this.surfaceQuestion(session, action.requestId, action.toolUseId, action.input);
        return;
      }
      // Any other tool → auto-allow (operator trusts their own agent; parity with
      // the tmux backend's bypassPermissions). Under bypass this fires only for the
      // residual circuit-breakers claude never bypasses (`rm -rf /`, `rm -rf ~`).
      // `buildCanUseToolAllow` guarantees the schema-required `updatedInput`.
      this.writeControlResponse(session, action.requestId, buildCanUseToolAllow(action.input, action.toolUseId));
      return;
    }
    if (action.subtype === 'request_user_dialog') {
      // No dialog UI in Telegram → cancel so the CLI falls back gracefully.
      this.writeControlResponse(session, action.requestId, { behavior: 'cancelled' });
      return;
    }
    // Unknown control request → generic success so the CLI is never left hanging.
    this.writeControlResponse(session, action.requestId, {});
  }

  private surfaceQuestion(session: StreamSession, requestId: string, toolUseId: string, rawInput: Record<string, unknown>): void {
    const questions = this.parseQuestions(rawInput);
    if (questions.length === 0) {
      // Nothing to ask — allow with the raw input so the turn continues.
      this.writeControlResponse(session, requestId, buildCanUseToolAllow(rawInput, toolUseId));
      return;
    }
    session.pendingQuestion = { requestId, toolUseId, rawInput, questions };
    session.isBusy = true;
    this.writeQuestionSidecar(session);
    const payload: OpenCodePendingQuestion = { requestId, questions };
    this.emit('question', session.key, payload);
  }

  /**
   * @description Persist the pending question to the host dir. The external
   * claude process stays BLOCKED on its `can_use_tool` across a bot restart,
   * but the control_request line lies BEFORE the persisted tail offset (it was
   * consumed pre-restart), so tail replay alone would never resurface it — the
   * sidecar is what lets an adopting bot still answer over the FIFO. Removed
   * the moment the question resolves (answer / reject); dies with the dir on
   * stop.
   */
  private writeQuestionSidecar(session: StreamSession): void {
    if (!session.pendingQuestion) return;
    try {
      fs.writeFileSync(session.paths.questionFile, JSON.stringify(session.pendingQuestion));
    } catch (e) {
      console.warn(`[ClaudeJson] cannot persist pending question for ${keyToString(session.key)}:`, e instanceof Error ? e.message : e);
    }
  }

  private clearQuestionSidecar(session: StreamSession): void {
    try { fs.unlinkSync(session.paths.questionFile); } catch { /* absent */ }
  }

  /** Map the AskUserQuestion `input.questions` to the shared question shape
   *  (dropping option `preview`, which breaks in the Telegram relay). */
  private parseQuestions(rawInput: Record<string, unknown>): OpenCodeQuestion[] {
    const rawQuestions = Array.isArray(rawInput.questions) ? rawInput.questions : [];
    const result: OpenCodeQuestion[] = [];
    for (const raw of rawQuestions) {
      if (typeof raw !== 'object' || raw === null) continue;
      const q = raw as Record<string, unknown>;
      if (typeof q.question !== 'string') continue;
      const rawOptions = Array.isArray(q.options) ? q.options : [];
      const options = rawOptions
        .map((o): OpenCodeQuestion['options'][number] | null => {
          if (typeof o !== 'object' || o === null) return null;
          const oo = o as Record<string, unknown>;
          if (typeof oo.label !== 'string') return null;
          return typeof oo.description === 'string' ? { label: oo.label, description: oo.description } : { label: oo.label };
        })
        .filter((o): o is OpenCodeQuestion['options'][number] => o !== null);
      if (options.length === 0) continue;
      const question: OpenCodeQuestion = { question: q.question, options };
      if (typeof q.header === 'string') question.header = q.header;
      if (q.multiSelect === true) question.multiple = true;
      result.push(question);
    }
    return result;
  }

  answerQuestion(key: ThreadKey, answers: string[][]): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive || !session.pendingQuestion) return;
    const pending = session.pendingQuestion;
    session.pendingQuestion = null;
    this.clearQuestionSidecar(session);
    // The turn resumes now; reset the idle-watchdog clock so the (possibly long)
    // wait for the user's answer doesn't instantly trip it before output resumes.
    session.lastStdoutActivityAt = Date.now();

    // Build the answers map: question text → selected label(s) (comma-joined for
    // multi-select), the exact shape AskUserQuestion expects.
    const answersMap: Record<string, string> = {};
    pending.questions.forEach((q, i) => {
      const selected = answers[i] ?? [];
      answersMap[q.question] = selected.join(',');
    });
    this.writeControlResponse(session, pending.requestId, buildCanUseToolAllow({ ...pending.rawInput, answers: answersMap }, pending.toolUseId));
  }

  rejectQuestion(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.pendingQuestion) return;
    const pending = session.pendingQuestion;
    session.pendingQuestion = null;
    this.clearQuestionSidecar(session);
    this.writeControlResponse(session, pending.requestId, buildCanUseToolDeny('User declined to answer the question.', pending.toolUseId));
  }

  private writeControlResponse(session: StreamSession, requestId: string, response: Record<string, unknown>): void {
    this.writeStdin(session, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Session history / resume (S5) — reuse the shared Claude transcript readers
  // ─────────────────────────────────────────────────────────────────────────

  async getSessions(_key: ThreadKey, workDir: string): Promise<AgentSession[]> {
    return listClaudeSessionsForWorkDir(getClaudeProjectsRoot(), workDir);
  }

  async getRecentTurns(_key: ThreadKey, workDir: string, sessionId: string, limit: number): Promise<RecentTurn[]> {
    const filePath = getClaudeTranscriptPath(workDir, sessionId);
    return readRecentClaudeTurns(filePath, limit);
  }

  async getReattachRecap(key: ThreadKey, workDir: string, sessionId: string, watermark: SeenWatermark | null): Promise<ReattachRecap> {
    const filePath = getClaudeTranscriptPath(workDir, sessionId);
    const offset = watermark?.claudeTranscriptOffset;
    const isWatermarkKnown = typeof offset === 'number' && watermark?.sessionId === sessionId;
    const { missedCount, turns, headOffset } = readClaudeReattachTranscript(filePath, offset ?? 0, resumeContextTurnLimit);
    const headWatermark: SeenWatermark | undefined =
      headOffset === undefined ? undefined : { sessionId, claudeTranscriptOffset: headOffset };
    return { missedCount: isWatermarkKnown ? missedCount : 0, turns, isWatermarkKnown, isActive: this.checkIsBusy(key), headWatermark };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Model / effort (S6) — spawn flags; a live change re-spawns with --resume
  // ─────────────────────────────────────────────────────────────────────────

  async setModel(key: ThreadKey, modelId: string): Promise<string | null> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return t('model.start_agent_first');
    await this.respawnWithChange(session, { model: modelId, effort: session.effort });
    return null;
  }

  /**
   * @description The model the session is RUNNING. Claude's own `system/init`
   * report wins over the pinned `--model` pick: it is the resolved id (an alias
   * like `opus` resolves to its snapshot) and it is the only value present when
   * no pick was ever made. The pick is the fallback for the window between a
   * `/model` re-spawn and its first `init`, so the label never blanks out
   * mid-switch.
   */
  getCurrentModel(key: ThreadKey): string | null {
    const session = this.sessions.get(keyToString(key));
    return session?.reportedModel ?? session?.model ?? null;
  }

  async getAvailableModels(): Promise<string[]> {
    // The CLI `--model` accepts these aliases (resolved to the latest snapshot).
    return ['sonnet', 'opus', 'haiku'];
  }

  async setEffort(key: ThreadKey, level: string): Promise<string | null> {
    if (!checkIsClaudeEffortLevel(level)) {
      return t('effort.invalid_level', { level, valid: getClaudeAvailableLevels().join(', ') });
    }
    saveEffortPref(key, level);
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return t('effort.start_agent_first');
    await this.respawnWithChange(session, { model: session.model, effort: level });
    return null;
  }

  getEffort(key: ThreadKey): string | null {
    return loadEffortPrefs()[keyToString(key)] ?? null;
  }

  async getAvailableEffortLevels(_key: ThreadKey): Promise<string[]> {
    return getClaudeAvailableLevels();
  }

  /**
   * @description Apply a model/effort change by re-spawning the child with
   * `--resume <sessionId>` (the on-disk session persists, so only an in-flight
   * streaming reply is lost — same trade-off as OpenCode's server restart). The
   * intermediate exit is suppressed (`isRespawning`) so the bot sees no
   * closed/stopped churn.
   */
  private async respawnWithChange(session: StreamSession, change: { model: string | null; effort: string | null }): Promise<void> {
    const { key, workDir, sessionId } = session;
    session.isRespawning = true;
    this.rejectQuestion(key);
    await session.stdinWriteChain.catch(() => { /* already logged */ });
    this.clearTimers(session);
    session.isActive = false;
    this.closeFifo(session);
    try { process.kill(session.pid, 'SIGTERM'); } catch { /* gone */ }
    await tmuxAsync('kill-session', '-t', buildJsonStreamTmuxSessionName(key));
    // spawnSession lays the host dir out fresh and replaces the map entry.
    await this.spawnSession(key, workDir, sessionId, { effort: change.effort, model: change.model, resume: true });
  }

  private clearTimers(session: StreamSession): void {
    if (session.pollTimer) { clearTimeout(session.pollTimer); session.pollTimer = null; }
    if (session.outputTimer) { clearTimeout(session.outputTimer); session.outputTimer = null; }
    if (session.reasoningTimer) { clearTimeout(session.reasoningTimer); session.reasoningTimer = null; }
    if (session.childOutputTimer) { clearTimeout(session.childOutputTimer); session.childOutputTimer = null; }
  }
}

/**
 * @description Whether every consumed event has LEFT the adapter — nothing is
 * waiting in the answer / sub-agent 350ms batchers. Gates the tail-offset
 * persist: batched-but-unemitted text must keep the persisted offset BEHIND
 * it, so a restart replays (never skips) it. Live thinking text is
 * deliberately ignored — it renders as a transient frame, so a lost batch of
 * it at a reload seam costs nothing permanent.
 */
function checkIsEmitCaughtUp(session: StreamSession): boolean {
  return session.currentResponseText.length === session.emittedLength
    && session.childResponseText.length === session.childEmittedLength;
}

/** Spawn-fail diagnostics: the wrapper's exit code + a stderr excerpt (the
 *  passive `stderr.log` is read ONLY here and at unexpected exit — locked
 *  decision, no live stderr consumer). */
function describeSpawnFailure(paths: JsonStreamSessionPaths): string {
  const exitCode = readExitCodeFile(paths.exitCodeFile);
  const stderrTail = readStderrTail(paths.stderrFile);
  const parts: string[] = [];
  if (exitCode !== null) parts.push(`exit=${exitCode}`);
  if (stderrTail) parts.push(`stderr: ${stderrTail}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}
