import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import type {
  AgentAdapter,
  AgentSession,
  DisplayPrefsReader,
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
  getClaudeProjectSlug,
  listClaudeSessionsForWorkDir,
  readRecentClaudeTurns,
  readClaudeReattachTranscript,
  loadEffortPrefs,
  saveEffortPref,
} from './claudeCliAdapter';
import {
  ClaudeStreamLineReader,
  parseStreamJsonLine,
  classifyClaudeStreamMessage,
  type ClaudeStreamAction,
} from '../utils/claudeStreamJson';

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
  child: ChildProcessWithoutNullStreams;
  reader: ClaudeStreamLineReader;
  isActive: boolean;
  /** True between an explicit stop and process exit → emit `stopped` not `closed`. */
  isStopping: boolean;
  /** True while re-spawning for a model/effort change → suppress closed/stopped. */
  isRespawning: boolean;
  /** True from a user turn sent until its `result` → drives `checkIsBusy`. */
  isBusy: boolean;
  model: string | null;
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
}

/**
 * @description SECOND Claude backend: drives the `claude` CLI over its
 * documented `--input-format stream-json --output-format stream-json` protocol
 * (typed events, no TUI scrape) as an OWNED child process per {@link ThreadKey}
 * — the structured-event analogue of the tmux backend, on the SAME subscription
 * billing (proven `apiKeySource:"none"` + `seven_day` rate-limit event; never
 * sets `ANTHROPIC_API_KEY`, never uses `--bare`).
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
 * Experimental: selected only by code (`DEFAULT_AGENT=claude-json-stream` or a
 * `setThreadAdapter` call). The tmux `claude` adapter stays the default.
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

  setDisplayPrefsReader(reader: DisplayPrefsReader): void {
    this.displayPrefsReader = reader;
  }

  setSeenWatermarkWriter(writer: SeenWatermarkWriter): void {
    this.seenWatermarkWriter = writer;
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
   * @description Spawn (or re-spawn) the CLI child for a thread, wire its stdio,
   * and complete the `initialize` control handshake (which enables the
   * `AskUserQuestion` control channel). Rejects if the binary can't be resolved
   * or the process fails to start. Reused by start / resume / effort-respawn.
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
      '--permission-mode', 'acceptEdits',
      '--permission-prompt-tool', 'stdio',
    ];
    if (opts.resume) args.push('--resume', sessionId);
    else args.push('--session-id', sessionId);
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    args.push(...mcpFlags);

    // Subscription billing: NEVER pass ANTHROPIC_API_KEY (that would meter the
    // API). The CLI reads the OAuth login from ~/.claude — `apiKeySource:"none"`.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    console.log(`[ClaudeJson] spawn ${keyToString(key)} session=${sessionId} resume=${opts.resume} effort=${opts.effort} model=${opts.model ?? 'default'}`);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.claudePath, args, { cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      cleanupMcpTempFiles({ key, dataDir: resolveDataDir() });
      throw new Error(`Failed to start Claude stream session: ${e instanceof Error ? e.message : String(e)}`);
    }

    const session: StreamSession = {
      key, workDir, sessionId, child,
      reader: new ClaudeStreamLineReader(),
      isActive: true, isStopping: false, isRespawning: false, isBusy: false,
      model: opts.model, effort: opts.effort,
      currentResponseText: '', emittedLength: 0, outputTimer: null,
      reasoningText: '', reasoningStartedAt: null, reasoningTimer: null, reasoningActive: false,
      toolNamesById: new Map(), questionToolUseIds: new Set(),
      subagentActive: false, childResponseText: '', childEmittedLength: 0, childOutputTimer: null,
      pendingInitResolve: null, initRequestId: null,
      pendingQuestion: null, apiErrorFired: false,
    };
    this.sessions.set(keyToString(key), session);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(session, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => console.warn(`[ClaudeJson stderr ${keyToString(key)}] ${chunk.trimEnd()}`));
    child.on('error', (err) => {
      console.error(`[ClaudeJson] child error ${keyToString(key)}:`, err.message);
      if (session.isActive && !session.isStopping && !session.isRespawning) {
        this.emit('error', key, err instanceof Error ? err : new Error(String(err)));
      }
    });
    child.on('exit', (code, signal) => this.onChildExit(session, code, signal));

    // Initialize handshake: declares the interactive control channel (permission
    // prompts + AskUserQuestion route to stdio). Without it AskUserQuestion is not
    // even in the tool list (verified). Best-effort — proceed on timeout so a
    // handshake hiccup never blocks a plain-output session.
    await this.performInitialize(session);

    this.emit('started', key);
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

  private onChildExit(session: StreamSession, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.isRespawning) return; // an effort/model re-spawn owns the transition
    const key = session.key;
    // Only act if this session is still the current one for the key.
    if (this.sessions.get(keyToString(key)) !== session) return;
    this.clearTimers(session);
    session.isActive = false;
    this.sessions.delete(keyToString(key));
    cleanupMcpTempFiles({ key, dataDir: resolveDataDir() });
    if (session.isStopping) {
      console.log(`[ClaudeJson] session ${keyToString(key)} stopped (code=${code} sig=${signal})`);
      this.emit('stopped', key);
    } else {
      console.warn(`[ClaudeJson] session ${keyToString(key)} exited unexpectedly (code=${code} sig=${signal})`);
      this.emit('closed', key);
    }
  }

  stopSession(key: ThreadKey): void {
    void this.stopSessionInternal(key);
  }

  private async stopSessionInternal(key: ThreadKey): Promise<void> {
    const session = this.sessions.get(keyToString(key));
    if (!session) return;
    // Reject a pending question server-side before teardown so the model's
    // AskUserQuestion turn is unblocked (deny), mirroring OpenCode's reject.
    this.rejectQuestion(key);
    session.isStopping = true;
    session.isActive = false;
    this.clearTimers(session);
    try { session.child.stdin.end(); } catch { /* pipe already closed */ }
    try { session.child.kill('SIGTERM'); } catch { /* already gone */ }
  }

  checkIsActive(key: ThreadKey): boolean {
    const session = this.sessions.get(keyToString(key));
    return session?.isActive === true;
  }

  checkIsBusy(key: ThreadKey): boolean {
    return this.sessions.get(keyToString(key))?.isBusy === true;
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
  }

  private writeStdin(session: StreamSession, obj: unknown): void {
    try {
      session.child.stdin.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      console.error(`[ClaudeJson] stdin write failed for ${keyToString(session.key)}:`, e instanceof Error ? e.message : e);
    }
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
        // Per-turn `init` re-emits; the id is fixed by our `--session-id`. Nothing
        // to do besides confirm liveness.
        return;
      case 'textDelta':
        if (action.isSubagent) this.handleSubagentText(session, action.text);
        else this.appendAnswerDelta(session, action.text);
        return;
      case 'thinkingDelta':
        if (action.isSubagent) return; // child reasoning never rendered (parity)
        this.appendThinkingDelta(session, action.text);
        return;
      case 'toolUse':
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
    if (!tail) return;
    session.emittedLength = session.currentResponseText.length;
    const meta: OutputEventMeta = isFinal ? { isFinal: true } : {};
    // NO isContinuation: `outputsDeltas` adapters let the transports synthesise it.
    this.emit('output', session.key, tail, meta);
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
    // Transient status only; the completed body arrives as a toolResult.
    this.emit('status', session.key, `🔧 ${action.tool}`);
  }

  private handleToolResult(session: StreamSession, action: Extract<ClaudeStreamAction, { kind: 'toolResult' }>): void {
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
    this.finishReasoning(session);
    this.clearSubagent(session);

    if (action.isError && action.errorText) {
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
    // restart can count assistant messages produced while it was down.
    this.advanceWatermarkFromTranscript(session);
  }

  private advanceWatermarkFromTranscript(session: StreamSession): void {
    try {
      const filePath = path.join(getClaudeProjectsRoot(), getClaudeProjectSlug(session.workDir), `${session.sessionId}.jsonl`);
      const { headOffset } = readClaudeReattachTranscript(filePath, 0, 1);
      if (headOffset !== undefined) {
        this.advanceSeenWatermark(session.key, { sessionId: session.sessionId, claudeTranscriptOffset: headOffset });
      }
    } catch (e) {
      console.warn(`[ClaudeJson] watermark advance failed:`, e instanceof Error ? e.message : e);
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
      // the tmux backend's bypassPermissions). Never wedge the turn.
      this.writeControlResponse(session, action.requestId, { behavior: 'allow', toolUseID: action.toolUseId });
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
      this.writeControlResponse(session, requestId, { behavior: 'allow', updatedInput: rawInput, toolUseID: toolUseId });
      return;
    }
    session.pendingQuestion = { requestId, toolUseId, rawInput, questions };
    session.isBusy = true;
    const payload: OpenCodePendingQuestion = { requestId, questions };
    this.emit('question', session.key, payload);
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

    // Build the answers map: question text → selected label(s) (comma-joined for
    // multi-select), the exact shape AskUserQuestion expects.
    const answersMap: Record<string, string> = {};
    pending.questions.forEach((q, i) => {
      const selected = answers[i] ?? [];
      answersMap[q.question] = selected.join(',');
    });
    this.writeControlResponse(session, pending.requestId, {
      behavior: 'allow',
      updatedInput: { ...pending.rawInput, answers: answersMap },
      toolUseID: pending.toolUseId,
    });
  }

  rejectQuestion(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.pendingQuestion) return;
    const pending = session.pendingQuestion;
    session.pendingQuestion = null;
    this.writeControlResponse(session, pending.requestId, {
      behavior: 'deny',
      message: 'User declined to answer the question.',
      toolUseID: pending.toolUseId,
    });
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
    const filePath = path.join(getClaudeProjectsRoot(), getClaudeProjectSlug(workDir), `${sessionId}.jsonl`);
    return readRecentClaudeTurns(filePath, limit);
  }

  async getReattachRecap(key: ThreadKey, workDir: string, sessionId: string, watermark: SeenWatermark | null): Promise<ReattachRecap> {
    const filePath = path.join(getClaudeProjectsRoot(), getClaudeProjectSlug(workDir), `${sessionId}.jsonl`);
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

  getCurrentModel(key: ThreadKey): string | null {
    return this.sessions.get(keyToString(key))?.model ?? null;
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
    this.clearTimers(session);
    session.isActive = false;
    try { session.child.stdin.end(); } catch { /* closed */ }
    try { session.child.kill('SIGTERM'); } catch { /* gone */ }
    await this.spawnSession(key, workDir, sessionId, { effort: change.effort, model: change.model, resume: true });
  }

  private clearTimers(session: StreamSession): void {
    if (session.outputTimer) { clearTimeout(session.outputTimer); session.outputTimer = null; }
    if (session.reasoningTimer) { clearTimeout(session.reasoningTimer); session.reasoningTimer = null; }
    if (session.childOutputTimer) { clearTimeout(session.childOutputTimer); session.childOutputTimer = null; }
  }
}
