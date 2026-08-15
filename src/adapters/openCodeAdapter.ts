import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentAdapter, AgentApiErrorClass, AgentSession, DisplayPrefsReader, DisplayVerbosityMode, OpenCodePendingQuestion, OpenCodeQuestion, OutputEventMeta, ReattachRecap, RecentTurn, ResolvedThreadDisplayPrefs, ResumeSessionOptions, SeenWatermark, SeenWatermarkWriter, ThinkingEvent, ThreadLocaleReader, ToolResultEvent, ThreadKey } from '../types';
import { keyToString } from '../types';
import { classifyAgentApiError } from '../apiErrorRetry';
import { checkIsInstalled, installTool, checkIsOpenCodeServerRunning, ensureOpenCodeServer, getToolCommand, onOpenCodeServerExit, restartOpenCodeServer } from '../installManager';
import { resolveDataDir } from '../state';
import { appendDiagLog } from '../diagLog';
import {
  checkIsEventForSession,
  checkShouldLogDrop,
  getEventOwnerKey,
  getLineageDepthToAncestor,
  resolveOwnerByDirectoryFallback as resolveOwnerByDirectoryFallbackPure,
  touchLineageOnUse,
  updateSessionLineage,
  type BoundSessionRef,
} from '../openCodeSessionRouting';
import { t, runWithLocale, defaultLocale } from '../i18n';
import { formatResumeContext, resumeContextTurnLimit } from '../resumeContext';
import { stripThreadContextPreamble } from '../threadContextPreamble';
import { getOpenQuestionForSession } from '../openCodeOpenQuestion';
import { buildOpenCodeSchedulerMcpRegistration, schedulerMcpServerName } from '../scheduler/injection';
import {
  buildSessionTitleSnippet,
  checkIsMeaningfulPrompt,
  checkIsPlaceholderTitle,
} from '../openCodeSessionTitle';
import { clampEffortToAvailable, defaultEffortLevel } from '../effortLevels';
import { getSseStreamTransition } from '../utils/sseStreamLifecycle';
import {
  buildDelegatingStatusText,
  getSubagentPartAction,
} from '../utils/subagentRender';
import { defaultDisplayVerbosityMode } from '../utils/displayVerbosity';
import { checkIsWedgedTurn } from '../utils/openCodeTurnActivity';
import {
  parseProviderAuthMethods,
  type OpenCodeAuthMethod,
} from '../utils/openCodeAuthLogin';

const execAsync = promisify(exec);

/**
 * Persist per-thread model selection so it survives bot restarts.
 * Stored in `DATA_DIR` (resolved via `resolveDataDir()` for parity with
 * `state.json` and the Claude adapter) as a JSON map keyed by serialised
 * `ThreadKey`: `{ "<chatId>:<threadId>": "provider/model" }` (plan §10.3, D22).
 *
 * Audit S3 / #9: previous fallback chain `DATA_DIR || HOME || /tmp` drifted
 * from `state.ts:resolveDataDir`, which uses `~/.telegramCode` when
 * `DATA_DIR` is unset. Two bots on one host sharing a Linux user would have
 * stored prefs in `$HOME/.opencode-model-prefs.json` and silently collided.
 *
 * Older versions of the bot used `{ "<userId>": "provider/model" }`. Those
 * entries are silently ignored after the 2.0 upgrade — users can re-select
 * their model via `/model`; we deliberately don't try to migrate (one of two
 * adapters, easy to recover, not worth the migration complexity).
 */
const modelStateFile = path.join(resolveDataDir(), '.opencode-model-prefs.json');

function loadSavedModel(key: ThreadKey): { providerID: string; modelID: string } | null {
  try {
    if (!fs.existsSync(modelStateFile)) return null;
    const data = JSON.parse(fs.readFileSync(modelStateFile, 'utf-8'));
    const saved = data[keyToString(key)] as string | undefined;
    if (!saved) return null;
    const idx = saved.indexOf('/');
    if (idx <= 0) return null;
    return { providerID: saved.slice(0, idx), modelID: saved.slice(idx + 1) };
  } catch (e) {
    // Audit S15: surface and archive a corrupt prefs file so the next
    // save can start clean; previous silent return left users wondering
    // why /model selections didn't stick across restarts.
    console.error(`[OpenCode] loadSavedModel failed:`, e instanceof Error ? e.message : e);
    if (fs.existsSync(modelStateFile)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.renameSync(modelStateFile, `${modelStateFile}.corrupted-${ts}`); }
      catch (re) { console.warn(`[OpenCode] archive of corrupt prefs failed:`, re); }
    }
    return null;
  }
}

function saveModelPref(key: ThreadKey, label: string): void {
  try {
    let data: Record<string, string> = {};
    if (fs.existsSync(modelStateFile)) {
      data = JSON.parse(fs.readFileSync(modelStateFile, 'utf-8'));
    }
    data[keyToString(key)] = label;
    fs.writeFileSync(modelStateFile, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[OpenCode] Failed to save model pref:`, e instanceof Error ? e.message : e);
  }
}

/**
 * @description Per-thread OpenCode effort (variant) selection. Plan
 * 2026-05-30-effort-command, D6 — mirrors the model-prefs pattern above
 * exactly: same DATA_DIR placement, same `{ "<chatId>:<threadId>": "<level>" }`
 * shape, same corrupt-file archive behaviour.
 *
 * Effort is applied **per-prompt** by `sendPromptAsync` as the model
 * `variant` on the prompt body. Persisting it here means the choice
 * survives bot restarts and re-attached SSE sessions.
 */
const effortStateFile = path.join(resolveDataDir(), '.opencode-effort-prefs.json');

function loadEffortPrefs(): Record<string, string> {
  try {
    if (!fs.existsSync(effortStateFile)) return {};
    const raw = fs.readFileSync(effortStateFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch (e) {
    console.error(`[OpenCode] loadEffortPrefs failed:`, e instanceof Error ? e.message : e);
    if (fs.existsSync(effortStateFile)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.renameSync(effortStateFile, `${effortStateFile}.corrupted-${ts}`); }
      catch (re) { console.warn(`[OpenCode] archive of corrupt effort prefs failed:`, re); }
    }
    return {};
  }
}

function loadSavedEffort(key: ThreadKey): string | null {
  const prefs = loadEffortPrefs();
  return prefs[keyToString(key)] ?? null;
}

function saveEffortPref(key: ThreadKey, level: string): void {
  try {
    const data = loadEffortPrefs();
    data[keyToString(key)] = level;
    fs.writeFileSync(effortStateFile, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[OpenCode] Failed to save effort pref:`, e instanceof Error ? e.message : e);
  }
}

function clearEffortPref(key: ThreadKey): void {
  try {
    const data = loadEffortPrefs();
    if (!(keyToString(key) in data)) return;
    delete data[keyToString(key)];
    fs.writeFileSync(effortStateFile, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[OpenCode] Failed to clear effort pref:`, e instanceof Error ? e.message : e);
  }
}

interface OpenCodeModelOverride {
  providerID: string;
  modelID: string;
}

interface OpenCodeSessionStatus {
  type?: string;
  attempt?: number;
  message?: string;
  next?: number;
}

interface OpenCodeSession {
  key: ThreadKey;
  sessionId: string;
  workDir: string;
  isActive: boolean;
  /** Accumulated text parts for current response */
  currentResponseText: string;
  /**
   * Length (chars) of {@link currentResponseText} that has already been
   * emitted as an `output` event. Both emit sites (the debounce timer in
   * `handleTextDelta` and `flushOutput`) send only the unsent tail
   * `currentResponseText.slice(lastEmittedLength)` and advance this, so the
   * full response reaches Telegram exactly once. Reset to 0 wherever
   * `currentResponseText` is reset to `''`.
   */
  lastEmittedLength: number;
  /** Timer for batching SSE deltas before emitting output */
  outputTimer: NodeJS.Timeout | null;
  /**
   * Accumulated SUB-AGENT (child session) text for the current turn, streamed
   * only in `/subagent full` mode. Kept strictly SEPARATE from
   * {@link currentResponseText}: a child transcript must never advance the
   * parent's emit cursor / continuation accounting. Reset wherever
   * `currentResponseText` is reset.
   */
  childResponseText: string;
  /** Emit cursor over {@link childResponseText} (same tail-emit discipline as
   * {@link lastEmittedLength}). Reset alongside it. */
  childLastEmittedLength: number;
  /** Debounce timer for child text deltas — mirrors {@link outputTimer} but
   * over the child accumulator, so the two streams never share a flush. */
  childOutputTimer: NodeJS.Timeout | null;
  /**
   * Title of the delegation currently running in a child session, recorded
   * from the parent's `task` tool part (`state.title` / `state.input.description`)
   * while it is pending/running and cleared when it completes/errors. Drives
   * the status-only-mode "🤖 sub-agent: <title> …" status (S4) and is the field
   * the S5 "Delegating" activity status will reuse. v1 tracks ONE delegation —
   * parallel tasks are last-writer-wins and the first completion clears.
   */
  activeSubagentTitle: string | null;
  /** Whether model info has been shown to the user (shown once on first response) */
  isModelInfoShown: boolean;
  /** Model override for this session (passed with each prompt) */
  modelOverride: OpenCodeModelOverride | null;
  /** Last known model label from SSE events */
  currentModelLabel: string | null;
  /** Map partID -> part type for resolving delta events */
  partTypes: Map<string, string>;
  /** Timer for debouncing status (tool/reasoning) updates */
  statusDebounceTimer: NodeJS.Timeout | null;
  /** Latest status text pending emission */
  pendingStatus: string | null;
  /**
   * Accumulated reasoning (chain-of-thought) text for the CURRENT response,
   * kept strictly SEPARATE from {@link currentResponseText} so it never leaks
   * into the answer (or its continuation accounting). Reset to `''` when a new
   * reasoning stream starts or the response's reasoning ends.
   */
  reasoningText: string;
  /**
   * Epoch ms of the FIRST reasoning delta of the current response, or `null`
   * when no reasoning is in flight. Drives the "thought for {N}s" duration on
   * the `thinking` `done` emit; reset on reasoning end.
   */
  reasoningStartedAt: number | null;
  /**
   * Debounce timer for the live `thinking` emit — the reasoning delta stream is
   * chatty, so live emits are coalesced the same way text deltas are.
   */
  reasoningTimer: NodeJS.Timeout | null;
  /**
   * Part ids whose completed tool OUTPUT has already been emitted as a
   * `toolResult` event — OpenCode re-sends a part on every state change (and
   * may re-deliver the completed shape), so without this guard one result
   * would reach the topic several times. Cleared on the NEXT prompt (not on
   * the turn flush): part re-deliveries can straddle the finish/idle flush,
   * and since part ids are unique a late clear can never suppress a genuine
   * new result — while an early clear would re-open the double-emit window.
   */
  emittedToolResultPartIds: Set<string>;
  /** Pending question awaiting user's answer */
  pendingQuestion: OpenCodePendingQuestion | null;
  /**
   * Currently selected reasoning-effort level (a model variant) for this
   * thread, or `null` if none has been chosen. Applied per-prompt by
   * `sendPromptAsync` as `body.variant` on the prompt request.
   */
  effortLevel: string | null;
  /**
   * Whether this session is mid-generation. Tracked from SSE `session.status`
   * (and cleared on `session.idle`); set optimistically when a prompt is sent.
   * Drives {@link checkIsOpenCodeSessionBusy} (the scheduler's wait-for-idle
   * probe). A normal busy turn queues new prompts, but a provider-managed
   * `retry` is different: OpenCode will not read the queue until its retry time,
   * so the next user prompt aborts that stale turn before using the current
   * model override.
   */
  isBusy: boolean;
  /**
   * Whether a prompt was sent and we are still waiting for the turn it started
   * to resolve at the next own-session `session.idle`. Reset on each prompt send;
   * cleared on the resolving idle. With {@link sawTurnActivity} it drives the
   * "prompt delivered but the agent never ran a turn" detector (a WEDGED session
   * accepts the prompt then idles with no assistant activity — live 2026-08-15).
   */
  awaitingTurnResponse: boolean;
  /**
   * Whether ANY assistant activity (message.updated / part, own OR sub-agent
   * child) was observed since the last prompt was sent. Reset false on prompt
   * send; a healthy turn always sets it. Its absence at idle is the wedge signal.
   */
  sawTurnActivity: boolean;
  /**
   * Signature of the current provider-managed `session.status=retry`, or null.
   * Doubles as the one-notice-per-retry dedup key and the signal that the next
   * user prompt must interrupt the wait instead of queueing behind it.
   */
  providerRetrySignature: string | null;
  /** Ignore stale model updates until the post-abort selected-model turn starts. */
  isAwaitingModelAfterProviderRetryAbort: boolean;
  /** Shared abort request so concurrent prompts cannot race abort-after-prompt. */
  providerRetryAbortPromise: Promise<void> | null;
  /**
   * Whether context compaction is in flight (between
   * `session.next.compaction.started` and `…ended` / `session.compacted`).
   * Counts as busy for {@link checkIsOpenCodeSessionBusy}.
   */
  isCompacting: boolean;
  /**
   * Child (sub-agent) session ids currently busy, learned from routed
   * `session.status` events. A running sub-agent counts as busy for
   * {@link checkIsOpenCodeSessionBusy}. Cleared per-child when that child
   * goes idle.
   */
  busyChildSessionIds: Set<string>;
  /**
   * Id of the LAST completed parent assistant message of the turn, captured from
   * the message events (no extra HTTP). Advanced to the persisted
   * {@link SeenWatermark} on each parent-message `finish` (S7 — so a mid-turn
   * restart re-counts nothing already relayed) and again on `session.idle` (the
   * safety net), so a bot restart can count only the assistant messages produced
   * after it (the reattach recap). `undefined` until the first assistant message
   * finishes.
   */
  lastMessageId?: string;
  /**
   * Whether this session may still be renamed by the bot-side fallback. Set
   * `true` only for sessions the bot created WITHOUT explicit `/opencode args`
   * (those rely on opencode's native auto-title — R1). Cleared on the first
   * meaningful prompt once the fallback has run (or decided auto-title already
   * named it), so the bot never overwrites a real name and PATCHes at most
   * once. Resumed / args-titled sessions start `false` — never auto-renamed.
   */
  isAutoNamePending: boolean;
}

interface OpenCodeApiSession {
  id: string;
  slug?: string;
  title?: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

/**
 * @description SSE event envelope from OpenCode server.
 * All SSE messages are `data:` lines containing JSON with { type, properties }.
 * There are no `event:` lines — the event type is inside the JSON payload.
 */
interface OpenCodeSseEvent {
  type: string;
  properties: Record<string, unknown>;
  /**
   * Owning project-instance directory from the `/global/event` envelope
   * (`{ directory, payload }`). The server multiplexes one PROJECT INSTANCE
   * per directory, and instance-local state (pending questions, permissions)
   * is only reachable when the request selects that instance via
   * `?directory=` — a reply sent without it lands in the serve-cwd default
   * instance and 404s (`QuestionNotFoundError`). Absent on the bare
   * `/event` shape, which is instance-local by construction.
   */
  directory?: string;
}

/**
 * @description The adapter's SINGLE live SSE stream over `/global/event` (plan
 * 2026-06-17). One multiplexed stream carries every project instance's events
 * for the whole server, each wrapped in `payload` and tagged with a top-level
 * `directory` field. The bot parses each event exactly once and routes it by
 * the envelope `directory` + `sessionID`. Opened when the FIRST active session
 * (any folder) appears, closed when the LAST one goes away.
 *
 * Background (why not `/event?directory=<dir>`): on opencode 1.14.41 the
 * per-directory endpoint stops delivering session events to an aged sole
 * subscriber (it keeps emitting `server.heartbeat`, so the stall watchdog never
 * trips) — the topic then hangs. `/global/event` delivers reliably regardless
 * of connection age (plan 2026-06-17 S1).
 */
interface SseStreamState {
  /**
   * A fixed label for this stream in logs/diag (`globalStreamLabel`). No longer
   * a `?directory=` selector — the global stream has no per-folder scope; the
   * owning directory of each event comes from the event envelope instead.
   */
  directory: string;
  /**
   * Abort controller for the live `fetch` + reader. `.abort()` unblocks the
   * parked `reader.read()` immediately on teardown or stall, instead of waiting
   * for the server to deliver the next byte (audit S7 / #12).
   */
  controller: AbortController | null;
  /**
   * Stall watchdog `setTimeout`. OpenCode emits a `server.heartbeat` every
   * ~10 s, so a live stream always delivers bytes within `sseStallTimeoutMs`;
   * if none arrive the socket is silently dead (open TCP, no FIN/RST) and
   * `reader.read()` would park forever. Firing aborts the controller so the
   * reader reconnects.
   */
  stallTimer: NodeJS.Timeout | null;
  /**
   * Reconnect `setTimeout`. Cleared on teardown so a fired callback can't
   * re-enter the reader loop for a stream whose last session is already gone
   * (audit S8 / #14).
   */
  reconnectTimer: NodeJS.Timeout | null;
  /**
   * Latch flipped to `true` by teardown so an in-flight reconnect/await that
   * resumes after the stream is closed exits instead of reopening it. A closed
   * stream reference is also dropped from `globalStream`, but a reconnect
   * promise may already hold a stale reference.
   */
  isClosed: boolean;
}

/**
 * OpenCode `/global/event` wraps the real event in `payload`, while `/event`
 * emits it directly. Normalise both shapes before dispatching.
 */
export function normaliseOpenCodeSseEvent(raw: unknown): OpenCodeSseEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const event = typeof candidate.type === 'string'
    ? candidate
    : candidate.payload && typeof candidate.payload === 'object'
      ? candidate.payload as Record<string, unknown>
      : null;
  if (!event || typeof event.type !== 'string') return null;
  const properties = event.properties && typeof event.properties === 'object'
    ? event.properties as Record<string, unknown>
    : {};
  const directory = typeof candidate.directory === 'string' && candidate.directory
    ? candidate.directory
    : undefined;
  return directory !== undefined
    ? { type: event.type, properties, directory }
    : { type: event.type, properties };
}

/**
 * @description Append the `?directory=` instance selector to an API path when
 * the owning instance is known. Without it the server resolves its serve-cwd
 * default instance, whose in-memory state (questions, permissions) does not
 * contain requests raised in other project instances — the reply then fails
 * with 404 even though the request is alive in its own instance.
 */
export function buildDirectoryScopedPath(basePath: string, directory: string | undefined): string {
  if (!directory) return basePath;
  return `${basePath}?directory=${encodeURIComponent(directory)}`;
}

interface OpenCodePart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  /** Tool part fields */
  tool?: string;
  callID?: string;
  state?: OpenCodeToolState;
}

interface OpenCodeToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: Record<string, unknown>;
  raw?: string;
  title?: string;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

// The interactive-question shapes moved to `types.ts` (a leaf module) so they
// can be persisted from `state.ts` without an adapter→state import cycle.
// Re-exported here so existing importers keep resolving them from the adapter.
export type {
  OpenCodeQuestionOption,
  OpenCodeQuestion,
  OpenCodePendingQuestion,
} from '../types';

interface OpenCodeMessageInfo {
  id?: string;
  sessionID?: string;
  role?: string;
  finish?: string;
  error?: unknown;
  modelID?: string;
  providerID?: string;
}

/**
 * @description One record from `GET /session/:id/message`: the stored message
 * `info` (carries `role`) plus its `parts` array (text / tool / step parts).
 * Same `parts` shape the SSE `message.part.updated` path handles. Fields are
 * optional — guarded at the parse boundary in {@link mapOpenCodeMessagesToTurns}.
 */
interface OpenCodeMessageRecord {
  info?: OpenCodeMessageInfo;
  parts?: OpenCodePart[];
}

/**
 * @description One renderability rule for a message `part`, shared by
 * {@link mapOpenCodeMessagesToTurns} (turn body) and
 * {@link countOpenCodeAssistantMessagesSinceId} (missed count) so both agree on
 * what counts as visible prose: a non-empty `{ type: 'text' }` part (tool / step
 * / empty parts don't count). Type guard so the caller can read `part.text` as a
 * string without a cast.
 */
function checkIsRenderableTextPart(part: OpenCodePart): part is OpenCodePart & { text: string } {
  return (
    !!part &&
    typeof part === 'object' &&
    part.type === 'text' &&
    typeof part.text === 'string' &&
    part.text.trim().length > 0
  );
}

/**
 * @description Map raw `GET /session/:id/message` records to the last `limit`
 * conversational turns (oldest→newest) for the resume context block.
 *
 * Pure + exported (no I/O) so it is unit-testable. For each record it joins the
 * text of every `{ type: 'text' }` part (skipping tool / step / empty parts),
 * trims, and emits a {@link RecentTurn} only when the role is user/assistant
 * AND the joined text is non-empty. Every field is guarded with `typeof` /
 * `Array.isArray` so a malformed record is skipped, never crashes — no casts.
 * Keeps only the last `limit` turns.
 */
export function mapOpenCodeMessagesToTurns(records: unknown, limit: number): RecentTurn[] {
  if (!Array.isArray(records)) return [];
  const turns: RecentTurn[] = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const { info, parts } = record as OpenCodeMessageRecord;
    const role = info?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (!Array.isArray(parts)) continue;
    const textChunks: string[] = [];
    for (const part of parts) {
      if (checkIsRenderableTextPart(part)) textChunks.push(part.text.trim());
    }
    if (textChunks.length === 0) continue;
    turns.push({ role, text: textChunks.join('\n\n') });
  }
  return turns.slice(-limit);
}

/**
 * @description Count the renderable assistant messages that appear AFTER the
 * watermark message in a `GET /session/:id/message` payload — the OpenCode side
 * of "how many agent messages did the user miss while the bot was down".
 *
 * Pure + exported (no I/O) so it is unit-testable against a records array. Walks
 * the chronological records (oldest→newest), skipping everything up to and
 * including the message whose `info.id === watermarkId`, then counts each later
 * `assistant`-role record that carries at least one non-empty text part (the
 * same renderability rule as {@link mapOpenCodeMessagesToTurns}, so the count
 * matches what a turn body would show).
 *
 * `isWatermarkKnown` is `false` — and `missedCount` `0` — when the payload is
 * not an array, no `watermarkId` was given, or the id is absent from the records
 * (pruned / different session). The caller treats that as the fallback
 * (no-count) recap, never a crash.
 */
export function countOpenCodeAssistantMessagesSinceId(
  records: unknown,
  watermarkId: string | undefined,
): { missedCount: number; isWatermarkKnown: boolean } {
  if (!Array.isArray(records) || !watermarkId) {
    return { missedCount: 0, isWatermarkKnown: false };
  }
  let foundWatermark = false;
  let missedCount = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const { info, parts } = record as OpenCodeMessageRecord;
    if (!foundWatermark) {
      if (info?.id === watermarkId) foundWatermark = true;
      continue;
    }
    if (info?.role !== 'assistant' || !Array.isArray(parts)) continue;
    if (parts.some(checkIsRenderableTextPart)) missedCount += 1;
  }
  if (!foundWatermark) return { missedCount: 0, isWatermarkKnown: false };
  return { missedCount, isWatermarkKnown: true };
}

/**
 * @description Last assistant message `id` in a `GET /session/:id/message`
 * payload — the OpenCode reattach-recap HEAD watermark ("everything currently in
 * the record is accounted for"). Pure + exported (no I/O) so it is unit-testable.
 *
 * Walks the chronological records and returns the `info.id` of the LAST record
 * whose `info.role === 'assistant'` and whose `info.id` is a string; returns
 * `undefined` for a non-array payload or when no assistant message carries an id
 * (head unknown → the caller omits the watermark and retries next reattach).
 *
 * Anchors on the last ASSISTANT message (not the last record of any role) to
 * mirror the live-advance watermark ({@link OpenCodeSession.lastMessageId}, set
 * on the parent turn's final assistant message) and the count keyed off it in
 * {@link countOpenCodeAssistantMessagesSinceId} — so the next reattach's
 * `[watermark, …)` window starts at the true tail and yields 0 on a clean
 * reattach. Unlike the missed-count it does NOT require renderable text: the
 * watermark must advance past every assistant message seen, tool-only ones too.
 */
export function getLatestOpenCodeAssistantMessageId(records: unknown): string | undefined {
  if (!Array.isArray(records)) return undefined;
  let latestId: string | undefined;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const { info } = record as OpenCodeMessageRecord;
    if (info?.role === 'assistant' && typeof info.id === 'string') latestId = info.id;
  }
  return latestId;
}

/**
 * @description Best-effort "the turn is still in flight" signal for the reattach
 * recap, derived from the already-fetched `GET /session/:id/message` payload —
 * NO extra HTTP probe. True only when the LAST record is an `assistant` message
 * with no `finish` reason yet (a turn the agent was mid-way through when the bot
 * went down). Any uncertainty (empty / non-array payload, last record not a
 * finished-less assistant message) → `false`, so the trailing "still working"
 * line is never shown on a guess.
 */
export function checkIsOpenCodeTurnInFlight(records: unknown): boolean {
  if (!Array.isArray(records) || records.length === 0) return false;
  const last = records[records.length - 1];
  if (!last || typeof last !== 'object') return false;
  const { info } = last as OpenCodeMessageRecord;
  return info?.role === 'assistant' && info.finish === undefined;
}

/**
 * Shape of `properties.info` carrying the child→parent session link used for
 * subagent routing. Reliably present on `session.updated`; lineage is also
 * recorded opportunistically from any other event that happens to expose
 * `parentID` (S2 durability), so a child's link is known before its first
 * routed event rather than only at the next `session.updated` beat.
 */
interface OpenCodeSessionUpdatedInfo {
  id?: string;
  parentID?: string;
}

/** Delay (ms) to batch SSE text deltas before emitting output event */
const sseOutputBatchMs = 500;

/**
 * Name of OpenCode's delegation tool — the parent session invokes it to run a
 * sub-agent in a CHILD session (verified live 2026-06-10: its tool part carries
 * `state.title` + `state.input.{description, subagent_type, prompt}`, and the
 * completed `state.output` embeds the child session id).
 */
const delegationToolName = 'task';

/**
 * Fixed `SseStreamState.directory` label for the single `/global/event` stream
 * in logs/diag. The global stream has no per-folder scope (it multiplexes every
 * project instance), so its "directory" is a constant marker, not a selector.
 */
const globalStreamLabel = '<global>';

/** Base delay (ms) for exponential backoff on SSE reconnect */
const sseReconnectBaseDelayMs = 2000;

/**
 * SSE reconnect never gives up — the bot must reconnect until success — but the
 * backoff is capped so steady-state retries settle at a fixed interval instead
 * of growing unbounded: delay = min(base · 2^min(attempt, exp), maxDelay).
 */
const maxSseReconnectBackoffExponent = 5;
const maxSseReconnectDelayMs = 60_000;

/** Measured cadence of OpenCode `server.heartbeat` on the global event stream. */
const sseHeartbeatIntervalMs = 10_000;
/**
 * If no SSE bytes — not even a heartbeat — arrive within this window, the
 * stream is silently dead (TCP still open, nothing delivered) and the parked
 * `reader.read()` would never return. 4× the heartbeat tolerates a few dropped
 * beats before forcing a reconnect, so it can't false-fire on a healthy idle
 * stream.
 */
const sseStallTimeoutMs = sseHeartbeatIntervalMs * 4;

/** Cap on tracked child→parent session links (subagent lineage). */
const maxTrackedSessionLineageEntries = 1000;

/**
 * Minimum gap between diag-logged "sse drop" lines for the SAME
 * (eventType, eventSessionId). A truly orphaned session streams hundreds of
 * deltas; without throttling the diag log floods (B19). One line per
 * (type, session) per window is enough to spot a lost turn.
 */
const sseDropLogThrottleMs = 60_000;
/** Bound on the drop-throttle map so an unbounded run of distinct orphan
 * sessions can't grow it without limit (matches the lineage-map discipline). */
const maxSseDropThrottleEntries = 500;
/** Synthetic "event type" namespacing the throttle key for ignored foreign
 * busy=true status events, so they share the drop-throttle map without
 * colliding with real `session.status` drop entries. */
const foreignBusyIgnoredLogType = 'busy-ignored';

/**
 * SSE event types whose loss makes a turn silently hang — diag-logged on drop.
 * `question.asked` / `permission.asked` are here so an unrouted one is LOGGED
 * (the user's question vanishing silently was the worst failure mode): they DO
 * carry a real top-level `sessionID` in the current OpenCode build (verified
 * live 2026-06-08), so they resolve like any other event — by sessionID, with a
 * directory fallback — and a genuine miss is loud, never a no-op.
 */
export const criticalSseEventTypes = new Set<string>([
  'message.part.updated',
  'message.part.delta',
  'message.updated',
  'session.idle',
  'session.error',
  'question.asked',
  'permission.asked',
]);

/**
 * Event types the dispatcher intentionally ignores WITHOUT a stdout log. On the
 * global stream the bot sees OWNED sessions emit global-only bookkeeping events
 * (`sync` / `session.diff`) the per-directory stream never surfaced; logging
 * each "unhandled SSE event" would spam stdout (plan 2026-06-17 S2). The silent
 * `server.heartbeat` is handled before dispatch and is not listed here.
 */
const ignoredSseEventTypes = new Set<string>(['sync', 'session.diff']);

/**
 * @description Grace period before the bot-side fallback rename checks whether
 * opencode's native auto-title has landed. Auto-title is generated as a side
 * effect of the first prompt's LLM turn; it was observed live to appear within
 * ~2-3 s. We wait comfortably longer so the fallback only fires when auto-title
 * genuinely failed — it must never overwrite a real LLM name with a raw snippet.
 */
const fallbackRenameGraceMs = 8000;
/** Milliseconds per minute for rendering OpenCode's provider-retry notice. */
const providerRetryMsPerMinute = 60_000;

/**
 * @description Whether a `session.error` message is the bot-issued abort of a
 * running generation (`POST /session/:id/abort`) — the ONLY source of an
 * "Aborted" error in OpenCode (the user has no other abort trigger). It fires
 * on the question-cancel SIGINT, `/esc`, and the provider-retry interrupt, and
 * must be SWALLOWED rather than surfaced as "OpenCode error: Aborted" — that
 * bogus line was the third message on the question-cancel path (parity with the
 * json-stream "Claude error: API error" swallow). Matched as the exact bare
 * word so a real provider error that merely quotes "aborted" still surfaces.
 */
export function checkIsOpenCodeAbortError(errorMsg: string): boolean {
  return errorMsg.trim().toLowerCase() === 'aborted';
}

/**
 * @description Live busy-relevant state of an OpenCode session, derived from
 * SSE events (not an HTTP poll — the stream catches sub-100 ms busy/idle
 * transitions an HTTP poll races past).
 */
export interface OpenCodeBusyState {
  /** Own session is mid-generation (`session.status` = busy). */
  isBusy: boolean;
  /** Context compaction is in flight. */
  isCompacting: boolean;
  /** Number of child (sub-agent) sessions currently busy. */
  busyChildCount: number;
}

/**
 * @description Sync "is this session occupied with a turn?" decision for the
 * scheduler's wait-for-idle loop ({@link AgentAdapter.checkIsBusy}): busy when
 * its own generation runs, a sub-agent runs, or context is compacting. This is
 * a read-only probe — a new prompt to a busy session is never aborted; OpenCode
 * queues it via `prompt_async` and reads it promptly, so unlike the Claude TUI
 * there is no interrupt-before-prompt (user decision 2026-06-06). Pure +
 * exported for unit testing.
 */
export function checkIsOpenCodeSessionBusy(state: OpenCodeBusyState): boolean {
  return state.isBusy || state.isCompacting || state.busyChildCount > 0;
}

/** Mutable busy-tracking slice of a session, updated from SSE status/idle events. */
export interface OpenCodeBusyTracking {
  isBusy: boolean;
  busyChildSessionIds: Set<string>;
}

/**
 * @description Apply a busy/idle transition (from `session.status` or
 * `session.idle`) to a session's busy-tracking state. The own session's status
 * drives `isBusy`; a lineage-VERIFIED descendant's (sub-agent child session's)
 * status maintains `busyChildSessionIds` — a child going idle must NOT clear
 * the parent's `isBusy`. A foreign non-descendant id (e.g. a wedged sibling
 * top-level session routed in via the directory fallback) is never recorded:
 * its busy=true is ignored — recording it would pin the thread busy forever,
 * since a wedged session never goes idle (live incident 2026-06-10) — while
 * its busy=false still deletes, self-healing ids that slipped in before
 * verification existed. Pure + exported so the routing is unit-testable.
 *
 * @returns `true` when a foreign non-descendant busy=true was ignored, so the
 * caller can diag-log it (throttled — never per event).
 */
export function applyOpenCodeStatusEvent(
  tracking: OpenCodeBusyTracking,
  ownSessionId: string,
  eventSessionId: string | null,
  isBusy: boolean,
  isVerifiedDescendant: boolean,
): boolean {
  if (!eventSessionId || eventSessionId === ownSessionId) {
    tracking.isBusy = isBusy;
  } else if (!isBusy) {
    tracking.busyChildSessionIds.delete(eventSessionId);
  } else if (isVerifiedDescendant) {
    tracking.busyChildSessionIds.add(eventSessionId);
  } else {
    return true;
  }
  return false;
}

/**
 * @description Default timeout for non-SSE HTTP requests to OpenCode.
 * 30 s comfortably covers `prompt_async` (returns 204 immediately) and
 * `getSessions` / `getModels` (file scans on the server side). The SSE
 * stream uses its own long-lived connection without this timeout.
 */
const apiRequestTimeoutMs = 30_000;

/**
 * @description Validate `OPENCODE_URL`. SSRF guard for audit S7 / #34:
 * an operator-controlled env var was previously trusted verbatim, so a
 * misconfigured `OPENCODE_URL=http://169.254.169.254/` (or similar
 * metadata endpoint) would route every adapter call to that host. We
 * restrict the scheme to http/https and the host to loopback unless
 * `OPENCODE_ALLOW_REMOTE=1` opts in.
 */
function validateOpenCodeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`OPENCODE_URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`OPENCODE_URL must use http(s); got ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLoopback && process.env.OPENCODE_ALLOW_REMOTE !== '1') {
    throw new Error(
      `OPENCODE_URL points at non-loopback host ${host}; set OPENCODE_ALLOW_REMOTE=1 to allow remote OpenCode servers`,
    );
  }
  return parsed.origin + parsed.pathname.replace(/\/$/, '');
}

/** Cache for available models from OpenCode CLI */
let cachedModels: string[] | null = null;
let modelsCacheTime = 0;
const modelsCacheTtlMs = 5 * 60 * 1000; // 5 minutes

/**
 * @description Cache for `GET /config/providers` (OpenCode 1.15.x). Same
 * 5-minute TTL as the models cache — variant maps change about as often as
 * the model list (operator edits `opencode.json`, restarts server).
 *
 * Plan 2026-05-30-effort-command, R2: log the raw shape ONCE before
 * relying on it; the docs aren't 100% authoritative across server versions.
 *
 * Shape (observed against opencode 1.15.12):
 *   { providers: [ { id, name, models: { <modelId>: { variants?: {...} } } } ] }
 * but newer versions may key by provider id directly. The parser below
 * tolerates both.
 */
let cachedProviders: ParsedProvidersConfig | null = null;
let providersCacheTime = 0;
const providersCacheTtlMs = 5 * 60 * 1000;
let isProvidersShapeLogged = false;

const providerIdRe = /^[a-z0-9][a-z0-9-_]*$/;

interface OpenCodeProviderAuthMethod {
  type?: string;
  prompts?: unknown[];
}

/**
 * @description Provider → model → variant-names map. Keys are provider ids
 * (e.g. `"anthropic"`, `"openai"`), values are model ids (e.g.
 * `"claude-3-5-sonnet"`) mapping to the list of variant names declared
 * on that model. A model with no `variants` entry maps to `[]`, which
 * the picker treats as "this model has no effort concept".
 */
export interface ParsedProvidersConfig {
  providers: Map<string, Map<string, string[]>>;
}

/**
 * @description Build the JSON body for a `prompt_async` POST. Pure + exported
 * so the two per-prompt overrides — the model selector and the reasoning-effort
 * `variant` — can be unit-tested without a live session. Both are optional and
 * ride the same body, parallel to each other.
 *
 * @returns Body with `parts` always present; `model` only when a model override
 * is set; `variant` only when an effort level is set.
 */
export function buildPromptBody(
  input: string,
  modelOverride: { providerID: string; modelID: string } | null,
  effortLevel: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text: input }],
  };
  if (modelOverride) {
    const modelParam: Record<string, string> = { modelID: modelOverride.modelID };
    if (modelOverride.providerID) {
      modelParam.providerID = modelOverride.providerID;
    }
    body.model = modelParam;
  }
  if (effortLevel) {
    body.variant = effortLevel;
  }
  return body;
}

export function checkIsValidProviderId(providerId: string): boolean {
  return providerIdRe.test(providerId);
}

export function buildProviderAuthPath(providerId: string): string {
  return `/auth/${encodeURIComponent(providerId)}`;
}

/**
 * @description Pure decision for the boot self-heal: given opencode's live
 * `GET /mcp` status map (`{ <serverName>: { status, error? }, … }`), does the
 * bot-owned `telegramBot` server need a (re)registration? True when the entry is
 * ABSENT (never registered on this server generation) or its `status` is
 * anything other than `connected` (e.g. `failed` — a stale registration to a
 * dead port left by a previous bot generation). A malformed/empty response is
 * treated as "needs register": a redundant POST is a harmless overwrite on the
 * server, whereas skipping a real failure would leave agents without the tools.
 */
export function checkNeedsSchedulerMcpReregister(mcpStatus: unknown): boolean {
  if (!mcpStatus || typeof mcpStatus !== 'object') return true;
  const entry = (mcpStatus as Record<string, unknown>)[schedulerMcpServerName];
  if (!entry || typeof entry !== 'object') return true;
  return (entry as Record<string, unknown>).status !== 'connected';
}

export function buildProviderApiAuthPayload(apiKey: string): Record<string, string> {
  return { type: 'api', key: apiKey };
}

export function checkProviderSupportsSimpleApiAuth(raw: unknown, providerId: string): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const root = raw as Record<string, unknown>;
  const methods = root[providerId];
  if (!Array.isArray(methods)) return false;
  return methods.some((method) => {
    if (!method || typeof method !== 'object') return false;
    const { type, prompts } = method as OpenCodeProviderAuthMethod;
    return type === 'api' && (!Array.isArray(prompts) || prompts.length === 0);
  });
}

function resetOpenCodeProviderCaches(): void {
  cachedModels = null;
  modelsCacheTime = 0;
  cachedProviders = null;
  providersCacheTime = 0;
}

export function parseProvidersResponse(raw: unknown): ParsedProvidersConfig {
  const out: ParsedProvidersConfig = { providers: new Map() };
  if (!raw || typeof raw !== 'object') return out;
  const root = raw as Record<string, unknown>;

  // Two shapes seen in the wild: `{ providers: [...] }` (array, opencode
  // 1.15.x) and `{ providers: { <id>: {...} } }` (older bundles). Parse
  // both into the same flat (providerId → modelId → variantNames) map so
  // the rest of the code doesn't care which shape the server sent.
  const collect = (providerId: string, providerObj: unknown): void => {
    if (!providerObj || typeof providerObj !== 'object') return;
    const models = (providerObj as Record<string, unknown>).models;
    if (!models || typeof models !== 'object') return;
    const modelMap = new Map<string, string[]>();
    for (const [modelId, modelObj] of Object.entries(models as Record<string, unknown>)) {
      const variants = modelObj && typeof modelObj === 'object'
        ? (modelObj as Record<string, unknown>).variants
        : undefined;
      if (variants && typeof variants === 'object' && !Array.isArray(variants)) {
        modelMap.set(modelId, Object.keys(variants as Record<string, unknown>));
      } else {
        modelMap.set(modelId, []);
      }
    }
    out.providers.set(providerId, modelMap);
  };

  const providersField = root.providers;
  if (Array.isArray(providersField)) {
    for (const item of providersField) {
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string') {
        const id = (item as Record<string, unknown>).id as string;
        collect(id, item);
      }
    }
  } else if (providersField && typeof providersField === 'object') {
    for (const [id, value] of Object.entries(providersField as Record<string, unknown>)) {
      collect(id, value);
    }
  }
  return out;
}

/**
 * @description Fetch available models from OpenCode CLI.
 * Results are cached for 5 minutes.
 */
async function fetchAvailableModels(): Promise<string[]> {
  const now = Date.now();
  if (cachedModels && now - modelsCacheTime < modelsCacheTtlMs) {
    return cachedModels;
  }
  
  try {
    const opencodeCmd = getToolCommand('opencode');
    const { stdout } = await execAsync(`${opencodeCmd} models`, { timeout: 10000 });
    const models = stdout.trim().split('\n').filter(line => line.includes('/'));
    if (models.length > 0) {
      cachedModels = models;
      modelsCacheTime = now;
      console.log(`[OpenCode] Fetched ${models.length} models from CLI`);
    }
    return models;
  } catch (e) {
    console.log(`[OpenCode] Failed to fetch models:`, e instanceof Error ? e.message : e);
    return cachedModels || [];
  }
}

/**
 * @description Find model by partial match in available models.
 * Searches for models containing the query string (case-insensitive).
 */
function findModelByQuery(query: string, models: string[]): string | null {
  const normalized = query.toLowerCase().trim().replace(/\s+/g, '-');
  
  // Exact match first
  const exact = models.find(m => m.toLowerCase() === normalized);
  if (exact) return exact;
  
  // Match by model name part (after /)
  const byModelName = models.find(m => {
    const modelPart = m.split('/').slice(1).join('/').toLowerCase();
    return modelPart === normalized || modelPart.includes(normalized);
  });
  if (byModelName) return byModelName;
  
  // Fuzzy match - contains query anywhere
  const fuzzy = models.find(m => m.toLowerCase().includes(normalized));
  if (fuzzy) return fuzzy;
  
  return null;
}

/**
 * @description Resolve model input to provider/modelId format.
 * Accepts full format (provider/model) or partial query to search in available models.
 */
async function resolveModelId(input: string, models: string[]): Promise<{ providerID: string; modelID: string } | null> {
  const trimmed = input.trim();
  
  // If already in provider/model format, validate it exists
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex > 0) {
    const providerID = trimmed.slice(0, slashIndex);
    const modelID = trimmed.slice(slashIndex + 1);
    // Check if model exists in available list
    const exists = models.some(m => m.toLowerCase() === trimmed.toLowerCase());
    if (exists || models.length === 0) {
      return { providerID, modelID };
    }
    // Model not in list, but might be valid - allow it with warning
    console.log(`[OpenCode] Model "${trimmed}" not in available list, using anyway`);
    return { providerID, modelID };
  }
  
  // Search by partial match
  const found = findModelByQuery(trimmed, models);
  if (found) {
    const foundSlash = found.indexOf('/');
    return {
      providerID: found.slice(0, foundSlash),
      modelID: found.slice(foundSlash + 1),
    };
  }
  
  return null;
}

export class OpenCodeAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'opencode';
  readonly label = 'OpenCode';

  /**
   * Map of serialised `ThreadKey` (`"<chatId>:<threadId>"`) → live session.
   * Keyed by string rather than `ThreadKey` object so map lookups work — JS
   * `Map` compares object identity, not structural equality.
   */
  private sessions: Map<string, OpenCodeSession> = new Map();

  /**
   * The ONE `/global/event` SSE stream for the whole adapter (plan 2026-06-17).
   * It multiplexes every project instance's events, each tagged with a top-level
   * `directory` field, so a single reader parses each event once and routes it
   * by envelope `directory` + `sessionID`. Opened when the FIRST active session
   * (any folder) appears, closed when the LAST one goes away. `null` while no
   * session is active.
   */
  private globalStream: SseStreamState | null = null;

  /**
   * Directories whose OpenCode instance already has the bot's scheduler MCP
   * server registered for the CURRENT server generation (plan 2026-06-17 S3).
   * Registration is now per directory on session start (decoupled from the
   * stream, which is no longer per-folder); the Set gates it to once per
   * directory per generation and is cleared on `restartServer` so each dir is
   * re-registered after the server (and its in-memory MCP table) restarts.
   */
  private registeredSchedulerMcpDirs: Set<string> = new Set();

  /**
   * child sessionID → parent sessionID, learned from `session.updated` events.
   * OpenCode runs subagents (e.g. `@explore`) in child sessions whose SSE
   * events carry the child id; this map routes them back to the topic bound to
   * the parent. Bounded by `maxTrackedSessionLineageEntries`.
   */
  private sessionLineage: Map<string, string> = new Map();

  /**
   * Last diag-log timestamp per `"<eventType>|<eventSessionId>"`, so a flood of
   * dropped events for an orphaned session logs at most once per
   * `sseDropLogThrottleMs` instead of once per delta per bound thread (B19).
   */
  private sseDropLogThrottle: Map<string, number> = new Map();

  private baseUrl: string;
  private authHeader: string | null;

  /**
   * Grace period (ms) the fallback rename waits for opencode's native
   * auto-title before stepping in. Instance field (initialised from
   * {@link fallbackRenameGraceMs}) purely so the naming test can drive it to 0
   * and assert the PATCH path deterministically — production never changes it.
   */
  private fallbackRenameGraceMs = fallbackRenameGraceMs;

  /**
   * @description Per-key start/stop serialisation queue (audit S8 / #13).
   * Two near-simultaneous `startSession(key, …)` calls otherwise both
   * progress through `POST /session`; the second's `stopSession(key)`
   * (line 529) clears whatever the first inserted into `this.sessions`,
   * but the losing thread still has its SSE stream and a server-side
   * session id with no owner.
   */
  private lifecycleChains: Map<string, Promise<unknown>> = new Map();

  /** Whether a server restart is already in progress (prevents concurrent restart attempts) */
  private isServerRestarting = false;

  /**
   * Per-thread display-prefs reader, injected by the bot at boot via
   * `createAdapter.registerDisplayPrefsReader` (S4). DELIBERATE deviation from
   * the S2/S3 "adapter stays mode-agnostic" pattern: the sub-agent branch
   * decides WHAT to accumulate (non-`full` = refresh a status, `full` = stream
   * into the separate child accumulator), which cannot be deferred to the
   * bot's render time. `null` until wired → reads fall back to all-`minimal`.
   */
  private displayPrefsReader: DisplayPrefsReader | null = null;

  /** @description Inject the per-thread display-prefs reader (see the field's JSDoc). */
  setDisplayPrefsReader(reader: DisplayPrefsReader): void {
    this.displayPrefsReader = reader;
  }

  /** Per-thread locale reader, injected at boot via `createAdapter.registerThreadLocaleReader`. */
  private threadLocaleReader: ThreadLocaleReader | null = null;

  /** @description Inject the per-thread locale reader (for adapter-side `t(...)` calls). */
  setThreadLocaleReader(reader: ThreadLocaleReader): void {
    this.threadLocaleReader = reader;
  }

  /** @description Run `fn` inside the thread's locale context so `t(...)` resolves correctly. */
  private tl<T>(key: ThreadKey, fn: () => T): T {
    return runWithLocale(this.threadLocaleReader?.(key) ?? defaultLocale, fn);
  }

  /**
   * Per-thread seen-watermark writer, injected by the bot at boot via
   * `createAdapter.registerSeenWatermarkWriter`. Called at turn end
   * (`session.idle`) to persist how far the live relay had shown the record.
   * `null` until wired → {@link advanceSeenWatermark} is a no-op.
   */
  private seenWatermarkWriter: SeenWatermarkWriter | null = null;

  /** @description Inject the per-thread seen-watermark writer (see the field's JSDoc). */
  setSeenWatermarkWriter(writer: SeenWatermarkWriter): void {
    this.seenWatermarkWriter = writer;
  }

  /** @description Advance the persisted seen-watermark for `key` (no-op until the
   * writer is wired). Skips a watermark with no anchor id so the bot's recap
   * cleanly falls back to its no-count path. */
  private advanceSeenWatermark(key: ThreadKey, watermark: SeenWatermark): void {
    if (watermark.opencodeMessageId === undefined) return;
    this.seenWatermarkWriter?.(key, watermark);
  }

  /** @description Resolve the thread's full display prefs, defaulting every
   * field to `minimal` for any read before the bot wires the reader at boot. */
  private getDisplayPrefs(key: ThreadKey): ResolvedThreadDisplayPrefs {
    return (
      this.displayPrefsReader?.(key) ?? {
        thinking: defaultDisplayVerbosityMode,
        toolResults: defaultDisplayVerbosityMode,
        subagent: defaultDisplayVerbosityMode,
      }
    );
  }

  /** @description Resolve the thread's `/subagent` mode (the only pref the
   * OpenCode adapter consults today), via the full prefs reader. */
  private getSubagentMode(key: ThreadKey): DisplayVerbosityMode {
    return this.getDisplayPrefs(key).subagent;
  }

  constructor() {
    super();
    // Audit S7 / #34: SSRF guard on OPENCODE_URL before any fetch runs.
    this.baseUrl = validateOpenCodeUrl(process.env.OPENCODE_URL || 'http://localhost:4096');

    const password = process.env.OPENCODE_PASSWORD;
    if (password) {
      const username = process.env.OPENCODE_USERNAME || 'opencode';
      this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    } else {
      this.authHeader = null;
    }

    // Listen for unexpected server crashes (OOM kill, segfault, etc.)
    onOpenCodeServerExit((code, signal) => {
      console.error(`[OpenCode] Server crashed unexpectedly: code=${code}, signal=${signal}`);
      this.handleServerCrash(code, signal);
    });
  }

  private restoreSavedModel(key: ThreadKey, session: OpenCodeSession, emitOutput: boolean): boolean {
    const saved = loadSavedModel(key);
    if (!saved) return false;

    const label = `${saved.providerID}/${saved.modelID}`;
    session.currentModelLabel = label;
    session.modelOverride = saved;
    session.isModelInfoShown = true;
    console.log(`[OpenCode] Restored saved model: ${label}`);
    if (emitOutput) this.emit('output', key, `Model: ${label}`);
    return true;
  }

  /**
   * @description Handle unexpected server process death.
   * Notifies all active users and attempts to restart the server.
   * SSE reconnect loop will detect the restart and recover automatically.
   */
  private handleServerCrash(code: number | null, signal: string | null): void {
    const reason = code === 137 ? 'out of memory (OOM killed)' :
      signal ? `signal ${signal}` : `exit code ${code}`;

    // Notify all active session threads about the crash
    for (const session of this.sessions.values()) {
      if (session.isActive) {
        this.emit('output', session.key, `OpenCode server crashed (${reason}). Restarting...`);
      }
    }

    // Auto-restart the server (SSE reconnect loop will pick it up)
    this.restartServer();
  }

  /**
   * @description Restart the OpenCode server process.
   * Prevents concurrent restart attempts. If restart is already in progress,
   * waits for it to complete and returns its result.
   */
  private async restartServer(force = false): Promise<boolean> {
    if (this.isServerRestarting) {
      console.log(`[OpenCode] Server restart already in progress, waiting...`);
      // Wait for the in-progress restart to complete
      while (this.isServerRestarting) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      // Check if server is now running
      return checkIsOpenCodeServerRunning();
    }

    this.isServerRestarting = true;
    try {
      console.log(`[OpenCode] Attempting server restart...`);
      if (force) await restartOpenCodeServer();
      else await ensureOpenCodeServer();
      console.log(`[OpenCode] Server restarted successfully`);

      // Close the global stream up front: its reader points at the crashed
      // server's connection. The resume loop below re-opens the (idempotent)
      // single stream via connectSse (plan 2026-06-17 S4). Without this the
      // stale reader would only self-heal later via the stall watchdog —
      // closing here makes recovery deterministic and tied to the restart.
      this.closeGlobalStream();
      // The restarted server has a fresh, empty MCP table, so every directory's
      // scheduler-MCP registration died with the old generation. Clear the gate
      // so connectSse re-registers each still-active directory on resume.
      this.registeredSchedulerMcpDirs.clear();

      // OpenCode persists sessions to disk, so the restarted server still
      // knows the previous session ids — that's the basis of this recovery.
      // For each in-memory session that was active, re-resume the SAME id
      // (verify it on the new server, rebuild the session object, reconnect
      // SSE) via the normal resume path. Only if the id is genuinely gone
      // (e.g. GET /session/:id 404) do we fall back to teardown. Take a
      // snapshot first so the resume/teardown loop can mutate `this.sessions`.
      const snapshot = Array.from(this.sessions.entries());
      for (const [k, session] of snapshot) {
        if (!session.isActive) continue;
        const { key: sessionKey, sessionId, workDir } = session;
        try {
          // resumeSessionInner is the lock-free body; we acquire the per-key
          // lifecycle lock here exactly like the public resumeSession does, so
          // the lock is taken once (no double-acquire from the crash handler).
          await this.withLifecycleLock(k, () => this.resumeSessionInner(sessionKey, workDir, sessionId));
          this.emit('output', sessionKey, `OpenCode server restarted; session restored. In-flight reply was lost — resend if needed.`);
        } catch (e) {
          // The id is gone on the restarted server (or resume otherwise
          // failed). Tear the session down and notify, same as before. Emit
          // `closed` so downstream (bot.ts, wired through createAdapter.ts)
          // wipes the persisted session id too — otherwise the next bot
          // restart would try to resume an id the server no longer has.
          console.error(`[OpenCode] Could not restore session ${sessionId} after restart:`, e);
          this.emit('output', sessionKey, `OpenCode server restarted; previous session lost. Starting a fresh one with /opencode (or /quit to release).`);
          this.stopSessionInner(sessionKey);
          this.emit('closed', sessionKey);
          // Defensive: stopSessionInner deletes from `this.sessions`, but
          // emit order matters for downstream cleanup races.
          this.sessions.delete(k);
        }
      }
      return true;
    } catch (e) {
      console.error(`[OpenCode] Server restart failed:`, e);
      // Notify threads about the failure and tear them down
      // Take a snapshot first so we can safely mutate `this.sessions` inside the loop.
      const snapshot = Array.from(this.sessions.entries());
      for (const [k, session] of snapshot) {
        if (session.isActive) {
          this.emit('output', session.key, `Failed to restart OpenCode server: ${e instanceof Error ? e.message : String(e)}`);
          // Mark session as inactive — no point keeping it alive
          session.isActive = false;
          this.sessions.delete(k);
          this.emit('stopped', session.key);
        }
      }
      return false;
    } finally {
      this.isServerRestarting = false;
    }
  }

  /**
   * @description Reload credentials written by the out-of-band `opencode auth
   * login` CLI. The CLI updates auth.json directly, but a running OpenCode
   * server retains its prior provider credential in memory until restarted.
   * Reuses the normal restart + active-session restoration path.
   */
  async reloadProviderAuth(): Promise<boolean> {
    return this.restartServer(true);
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.authHeader) {
      headers['Authorization'] = this.authHeader;
    }
    return headers;
  }

  private async apiRequest<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    const url = `${this.baseUrl}${urlPath}`;
    // Audit S7 / #12: every fetch carries a timeout so a saturated server can
    // never park a request forever (B18). An external `AbortSignal` (e.g. tied
    // to session lifetime) is COMPOSED with the timeout via `AbortSignal.any`
    // (Node 22+) — the previous `options?.signal ?? timeoutSignal` SILENTLY
    // dropped the timeout whenever a caller passed its own signal, so such a
    // request could hang indefinitely.
    const timeoutSignal = AbortSignal.timeout(apiRequestTimeoutMs);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const requestInit: RequestInit = {
      method,
      headers: this.getHeaders(),
      signal,
    };
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, requestInit);
    } catch (e) {
      // `e instanceof DOMException && e.name === 'TimeoutError'` is the
      // AbortSignal.timeout path; treat it like a connection failure so
      // the user gets a friendly hint, not a stack trace.
      if (e instanceof DOMException && e.name === 'TimeoutError') {
        throw new Error(`OpenCode request timed out after ${apiRequestTimeoutMs}ms (${method} ${urlPath})`);
      }
      // Node's fetch wraps low-level errors in a TypeError with `.cause`
      // holding the underlying ErrnoException. Only `'cause' in e` is a
      // reliable check (TypeScript narrows `cause` to `unknown` even on
      // TypeError in Node's lib types).
      const causeUnknown = (e as { cause?: unknown }).cause;
      const cause = causeUnknown && typeof causeUnknown === 'object' && 'code' in causeUnknown
        ? (causeUnknown as { code?: string })
        : null;
      if (cause?.code === 'ECONNREFUSED') {
        throw new Error(`OpenCode server not available at ${this.baseUrl}. Is "opencode serve" running?`);
      }
      throw new Error(`OpenCode server connection failed (${this.baseUrl}): ${e instanceof Error ? e.message : String(e)}`);
    }

    // prompt_async returns 204 with no body
    if (response.status === 204) {
      return undefined as T;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`OpenCode API ${method} ${urlPath} failed: ${response.status} ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return await response.json() as T;
    }
    // Audit S7 / #35: undici keeps the socket open until the body is
    // drained. Even when we discard it, we must read it.
    await response.text().catch(() => '');
    return undefined as T;
  }

  /**
   * @description Serialise start/stop ops per key. Returns the queued
   * promise so callers still see the original result/throw. Audit S8.
   */
  private withLifecycleLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleChains.get(k);
    const run = async (): Promise<T> => {
      if (prev) { try { await prev; } catch { /* swallow predecessor failures */ } }
      return fn();
    };
    const current = run();
    const tracked: Promise<unknown> = current.then(() => undefined, () => undefined);
    this.lifecycleChains.set(k, tracked);
    return current.finally(() => {
      if (this.lifecycleChains.get(k) === tracked) this.lifecycleChains.delete(k);
    });
  }

  async startSession(key: ThreadKey, workDir: string, args?: string, _sessionId?: string): Promise<void> {
    // OpenCode's session id is server-assigned via POST /session, so an
    // externally-supplied sessionId is not honoured here. The bot keeps the
    // mapping `ThreadKey → opencodeSessionId` in state.json (plan §13.19) so
    // resumes after a restart go through `resumeSession()`, not startSession.
    const k = keyToString(key);
    return this.withLifecycleLock(k, async () => {
      this.stopSessionInner(key);

      if (!checkIsInstalled('opencode')) {
        this.emit('output', key, 'Installing OpenCode...');
        await installTool('opencode');
      }

      if (!await checkIsOpenCodeServerRunning()) {
        this.emit('output', key, 'Starting OpenCode server...');
        await ensureOpenCodeServer();
      }

      console.log(`[OpenCode] Starting session for ${k} in ${workDir}`);

      try {
        // R1 (verified live 2026-06-04): a session created WITHOUT a title is
        // auto-named by opencode from its first prompt's LLM turn — nicer than
        // a raw snippet and it ignores the glued thread-context preamble. A
        // session created WITH a title is treated as user-set and NEVER
        // auto-renamed, which is exactly why the old `Telegram session <k>`
        // default left every session stuck. So only pass a title for the
        // explicit `/opencode <args>` case (explicit title, no auto-rename).
        const createBody: Record<string, unknown> = {};
        if (args) createBody.title = args;
        // The bound folder IS the agent's working directory: create the session
        // in that folder's project instance (`?directory=`) so its cwd/tools are
        // scoped there. Without it the server falls back to its serve-cwd default
        // instance and the agent runs outside the topic's folder.
        const apiSession = await this.apiRequest<OpenCodeApiSession>(
          'POST',
          buildDirectoryScopedPath('/session', workDir),
          createBody,
        );

        const session: OpenCodeSession = {
          key,
          sessionId: apiSession.id,
          workDir,
          isActive: true,
          currentResponseText: '',
          lastEmittedLength: 0,
          outputTimer: null,
          childResponseText: '',
          childLastEmittedLength: 0,
          childOutputTimer: null,
          activeSubagentTitle: null,
          isModelInfoShown: false,
          modelOverride: null,
          currentModelLabel: null,
          partTypes: new Map(),
          statusDebounceTimer: null,
          pendingStatus: null,
          reasoningText: '',
          reasoningStartedAt: null,
          reasoningTimer: null,
          emittedToolResultPartIds: new Set(),
          pendingQuestion: null,
          effortLevel: loadSavedEffort(key),
          isBusy: false,
          awaitingTurnResponse: false,
          sawTurnActivity: false,
          providerRetrySignature: null,
          isAwaitingModelAfterProviderRetryAbort: false,
          providerRetryAbortPromise: null,
          isCompacting: false,
          busyChildSessionIds: new Set(),
          // No assistant turn has finished yet — the seen-watermark anchor is
          // set on the first `session.idle` after a turn completes.
          lastMessageId: undefined,
          // Only untitled (no-args) sessions are eligible for the bot-side
          // fallback rename; an explicit `args` title is user-set and final.
          isAutoNamePending: !args,
        };

        this.detachDuplicateSessionOwners(k, session.sessionId);
        this.sessions.set(k, session);
        this.connectSse(key);
        // Ready BEFORE model resolution (B18): a busy server can stall
        // GET /config for tens of seconds, and the topic showed no "ready"
        // reply meanwhile. The session exists and SSE is live the moment we
        // get here, so announce readiness now and resolve the model after.
        this.emit('started', key);

        // Resolve + announce the model after readiness so a slow /config can
        // never gate the ready reply. fetchModelInfo emits its own `Model:`
        // line when resolved (B9/B17 semantics unchanged).
        await this.fetchModelInfo(key);

        // Seed the bot's default reasoning effort (xhigh, clamped to the now
        // resolved model's variants) UNLESS the thread already has an explicit
        // /effort pref — the model ref is resolved by fetchModelInfo above.
        await this.applyDefaultEffortIfUnset(key);

        // If args provided, send as first message. After fetchModelInfo so the
        // resolved model override rides the prompt body.
        if (args) {
          this.sendPromptAsync(key, args);
        }
      } catch (e) {
        console.error(`[OpenCode] Failed to start session:`, e);
        throw e;
      }
    });
  }

  stopSession(key: ThreadKey): void {
    // Public API contract: stop is fire-and-forget. We still queue it on
    // the lifecycle chain so an in-flight start finishes first.
    const k = keyToString(key);
    void this.withLifecycleLock(k, async () => { this.stopSessionInner(key); });
  }

  /** Lock-free body of `stopSession`; safe to call from start/resume paths
   * that already hold the lifecycle lock. */
  private stopSessionInner(key: ThreadKey): void {
    const k = keyToString(key);
    const session = this.sessions.get(k);
    if (!session) return;

    console.log(`[OpenCode] Stopping session for ${k}`);

    session.isActive = false;

    if (session.outputTimer) {
      clearTimeout(session.outputTimer);
      session.outputTimer = null;
    }
    // Same teardown for the child (sub-agent) debounce — a late fire would
    // emit a marked chunk to a thread that just announced `stopped`.
    if (session.childOutputTimer) {
      clearTimeout(session.childOutputTimer);
      session.childOutputTimer = null;
    }
    // Audit S8 / #11: previously the status timer kept firing after
    // `stopSession`, emitting transient `status` events to a thread that
    // had just announced `stopped`.
    if (session.statusDebounceTimer) {
      clearTimeout(session.statusDebounceTimer);
      session.statusDebounceTimer = null;
    }
    // Same rationale: a live `thinking` debounce timer must not fire (emitting a
    // stale "thinking …" frame) after the session announced `stopped`.
    if (session.reasoningTimer) {
      clearTimeout(session.reasoningTimer);
      session.reasoningTimer = null;
    }

    // Tear down the global SSE stream if this was the last active session
    // anywhere (also clears that stream's reconnect + stall timers).
    this.disconnectSse(key);

    // Abort any running generation. Audit S15: log failures instead
    // of swallowing — a 4xx here usually means the server already
    // dropped the session, which is worth surfacing.
    this.apiRequest('POST', `/session/${session.sessionId}/abort`)
      .catch(e => console.warn(`[OpenCode] abort on stopSession failed:`, e instanceof Error ? e.message : e));

    this.sessions.delete(k);
    this.emit('stopped', key);
  }

  checkIsActive(key: ThreadKey): boolean {
    const session = this.sessions.get(keyToString(key));
    return session?.isActive ?? false;
  }

  checkIsBusy(key: ThreadKey): boolean {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return false;
    return checkIsOpenCodeSessionBusy({
      isBusy: session.isBusy,
      isCompacting: session.isCompacting,
      busyChildCount: session.busyChildSessionIds.size,
    });
  }

  sendInput(key: ThreadKey, input: string): void {
    this.sendPromptAsync(key, input);
  }

  /**
   * @description Send message via async endpoint (returns 204, response streams via SSE).
   * Fire-and-forget — errors are logged but don't block.
   *
   * A normal busy turn is preserved and receives the prompt through OpenCode's
   * queue. A provider-managed retry is interrupted first: otherwise a model
   * switch plus "continue" is accepted into the transcript but remains unread
   * behind the old provider's retry window.
   *
   * **Per-prompt effort apply:** if the thread has a stored effort level
   * (a model variant), it's sent as `body.variant` alongside `body.model`
   * — the same per-prompt override the prompt endpoint already uses for the
   * model selector. No separate request, no env configuration.
   */
  private sendPromptAsync(key: ThreadKey, input: string): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) {
      console.log(`[OpenCode] sendInput: no active session for ${keyToString(key)}`);
      appendDiagLog(`prompt DROPPED no-active-session key=${keyToString(key)}`);
      return;
    }

    console.log(`[OpenCode] sendPromptAsync: "${input}"`);

    // Bot-side fallback naming (R1 safety net): on the first MEANINGFUL prompt
    // of an untitled session, schedule a rename that only fires if opencode's
    // own auto-title never lands. Uses the RAW user text (preamble stripped) so
    // a fallback title can never carry the service header. Fire-and-forget — it
    // must not gate prompt delivery, and a failure leaves the placeholder.
    this.maybeScheduleFallbackRename(session, input);

    // Reset accumulated response text for new message
    session.currentResponseText = '';
    session.lastEmittedLength = 0;
    // The child (sub-agent) accumulator resets with the parent's — a new turn
    // starts clean (a stale debounce firing later emits nothing: empty tail).
    session.childResponseText = '';
    session.childLastEmittedLength = 0;
    // New turn → previous turn's tool-result dedup ids can no longer matter
    // (see the field's JSDoc for why the turn flush is too early to clear).
    session.emittedToolResultPartIds.clear();
    // Mark busy optimistically so an immediately-following message correctly
    // sees a turn in flight; the `session.status` stream corrects/confirms it.
    session.isBusy = true;
    // Arm the wedged-turn detector: a healthy turn sets `sawTurnActivity` from
    // its first assistant message/part; if the next own-session idle arrives
    // with none, the prompt produced no turn (a wedged session accepts prompts
    // but its agent loop exits at once) and we surface a notice instead of
    // hanging silently.
    session.awaitingTurnResponse = true;
    session.sawTurnActivity = false;

    // Model + reasoning-effort overrides ride the prompt body (see buildPromptBody).
    const body = buildPromptBody(input, session.modelOverride, session.effortLevel);

    void (async () => {
      try {
        const retryAbortPromise = this.getProviderRetryAbortPromise(session);
        if (retryAbortPromise) await retryAbortPromise;
        await this.apiRequest('POST', `/session/${session.sessionId}/prompt_async`, body);
      } catch (e) {
        // The optimistic `isBusy = true` above never gets a `session.status`
        // idle to clear it if the POST failed — clear it so the next prompt
        // doesn't eat a spurious abort + wait.
        const current = this.sessions.get(keyToString(key));
        if (current && !current.providerRetrySignature) current.isBusy = false;
        console.error(`[OpenCode] Failed to send message:`, e);
        this.emit('error', key, e instanceof Error ? e : new Error(String(e)));
      }
    })();
  }

  /**
   * @description Return the one shared abort request for a provider-managed
   * retry. Concurrent prompts await the same request, preventing a later abort
   * from cancelling a prompt that an earlier caller already posted.
   */
  private getProviderRetryAbortPromise(session: OpenCodeSession): Promise<void> | null {
    if (session.providerRetryAbortPromise) return session.providerRetryAbortPromise;
    if (!session.providerRetrySignature) return null;

    console.log(`[OpenCode] Aborting provider retry before new prompt`);
    session.isAwaitingModelAfterProviderRetryAbort = true;
    const abortPromise = this.apiRequest('POST', `/session/${session.sessionId}/abort`).then(() => undefined);
    session.providerRetryAbortPromise = abortPromise;
    void abortPromise.then(
      () => {
        const current = this.sessions.get(keyToString(session.key));
        if (current !== session || current.providerRetryAbortPromise !== abortPromise) return;
        current.providerRetrySignature = null;
        current.providerRetryAbortPromise = null;
      },
      () => {
        const current = this.sessions.get(keyToString(session.key));
        if (current === session && current.providerRetryAbortPromise === abortPromise) {
          current.isAwaitingModelAfterProviderRetryAbort = false;
          current.providerRetryAbortPromise = null;
        }
      },
    );
    return abortPromise;
  }

  /**
   * @description Bot-side fallback for naming an untitled session (R1 safety
   * net). The primary mechanism is opencode's own LLM auto-title; this runs
   * ONLY if that never lands.
   *
   * On the first MEANINGFUL prompt of an eligible (untitled, not-yet-renamed)
   * session it clears the pending flag — so it tries at most once — then, after
   * a grace period that lets auto-title land, reads the live title and PATCHes a
   * snippet ONLY when the title is still the bare placeholder. The snippet
   * derives from the RAW user text (preamble stripped) so it can never carry the
   * thread-context header. Fire-and-forget; a failure leaves the placeholder.
   */
  private maybeScheduleFallbackRename(session: OpenCodeSession, input: string): void {
    if (!session.isAutoNamePending) return;
    // The text arriving here is the preamble-glued prompt; meaningfulness and
    // the snippet must both be judged on the RAW user text, never the glue.
    const rawText = stripThreadContextPreamble(input);
    if (!checkIsMeaningfulPrompt(rawText)) return;

    // First meaningful prompt: try at most once, regardless of the outcome.
    session.isAutoNamePending = false;
    const snippet = buildSessionTitleSnippet(rawText);
    if (!snippet) return;
    const { sessionId } = session;

    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, this.fallbackRenameGraceMs));
      try {
        const apiSession = await this.apiRequest<OpenCodeApiSession>('GET', `/session/${sessionId}`);
        // Auto-title already produced a real (LLM) name — leave it; the native
        // name is better than our snippet.
        if (!checkIsPlaceholderTitle(apiSession.title)) return;
        await this.apiRequest('PATCH', `/session/${sessionId}`, { title: snippet });
        console.log(`[OpenCode] Fallback-renamed untitled session ${sessionId} to "${snippet}"`);
      } catch (e) {
        // Best-effort: a failed rename just leaves the placeholder title.
        console.warn(`[OpenCode] fallback session rename failed:`, e instanceof Error ? e.message : e);
      }
    })();
  }

  sendSignal(key: ThreadKey, signal: string): void {
    if (signal === 'SIGINT') {
      const session = this.sessions.get(keyToString(key));
      if (!session?.isActive) return;

      console.log(`[OpenCode] Aborting session (SIGINT)`);
      this.apiRequest('POST', `/session/${session.sessionId}/abort`).catch((e) => {
        console.error(`[OpenCode] abort error:`, e);
      });
    }
  }

  /**
   * @description Connect an OpenCode provider through the same API-key auth
   * endpoint the OpenCode UI uses (`PUT /auth/{providerID}`). The provider auth
   * catalog is checked first so this Telegram flow only accepts providers whose
   * API method needs just the key; providers with extra prompts still belong in
   * OpenCode's native UI until the bot grows a multi-step provider form.
   */
  async connectProvider(_key: ThreadKey, providerId: string, apiKey: string): Promise<string | null> {
    const normalizedProviderId = providerId.trim().toLowerCase();
    if (!checkIsValidProviderId(normalizedProviderId)) {
      return t('connect.invalid_provider', { provider: providerId });
    }
    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) return t('connect.empty_key');

    try {
      await this.ensureProviderAuthServerReady();

      const providerAuth = await this.apiRequest<unknown>('GET', '/provider/auth');
      if (!checkProviderSupportsSimpleApiAuth(providerAuth, normalizedProviderId)) {
        return t('connect.unsupported_provider', { provider: normalizedProviderId });
      }

      await this.apiRequest(
        'PUT',
        buildProviderAuthPath(normalizedProviderId),
        buildProviderApiAuthPayload(trimmedApiKey),
      );
      resetOpenCodeProviderCaches();
      console.log(`[OpenCode] Connected provider: ${normalizedProviderId}`);
      return null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCode] provider connect failed for ${normalizedProviderId}:`, reason);
      return t('connect.failed', { provider: normalizedProviderId, reason });
    }
  }

  private async ensureProviderAuthServerReady(): Promise<void> {
    if (!checkIsInstalled('opencode')) {
      await installTool('opencode');
    }
    if (!await checkIsOpenCodeServerRunning()) {
      await ensureOpenCodeServer();
    }
  }

  /**
   * @description Fetch a provider's auth methods from the live `/provider/auth`
   * catalog (OAuth methods + the API-key method), for the `/connect` method
   * picker. The bot drives OAuth methods out-of-band via `opencode auth login`
   * (a pty); the API-key method reuses {@link connectProvider}. Order is
   * catalog order. Throws on a server/transport error (the caller surfaces it).
   */
  async fetchProviderAuthMethods(providerId: string): Promise<OpenCodeAuthMethod[]> {
    await this.ensureProviderAuthServerReady();
    const raw = await this.apiRequest<unknown>('GET', '/provider/auth');
    return parseProviderAuthMethods(raw, providerId);
  }

  /**
   * @description Set model override for the current session.
   * Accepts either "provider/modelId" format or partial name to search.
   * @returns Error message if model not found, null on success
   */
  async setModel(key: ThreadKey, modelId: string): Promise<string | null> {
    // Resolve first — both calls hit the server/CLI, not session state, so a
    // model can be picked BEFORE a session exists. `getAvailableModels` is the
    // stubbable wrapper around `fetchAvailableModels`.
    const models = await this.getAvailableModels();
    const resolved = await resolveModelId(modelId, models);
    if (!resolved) {
      return `Model "${modelId}" not found. Use /model to see available models.`;
    }
    const label = `${resolved.providerID}/${resolved.modelID}`;

    // Persist the choice unconditionally: a session started later replays the
    // saved pref via `restoreSavedModel`, so picking a model before `/opencode`
    // is no longer lost (the "My health" bug).
    saveModelPref(key, label);

    const session = this.sessions.get(keyToString(key));
    if (session?.isActive) {
      session.modelOverride = resolved;
      session.isModelInfoShown = false;
      session.currentModelLabel = label;
      console.log(`[OpenCode] Model set to: ${label}`);

      // Discriminate by the PERSISTED pref, not session.effortLevel (which may
      // already hold a clamped default we seeded). An explicit /effort pick is
      // validated against the new model and cleared-with-notice if invalid
      // (today's behavior, plan 2026-05-30-effort-command / S4). With no
      // explicit pref the default is silently re-clamped for the new model.
      const explicit = loadSavedEffort(key);
      if (explicit) {
        const stillValid = (await this.getAvailableEffortLevels(key)).includes(explicit);
        if (stillValid) {
          session.effortLevel = explicit;
        } else {
          session.effortLevel = null;
          clearEffortPref(key);
          this.emit('output', key, t('effort.cleared_on_model_switch', { level: explicit, model: label }));
        }
      } else {
        session.effortLevel = clampEffortToAvailable(
          defaultEffortLevel,
          await this.getModelVariants(resolved),
        );
      }
      return null;
    }

    // No active session: the pref is saved above. Guard the SAME invariant as
    // the live branch — a saved effort the new model can't honour would make
    // the next session POST an invalid `body.variant`, so drop it now and tell
    // the user, mirroring the live `effort.cleared_on_model_switch` notice.
    const savedEffort = loadSavedEffort(key);
    if (savedEffort) {
      const stillValid = (await this.getModelVariants(resolved)).includes(savedEffort);
      if (!stillValid) {
        clearEffortPref(key);
        this.emit('output', key, t('effort.cleared_on_model_switch', { level: savedEffort, model: label }));
      }
    }
    console.log(`[OpenCode] Model pref saved (no active session): ${label}`);
    return null;
  }

  /**
   * @description Get list of available models from OpenCode CLI.
   */
  async getAvailableModels(): Promise<string[]> {
    return fetchAvailableModels();
  }

  getCurrentModel(key: ThreadKey): string | null {
    const session = this.sessions.get(keyToString(key));
    if (session?.currentModelLabel) return session.currentModelLabel;
    // No live label (no session, or session not yet resolved) → fall back to
    // the saved pref so the /model header and success copy stay correct
    // pre-session. Mirrors getEffort's session-then-disk read order.
    const saved = loadSavedModel(key);
    return saved ? `${saved.providerID}/${saved.modelID}` : null;
  }

  // ── Reasoning effort (variants) ───────────────────────────────────────────

  /**
   * @description Fetch + cache the provider/variant config
   * (`GET /config/providers`). 5-minute TTL — variant maps change about as
   * often as the model list. Plan R2: log the raw shape ONCE before trusting
   * the parser, since the response shape varies across server versions.
   */
  private async getProvidersConfig(): Promise<ParsedProvidersConfig> {
    const now = Date.now();
    if (cachedProviders && now - providersCacheTime < providersCacheTtlMs) {
      return cachedProviders;
    }
    const raw = await this.apiRequest<unknown>('GET', '/config/providers');
    if (!isProvidersShapeLogged) {
      isProvidersShapeLogged = true;
      try {
        console.log(`[OpenCode] /config/providers raw shape:`, JSON.stringify(raw).slice(0, 2000));
      } catch { /* non-serialisable — skip the one-time log */ }
    }
    const parsed = parseProvidersResponse(raw);
    cachedProviders = parsed;
    providersCacheTime = now;
    return parsed;
  }

  /**
   * @description Variant names a `{providerID, modelID}` model exposes, or
   * `[]` when the ref is incomplete or the model declares no variants.
   *
   * Takes a model ref (not a session) so the no-session `setModel` path can
   * validate a freshly-picked model's variants before any session exists —
   * `getAvailableEffortLevels` resolves the ref from the live session.
   */
  private async getModelVariants(model: OpenCodeModelOverride | null): Promise<string[]> {
    const providerID = model?.providerID;
    const modelID = model?.modelID;
    if (!providerID || !modelID) return [];
    try {
      const config = await this.getProvidersConfig();
      return config.providers.get(providerID)?.get(modelID) ?? [];
    } catch (e) {
      console.warn(`[OpenCode] getProvidersConfig failed:`, e instanceof Error ? e.message : e);
      return [];
    }
  }

  /**
   * @description Resolve the live session's current model into a
   * `{providerID, modelID}` ref from the override (preferred) or the label.
   */
  private getSessionModelRef(session: OpenCodeSession): OpenCodeModelOverride | null {
    if (session.modelOverride) return session.modelOverride;
    const label = session.currentModelLabel;
    if (label && label.includes('/')) {
      return {
        providerID: label.slice(0, label.indexOf('/')),
        modelID: label.slice(label.indexOf('/') + 1),
      };
    }
    return null;
  }

  /**
   * @description Seed the bot's default reasoning effort onto a freshly
   * started/resumed session that has NO explicit per-thread `/effort` pref.
   *
   * Explicit prefs always win and are left untouched (early return). With no
   * pref, the default (`defaultEffortLevel`) is clamped to the resolved
   * model's variants — OpenCode effort is a model variant and not every model
   * ships `xhigh`, so an unclamped value would POST an invalid `body.variant`.
   * A model with no variants resolves to `null` (no effort), which is correct.
   *
   * Never persisted: the default stays a derived fallback, the prefs file
   * remains "explicit choices only".
   */
  private async applyDefaultEffortIfUnset(key: ThreadKey): Promise<void> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;
    if (loadSavedEffort(key) !== null) return; // explicit pref wins
    const variants = await this.getModelVariants(this.getSessionModelRef(session));
    session.effortLevel = clampEffortToAvailable(defaultEffortLevel, variants);
  }

  /**
   * @description Resolve the model the thread's effort applies to, WITHOUT
   * requiring a live session — the prospective model the NEXT session will
   * use. Priority mirrors `fetchModelInfo`'s resolution order so the
   * pre-session effort surface lines up with what a started session would
   * actually run:
   *   1. live session's model ref (active session wins), else
   *   2. the thread's saved `/model` pref (`loadSavedModel`), else
   *   3. the OpenCode server's default model (`GET /config`
   *      `defaultModel` / `model`).
   * Returns `null` only when none of these yield a complete `{providerID,
   * modelID}` ref, so `/effort` pre-session validates against the same model
   * `/model` would persist.
   */
  private async getProspectiveModelRef(key: ThreadKey): Promise<OpenCodeModelOverride | null> {
    const session = this.sessions.get(keyToString(key));
    if (session?.isActive) {
      const liveRef = this.getSessionModelRef(session);
      if (liveRef) return liveRef;
    }

    const saved = loadSavedModel(key);
    if (saved) return saved;

    // No session and no saved pref → fall back to the server's default model,
    // resolved the SAME way `fetchModelInfo` does (defaultModel, then a
    // `provider/model` config string). Best-effort: a sick/booting server
    // just yields null and the picker reports "no levels".
    try {
      const config = await this.apiRequest<{
        model?: string;
        defaultModel?: { providerID: string; modelID: string };
      }>('GET', '/config');
      if (config?.defaultModel?.providerID && config?.defaultModel?.modelID) {
        return { providerID: config.defaultModel.providerID, modelID: config.defaultModel.modelID };
      }
      if (config?.model) {
        const slashIdx = config.model.indexOf('/');
        if (slashIdx > 0) {
          return {
            providerID: config.model.slice(0, slashIdx),
            modelID: config.model.slice(slashIdx + 1),
          };
        }
      }
    } catch (e) {
      console.warn(`[OpenCode] getProspectiveModelRef config lookup failed:`, e instanceof Error ? e.message : e);
    }
    return null;
  }

  /**
   * @description Effort levels the thread can use: exactly the variants its
   * model declares. Works pre-session too — with no live session it resolves
   * the PROSPECTIVE model (saved `/model` pref → server default) so the
   * `/effort` picker can list the next session's variants before `/opencode`,
   * mirroring how `/model` works pre-session. Empty when the (live or
   * prospective) model declares no variants or can't be resolved.
   */
  async getAvailableEffortLevels(key: ThreadKey): Promise<string[]> {
    const session = this.sessions.get(keyToString(key));
    if (session?.isActive) {
      return this.getModelVariants(this.getSessionModelRef(session));
    }
    return this.getModelVariants(await this.getProspectiveModelRef(key));
  }

  getEffort(key: ThreadKey): string | null {
    const session = this.sessions.get(keyToString(key));
    if (session) return session.effortLevel;
    return loadSavedEffort(key);
  }

  /**
   * @description Set the per-thread effort (variant). Validates against the
   * thread's available variants — live model when a session is running, the
   * PROSPECTIVE model (saved `/model` pref → server default) when not — then
   * persists on success (applied per-prompt by `sendPromptAsync`, plan D3; a
   * later session seeds `effortLevel` from this pref at creation). Returns a
   * user-facing notice string on any non-success, `null` on success.
   *
   * Mirrors `setModel`'s persist-first symmetry (no `'No active session'`
   * hard-fail): a level picked BEFORE `/opencode` is saved and replayed by the
   * next session, instead of being lost — same intent as the model pref.
   */
  async setEffort(key: ThreadKey, level: string): Promise<string | null> {
    // Session-free capable: resolves variants from the live model if active,
    // else the prospective model the next session will use.
    const available = await this.getAvailableEffortLevels(key);
    if (available.length === 0) {
      // Name the model the validation ran against — the live label if a
      // session is up, else the prospective model — so the notice is correct
      // pre-session (the live `currentModelLabel` is null then).
      const modelLabel = await this.getEffortModelLabel(key);
      return t('effort.not_supported', { model: modelLabel });
    }
    if (!available.includes(level)) {
      return t('effort.invalid_level', { level, valid: available.join(', ') });
    }

    // Persist unconditionally (like `setModel`'s `saveModelPref`): a session
    // started later seeds `effortLevel: loadSavedEffort(key)` at creation.
    saveEffortPref(key, level);

    // Live session → also apply now so the in-flight session honours it on the
    // next prompt without waiting for a restart.
    const session = this.sessions.get(keyToString(key));
    if (session?.isActive) session.effortLevel = level;
    console.log(`[OpenCode] Effort set to: ${level}`);
    return null;
  }

  /**
   * @description Human label for the model the thread's effort validates
   * against — the live session's label when active, else the prospective
   * model's `provider/model` — for the `effort.not_supported` notice. `'?'`
   * only when no model can be resolved at all.
   */
  private async getEffortModelLabel(key: ThreadKey): Promise<string> {
    const session = this.sessions.get(keyToString(key));
    if (session?.isActive && session.currentModelLabel) return session.currentModelLabel;
    const prospective = await this.getProspectiveModelRef(key);
    return prospective ? `${prospective.providerID}/${prospective.modelID}` : '?';
  }

  /**
   * @description Manually rename the live session via `PATCH /session/:id
   * { title }`, scoped to the session's owning project instance
   * (`?directory=<workDir>`) so it hits the same instance the session was
   * created in. Reuses {@link apiRequest} — no duplicate HTTP code.
   *
   * A manual rename is final: it clears `isAutoNamePending` so the bot-side
   * auto-name fallback can never overwrite the user's title later (the
   * fallback only fires while that flag is set — see
   * {@link maybeScheduleFallbackRename}).
   */
  async renameSession(key: ThreadKey, title: string): Promise<string | null> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return t('rename_session.start_agent_first');

    // The user explicitly named it — auto-title must never win over a manual
    // rename, so retire the fallback for this session regardless of the PATCH
    // outcome.
    session.isAutoNamePending = false;

    try {
      await this.apiRequest(
        'PATCH',
        buildDirectoryScopedPath(`/session/${session.sessionId}`, session.workDir),
        { title },
      );
      console.log(`[OpenCode] Renamed session ${session.sessionId} to "${title}"`);
      return null;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(`[OpenCode] manual session rename failed:`, reason);
      return t('rename_session.failed', { reason });
    }
  }

  getOpenCodeSessionId(key: ThreadKey): string | null {
    return this.sessions.get(keyToString(key))?.sessionId ?? null;
  }

  // Folder-scoped listing: `GET /session?directory=<workDir>` returns only the
  // sessions of the bound folder's project instance. The topic is always bound
  // before this is reached (the bot gates `/sessions` on a binding), so workDir
  // is the real working folder, never a serve-cwd fallback. Sessions created in
  // other instances (e.g. by-hand serve-cwd scatter) are intentionally absent.
  async getSessions(_key: ThreadKey, workDir: string): Promise<AgentSession[]> {
    try {
      const apiSessions = await this.apiRequest<OpenCodeApiSession[]>(
        'GET',
        buildDirectoryScopedPath('/session', workDir),
      );

      if (!Array.isArray(apiSessions)) return [];

      return apiSessions.map(s => ({
        id: s.id,
        title: s.title || s.id,
        // `time.created`/`time.updated` are already epoch MILLISECONDS
        // (13-digit values verified live via GET /session). The old `* 1000`
        // pushed every date millennia into the future, so the /sessions list
        // showed "(just now)" for every entry (B13).
        createdAt: s.time?.created ? new Date(s.time.created) : new Date(),
        updatedAt: s.time?.updated ? new Date(s.time.updated) : new Date(),
      }));
    } catch (e) {
      console.error(`[OpenCode] Failed to get sessions:`, e);
      return [];
    }
  }

  /**
   * @description Read the last `limit` conversational turns of a session for the
   * resume context block via `GET /session/:id/message`. `key`/`workDir` are
   * unused — OpenCode scopes messages by session id, server-side. Maps the raw
   * records with the pure {@link mapOpenCodeMessagesToTurns}; a request failure
   * yields `[]`, so the caller posts no context block.
   */
  async getRecentTurns(_key: ThreadKey, _workDir: string, sessionId: string, limit: number): Promise<RecentTurn[]> {
    try {
      const records = await this.apiRequest<unknown>('GET', `/session/${sessionId}/message`);
      return mapOpenCodeMessagesToTurns(records, limit);
    } catch (e) {
      console.error(`[OpenCode] Failed to read recent turns:`, e);
      return [];
    }
  }

  /**
   * @description Assemble the silent-reattach recap for OpenCode: ONE
   * `GET /session/:id/message` read serves both the missed-message count (since
   * the watermark id) and the last-{@link resumeContextTurnLimit} turns. A read
   * failure degrades to an empty, watermark-unknown recap (the caller posts
   * nothing). The watermark only counts when its `sessionId` matches the session
   * being recapped — a stale watermark from a different session (`/new`,
   * `/sessions` resume keep the agent row) is treated as unknown. `isActive` is
   * derived from the fetched records (last record = an unfinished assistant
   * turn), never a blocking server probe.
   */
  async getReattachRecap(
    _key: ThreadKey,
    _workDir: string,
    sessionId: string,
    watermark: SeenWatermark | null,
  ): Promise<ReattachRecap> {
    let records: unknown;
    try {
      records = await this.apiRequest<unknown>('GET', `/session/${sessionId}/message`);
    } catch (e) {
      console.error(`[OpenCode] getReattachRecap read failed:`, e);
      return { missedCount: 0, turns: [], isWatermarkKnown: false, isActive: false };
    }
    // Only trust the watermark id when it was taken against THIS session.
    const watermarkId = watermark?.sessionId === sessionId ? watermark.opencodeMessageId : undefined;
    const { missedCount, isWatermarkKnown } = countOpenCodeAssistantMessagesSinceId(records, watermarkId);
    const turns = mapOpenCodeMessagesToTurns(records, resumeContextTurnLimit);
    const isActive = checkIsOpenCodeTurnInFlight(records);
    // Head watermark = the latest assistant message id, scoped to THIS session.
    // Omitted when none resolvable (head unknown → no idempotent advance).
    const latestId = getLatestOpenCodeAssistantMessageId(records);
    const headWatermark: SeenWatermark | undefined =
      latestId === undefined ? undefined : { sessionId, opencodeMessageId: latestId };
    return { missedCount, turns, isWatermarkKnown, isActive, headWatermark };
  }

  async resumeSession(key: ThreadKey, workDir: string, sessionId: string, options?: ResumeSessionOptions): Promise<void> {
    // `workDir` is now an explicit argument from the bot, sourced from the
    // thread's binding in state.json. The old code defaulted to
    // `process.env.WORK_DIR || '/workspace'`, which silently mis-routed
    // resumes to the wrong folder as soon as the bot started managing
    // multiple bindings (plan §10.3, fix to old openCodeAdapter.ts:599).
    const k = keyToString(key);
    return this.withLifecycleLock(k, () => this.resumeSessionInner(key, workDir, sessionId, options));
  }

  private async resumeSessionInner(key: ThreadKey, workDir: string, sessionId: string, options?: ResumeSessionOptions): Promise<void> {
    this.stopSessionInner(key);

    const k = keyToString(key);

    if (!checkIsInstalled('opencode')) {
      this.emit('output', key, 'Installing OpenCode...');
      await installTool('opencode');
    }

    if (!await checkIsOpenCodeServerRunning()) {
      this.emit('output', key, 'Starting OpenCode server...');
      await ensureOpenCodeServer();
    }

    console.log(`[OpenCode] Resuming session ${sessionId} for ${k} in ${workDir}`);

    try {
      // Verify session exists
      const apiSession = await this.apiRequest<OpenCodeApiSession>('GET', `/session/${sessionId}`);

      const session: OpenCodeSession = {
        key,
        sessionId: apiSession.id,
        workDir,
        isActive: true,
        currentResponseText: '',
        lastEmittedLength: 0,
        outputTimer: null,
        childResponseText: '',
        childLastEmittedLength: 0,
        childOutputTimer: null,
        activeSubagentTitle: null,
        isModelInfoShown: false,
        modelOverride: null,
        currentModelLabel: null,
        partTypes: new Map(),
        statusDebounceTimer: null,
        pendingStatus: null,
        reasoningText: '',
        reasoningStartedAt: null,
        reasoningTimer: null,
        emittedToolResultPartIds: new Set(),
        pendingQuestion: null,
        effortLevel: loadSavedEffort(key),
        isBusy: false,
        awaitingTurnResponse: false,
        sawTurnActivity: false,
        providerRetrySignature: null,
        isAwaitingModelAfterProviderRetryAbort: false,
        providerRetryAbortPromise: null,
        isCompacting: false,
        busyChildSessionIds: new Set(),
        // The watermark anchor is re-learned from the next finished turn; the
        // persisted watermark (read by the bot for the reattach recap) is
        // independent of this fresh-session field.
        lastMessageId: undefined,
        // A resumed session already has a name and history — never auto-rename.
        isAutoNamePending: false,
      };

      this.detachDuplicateSessionOwners(k, session.sessionId);
      this.sessions.set(k, session);
      this.connectSse(key);
      // Ready BEFORE model resolution (B18): a busy server can stall GET /config
      // for tens of seconds; the topic must not wait on it for the reattach
      // notice. Session + SSE are live here.
      this.emit('started', key);

      // Re-surface a question still open on the server (G1): this method runs on
      // BOTH silent restart re-attach AND explicit /sessions resume, so an
      // unanswered question is recovered in either case. Runs UNCONDITIONALLY
      // (not gated on isWithRecentContext) because the silent reattach — the
      // path that auto-unsticks a wedged topic after a hot rebuild — passes it
      // false. Awaited so the buttons re-post before model resolution; it
      // never throws (best-effort inside).
      await this.restoreOpenQuestion(key, apiSession.id, workDir);

      // Post the short last-N-turn context block so a resume shows where the
      // conversation left off (parity with Claude — OpenCode has no flood, but
      // gets the same block). ONLY on the explicit user resume: this method
      // also runs on silent re-attach after every bot restart and on crash
      // recovery, and posting the block there spammed every active topic on
      // every hot rebuild. Best-effort: a read failure or empty history posts
      // nothing extra. Runs before model resolution for the same
      // responsiveness reason as `emit('started')` above.
      if (options?.isWithRecentContext) {
        try {
          const turns = await this.getRecentTurns(key, workDir, apiSession.id, resumeContextTurnLimit);
          const rendered = formatResumeContext(turns);
          // Complete one-shot block — post instantly, never via the dm draft
          // channel (its typing animation would "draw" this already-whole text).
          if (rendered) this.emit('output', key, rendered, { isComplete: true });
        } catch (e) {
          console.warn(`[OpenCode] resume context block failed:`, e instanceof Error ? e.message : e);
        }
      }
      // Re-resolve the model on every resume so a session that took its model
      // from the server default (no saved /model pref) keeps a populated
      // modelOverride/currentModelLabel after a bot restart — otherwise /effort
      // can't resolve the model and reports "levels unavailable" (B17).
      // Silent (emitOutput=false): the label is unchanged from the previous run
      // and already shown in the topic, so re-emitting on each restart is noise.
      await this.fetchModelInfo(key, false);

      // Re-establish the default effort on resume too (no explicit pref →
      // clamp xhigh to the re-resolved model's variants). Mirrors startSession.
      await this.applyDefaultEffortIfUnset(key);
    } catch (e) {
      console.error(`[OpenCode] Failed to resume session:`, e);
      throw e;
    }
  }

  /**
   * @description Ensure the single global SSE stream is open and the session's
   * directory has its scheduler MCP registered (plan 2026-06-17). Called after
   * a session is inserted active into `this.sessions` (start / resume / restart).
   * The stream is shared by ALL sessions, so it opens only for the FIRST active
   * session anywhere; later calls reuse it. Scheduler-MCP registration is per
   * directory (decoupled from the stream), gated to once per dir per server
   * generation. Keeps the `(key)` signature so the lifecycle paths and tests
   * (which stub `connectSse` / `pollSseStream`) are unchanged.
   */
  private connectSse(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session) return;
    this.ensureGlobalStream();
    void this.registerSchedulerMcpForDirectory(session.workDir);
  }

  /**
   * Re-register active directories once the bot scheduler listener is ready.
   * Reattached sessions connect before that listener starts during bot boot.
   */
  registerSchedulerMcpForActiveSessions(): void {
    for (const session of this.sessions.values()) {
      if (session.isActive) {
        void this.registerSchedulerMcpForDirectory(session.workDir);
      }
    }
  }

  /**
   * @description Boot self-heal for the adopt path. When the bot restarts and
   * ADOPTS an already-running opencode (the server outlived the bot), that
   * server still holds the PREVIOUS bot generation's `telegramBot` registration
   * pointing at a now-dead ephemeral port — so every session in the directory
   * reports the MCP `failed` and loses its scheduling / file-send tools. For
   * each active session's directory (de-duped — a folder can host several
   * threads), read the LIVE `GET /mcp` status and, when the `telegramBot` entry
   * is missing or not `connected`, drop the Set gate and force a fresh POST (the
   * server overwrites a same-name registration with the current port). A dir
   * already `connected` is left untouched. Best-effort per directory: a read /
   * registration error is logged and swallowed — it must never throw out of
   * boot. Supersedes {@link registerSchedulerMcpForActiveSessions} at the boot
   * call site (a not-yet-registered dir has no entry → treated as needing one).
   */
  async reconcileSchedulerMcpForActiveSessions(): Promise<void> {
    const directories = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.isActive) directories.add(session.workDir);
    }
    // Reconcile every directory concurrently so one slow/unresponsive dir can't
    // delay the others; each is best-effort (never rejects), so allSettled is
    // just a join point.
    await Promise.allSettled(
      Array.from(directories, (directory) => this.reconcileSchedulerMcpForDirectory(directory)),
    );
  }

  /**
   * @description Reconcile ONE directory: read the live `GET /mcp` status and,
   * when `telegramBot` is missing or not `connected`, drop the Set gate and
   * force a fresh POST. Best-effort — a read/registration error is logged and
   * swallowed so it never rejects out of {@link reconcileSchedulerMcpForActiveSessions}.
   */
  private async reconcileSchedulerMcpForDirectory(directory: string): Promise<void> {
    try {
      const mcpStatus = await this.apiRequest<unknown>(
        'GET',
        buildDirectoryScopedPath('/mcp', directory),
      );
      if (!checkNeedsSchedulerMcpReregister(mcpStatus)) return;
      // The live server contradicts the Set gate (stale entry from a prior
      // generation): clear it so the re-POST actually fires.
      this.registeredSchedulerMcpDirs.delete(directory);
      await this.registerSchedulerMcpForDirectory(directory);
    } catch (e) {
      console.warn(
        `[OpenCode] scheduler MCP reconcile failed for ${directory}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  /**
   * @description Mark a session inactive and tear down the global SSE stream IFF
   * it was the LAST active session anywhere. The stream is reference-counted by
   * the TOTAL active-session count (recomputed from `this.sessions` so it can
   * never drift): any other active session — in any folder — keeps it open.
   *
   * Order-independent: callers vary in whether they pre-set `isActive = false`
   * (`stopSessionInner` does, before calling here), so the decision counts OTHER
   * active sessions and treats this one as departing. `before = other + 1`,
   * `after = other` → `close` exactly when no sibling keeps the stream alive.
   */
  private disconnectSse(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session) return;
    session.isActive = false;
    // Count OTHER active sessions (excluding this departing one) — `before =
    // other + 1`, `after = other` → `close` exactly when no sibling anywhere
    // keeps the global stream alive.
    const otherActive = this.countActiveSessions(key);
    if (getSseStreamTransition(otherActive + 1, otherActive) === 'close') {
      this.closeGlobalStream();
    }
  }

  /**
   * @description Total count of currently-active sessions, optionally excluding
   * one key (the departing session in a teardown decision) — the reference count
   * the single global stream's lifecycle keys on.
   */
  private countActiveSessions(excludeKey?: ThreadKey): number {
    const excludeKeyStr = excludeKey ? keyToString(excludeKey) : null;
    let count = 0;
    for (const [keyStr, session] of this.sessions) {
      if (keyStr === excludeKeyStr) continue;
      if (session.isActive) count += 1;
    }
    return count;
  }

  /**
   * @description Open the single `/global/event` stream if it is not already
   * open (plan 2026-06-17). Idempotent — a second active session finds the
   * stream present and no-ops. The reader runs detached; a fatal start error
   * surfaces to every active session so the user isn't left with a silently-dead
   * session (audit S10 / #43).
   */
  private ensureGlobalStream(): void {
    if (this.globalStream) return;

    const stream: SseStreamState = {
      directory: globalStreamLabel,
      controller: null,
      stallTimer: null,
      reconnectTimer: null,
      isClosed: false,
    };
    this.globalStream = stream;

    // `/global/event` multiplexes every project instance's events (each wrapped
    // in `payload`, tagged with a top-level `directory`), delivering reliably
    // regardless of connection age (plan 2026-06-17 S1: the per-directory
    // endpoint goes silent for an aged sole subscriber on opencode 1.14.41).
    // Each event is parsed once here and routed by envelope directory + sessionID.
    const sseUrl = `${this.baseUrl}/global/event`;
    console.log(`[OpenCode] Connecting global SSE: ${sseUrl}`);
    appendDiagLog(`sse open ${globalStreamLabel}`);

    this.pollSseStream(stream, sseUrl).catch((e) => {
      console.error(`[OpenCode] global SSE connection error:`, e);
      this.emitToAllActiveSessions('error', e instanceof Error ? e : new Error(String(e)));
    });
  }

  /**
   * @description Register the bot's scheduler MCP server for `directory`'s
   * OpenCode instance via the runtime `POST /mcp?directory=` endpoint (plan
   * 2026-06-17 S3). Idempotent on the server (re-POSTing the same `name`
   * overwrites/no-ops) and gated by `registeredSchedulerMcpDirs` so it runs once
   * per directory per server generation — `restartServer` clears the Set so a
   * dir is re-registered after the server's MCP table is wiped. Inert until
   * injection is configured — the builder returns `null` and this no-ops. A
   * registration FAILURE is logged and swallowed: scheduling tools are an
   * enhancement, the session must still start.
   */
  private async registerSchedulerMcpForDirectory(directory: string): Promise<void> {
    if (this.registeredSchedulerMcpDirs.has(directory)) return;
    const registration = await buildOpenCodeSchedulerMcpRegistration(directory);
    if (!registration) return;
    if (this.registeredSchedulerMcpDirs.has(directory)) return;
    try {
      await this.apiRequest(
        'POST',
        buildDirectoryScopedPath('/mcp', directory),
        registration,
      );
      this.registeredSchedulerMcpDirs.add(directory);
      appendDiagLog(`scheduler mcp registered dir=${directory}`);
    } catch (e) {
      console.warn(
        `[OpenCode] scheduler MCP registration failed for ${directory}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  /**
   * @description Tear down the global SSE stream: latch it closed, abort the
   * in-flight reader (unblocks `reader.read()` immediately — audit S7 / #12),
   * cancel its stall + reconnect timers, and drop the reference.
   */
  private closeGlobalStream(): void {
    const stream = this.globalStream;
    if (!stream) return;
    stream.isClosed = true;
    if (stream.controller) {
      stream.controller.abort();
      stream.controller = null;
    }
    this.clearStreamStallTimer(stream);
    if (stream.reconnectTimer) {
      clearTimeout(stream.reconnectTimer);
      stream.reconnectTimer = null;
    }
    this.globalStream = null;
    appendDiagLog(`sse close ${globalStreamLabel}`);
  }

  /** Emit an event to every active session. */
  private emitToAllActiveSessions(
    eventName: 'error',
    error: Error,
  ): void {
    for (const session of this.sessions.values()) {
      if (session.isActive) {
        this.emit(eventName, session.key, error);
      }
    }
  }

  /**
   * @description Resolve model for the session. Priority:
   * 1. Thread's saved preference (from previous /model selection)
   * 2. OpenCode server's defaultModel (config.model -> model.json recent -> first provider)
   * 3. "not set"
   *
   * `emitOutput` controls whether the resolved `Model: <label>` line is sent to
   * the topic. A fresh `startSession` emits it (the user just opened the
   * session); a `resumeSession` after a bot restart re-resolves the SAME model
   * silently — the label is already in the topic from the previous run, so
   * re-emitting on every hot-restart is noise (B17). Resolution must still run
   * to repopulate `modelOverride`/`currentModelLabel` so `/effort` can read them.
   */
  private async fetchModelInfo(key: ThreadKey, emitOutput = true): Promise<void> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive || session.isModelInfoShown) return;

    // 1. Check this thread's saved model preference
    if (this.restoreSavedModel(key, session, emitOutput)) return;

    // 2. Ask OpenCode server for default model
    try {
      const config = await this.apiRequest<{
        model?: string;
        defaultModel?: { providerID: string; modelID: string };
      }>('GET', '/config');

      console.log(`[OpenCode] GET /config: model=${config?.model || 'unset'}, defaultModel=${config?.defaultModel ? `${config.defaultModel.providerID}/${config.defaultModel.modelID}` : 'unset'}`);

      if (config?.defaultModel?.providerID && config?.defaultModel?.modelID) {
        const label = `${config.defaultModel.providerID}/${config.defaultModel.modelID}`;
        session.currentModelLabel = label;
        session.modelOverride = {
          providerID: config.defaultModel.providerID,
          modelID: config.defaultModel.modelID,
        };
        session.isModelInfoShown = true;
        console.log(`[OpenCode] Default model: ${label}`);
        if (emitOutput) this.emit('output', key, `Model: ${label}`);
        return;
      }

      if (config?.model) {
        const slashIdx = config.model.indexOf('/');
        if (slashIdx > 0) {
          session.modelOverride = {
            providerID: config.model.slice(0, slashIdx),
            modelID: config.model.slice(slashIdx + 1),
          };
        }
        session.currentModelLabel = config.model;
        session.isModelInfoShown = true;
        console.log(`[OpenCode] Default model (config): ${config.model}`);
        if (emitOutput) this.emit('output', key, `Model: ${config.model}`);
        return;
      }
    } catch (e) {
      // Transient failure (server booting / sick). Do NOT claim "not set":
      // leave isModelInfoShown false and currentModelLabel untouched so the
      // next assistant message (handleMessageUpdate) corrects it with the
      // real model label.
      console.log(`[OpenCode] fetchModelInfo failed:`, e instanceof Error ? e.message : e);
      return;
    }

    // 3. Server answered but reported no default model — genuinely not set.
    console.log(`[OpenCode] No default model resolved`);
    session.currentModelLabel = 'not set';
    if (emitOutput) this.emit('output', key, `Model: not set (use /model to select)`);
  }

  /**
   * @description Fetch-based SSE reader for the single `/global/event` stream
   * (plan 2026-06-17). OpenCode sends every event as a `data:` line with a JSON
   * envelope `{ directory, payload: { type, properties } }`; this one stream
   * multiplexes every project instance, so each line is parsed once here and
   * routed by the envelope `directory` + `sessionID` to its owning session.
   *
   * On connection failure: checks if the server is alive, attempts a restart if
   * dead, and retries forever with capped exponential backoff until reconnect
   * succeeds — as long as the stream is still wanted (not closed).
   */
  private async pollSseStream(stream: SseStreamState, sseUrl: string, reconnectAttempt = 0, reconnectStartTs = Date.now()): Promise<void> {
    if (stream.isClosed) return;
    // The "directory" is the fixed `globalStreamLabel` — a log marker only; the
    // global stream has no per-folder scope (events carry their own directory).
    const streamLabel = stream.directory;

    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
    };
    if (this.authHeader) {
      headers['Authorization'] = this.authHeader;
    }

    // Audit S7 / #12: SSE was previously read with no abort path —
    // `await reader.read()` blocks until bytes arrive, so a teardown during a
    // silent server couldn't actually free the connection. The stream-scoped
    // controller is stored so `closeGlobalStream` can abort the in-flight
    // `fetch` and `reader.read` immediately.
    const controller = new AbortController();
    stream.controller = controller;

    let sawData = false;

    try {
      const response = await fetch(sseUrl, { headers, signal: controller.signal });

      if (!response.ok || !response.body) {
        console.error(`[OpenCode] SSE connection failed for ${streamLabel}: ${response.status}`);
        await response.body?.cancel().catch(() => {});
        await this.handleSseReconnect(stream, sseUrl, reconnectAttempt, reconnectStartTs, `HTTP ${response.status}`);
        return;
      }

      console.log(`[OpenCode] SSE connected for ${streamLabel}`);
      appendDiagLog(`sse connected dir=${streamLabel} attempt=${reconnectAttempt}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Arm the stall watchdog before the first read and re-arm on every chunk;
      // a silently dead stream (no bytes, not even a heartbeat) would otherwise
      // park `reader.read()` forever with no reconnect.
      this.armSseStallWatchdog(stream, controller);

      while (!stream.isClosed) {
        const { done, value } = await reader.read();
        if (done) break;
        this.armSseStallWatchdog(stream, controller);

        // Audit S7 / #12: a flapping server used to reset `reconnectAttempt`
        // on a *successful TCP connect*, so the 5-attempts ceiling never
        // bounded anything. Reset only once we observe actual application
        // data, and keep a wall-clock budget so even data-producing flaps
        // get capped.
        if (!sawData) {
          sawData = true;
          reconnectAttempt = 0;
          reconnectStartTs = Date.now();
          appendDiagLog(`sse first-data dir=${streamLabel}`);
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const dataStr = line.slice(6);
          this.routeSseData(dataStr);
        }
      }

      // Leaving the read loop: disarm before any reconnect await so the
      // watchdog can't fire against this (now-finished) controller.
      this.clearStreamStallTimer(stream);
      reader.cancel().catch(() => {});

      // If the stream is still wanted but the server closed it, reconnect.
      if (!stream.isClosed) {
        console.log(`[OpenCode] SSE stream for ${streamLabel} ended while wanted, reconnecting...`);
        await this.handleSseReconnect(stream, sseUrl, reconnectAttempt, reconnectStartTs, 'stream ended');
      }
    } catch (e) {
      this.clearStreamStallTimer(stream);
      // An aborted controller means either `closeGlobalStream` (stream no
      // longer wanted → just exit) or the stall watchdog firing on a silently
      // dead stream (stream still wanted → reconnect).
      if (controller.signal.aborted) {
        if (!stream.isClosed) {
          await this.handleSseReconnect(stream, sseUrl, reconnectAttempt, reconnectStartTs, 'stall');
        }
        return;
      }
      if (!stream.isClosed) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error(`[OpenCode] SSE error for ${streamLabel}:`, errorMessage);
        await this.handleSseReconnect(stream, sseUrl, reconnectAttempt, reconnectStartTs, errorMessage);
      }
    } finally {
      this.clearStreamStallTimer(stream);
      if (stream.controller === controller) stream.controller = null;
    }
  }

  /**
   * @description (Re)arm a stream's stall watchdog. OpenCode emits a
   * `server.heartbeat` every ~10 s, so a live stream always delivers bytes
   * within `sseStallTimeoutMs`; if none arrive the socket is silently dead
   * (open TCP, no FIN/RST) and `reader.read()` would park forever. Aborting the
   * controller unblocks the reader so `pollSseStream`'s catch path reconnects.
   * Re-armed on every chunk, so heartbeats keep a healthy stream alive.
   */
  private armSseStallWatchdog(stream: SseStreamState, controller: AbortController): void {
    this.clearStreamStallTimer(stream);
    stream.stallTimer = setTimeout(() => {
      stream.stallTimer = null;
      appendDiagLog(`sse stall dir=${stream.directory} idle>${sseStallTimeoutMs}ms`);
      controller.abort();
    }, sseStallTimeoutMs);
  }

  /** Cancel a stream's stall watchdog if armed. Idempotent. */
  private clearStreamStallTimer(stream: SseStreamState): void {
    if (stream.stallTimer) {
      clearTimeout(stream.stallTimer);
      stream.stallTimer = null;
    }
  }

  /**
   * @description Handle reconnection for the single global stream with server
   * health check, auto-restart, and exponential backoff. If the server is dead,
   * attempts a restart before reconnecting. Never gives up while the stream is
   * still wanted — reconnects until success — with backoff capped at
   * `maxSseReconnectDelayMs`. The only exits are an unrestartable server
   * (handled by `restartServer`) or a closed stream.
   */
  private async handleSseReconnect(
    stream: SseStreamState,
    sseUrl: string,
    attempt: number,
    reconnectStartTs: number,
    reason: string,
  ): Promise<void> {
    if (stream.isClosed) return;
    const streamLabel = stream.directory;

    const elapsed = Date.now() - reconnectStartTs;

    // Check if the server process is still alive
    const isServerAlive = await checkIsOpenCodeServerRunning();

    if (!isServerAlive) {
      console.log(`[OpenCode] Server is not responding, attempting restart before SSE reconnect...`);
      const restarted = await this.restartServer();
      if (!restarted) {
        // restartServer already notified threads and cleaned up sessions
        return;
      }
      // restartServer re-opens the global stream via the resume path; if this
      // stream was torn down in the process, stop here so we don't double-open it.
      if (stream.isClosed) return;
      // Server restarted — reset the attempt counter so backoff starts fresh.
      attempt = 0;
    }

    // Never give up while the stream is wanted: reconnect forever until
    // success. Cap the exponential backoff so steady-state retries settle at
    // `maxSseReconnectDelayMs` instead of growing without bound.
    const delay = Math.min(
      sseReconnectBaseDelayMs * Math.pow(2, Math.min(attempt, maxSseReconnectBackoffExponent)),
      maxSseReconnectDelayMs,
    );
    console.log(`[OpenCode] SSE reconnecting ${streamLabel} in ${delay}ms (attempt ${attempt + 1}, reason: ${reason}, elapsed: ${Math.round(elapsed / 1000)}s)`);
    appendDiagLog(`sse reconnect dir=${streamLabel} attempt=${attempt + 1} reason=${reason} delay=${delay}ms`);

    // Store the timer handle on the stream so `closeGlobalStream` can cancel
    // it; otherwise a `setTimeout` fired after the stream is gone re-enters
    // `pollSseStream` for a dead stream and keeps the event loop alive (audit
    // S8 / #14).
    await new Promise<void>(resolve => {
      stream.reconnectTimer = setTimeout(() => {
        stream.reconnectTimer = null;
        resolve();
      }, delay);
    });

    if (!stream.isClosed) {
      this.pollSseStream(stream, sseUrl, attempt + 1, reconnectStartTs).catch(() => {});
    }
  }

  /**
   * @description Route a single raw SSE `data:` line from the global stream
   * (plan 2026-06-17). The JSON is parsed ONCE here, the owning session is
   * resolved from its sessionID/lineage (with an envelope-directory fallback),
   * and the event is dispatched to that session. The owning project instance
   * comes from the event ENVELOPE'S `directory` field — `/global/event` tags
   * every session event with it — so instance-local replies
   * (questions/permissions) target the right instance.
   *
   * Also the entry the SSE unit tests drive (a session injected into the map +
   * synthesized payload-wrapped envelope), so the real parse→route→dispatch
   * path is exercised end to end.
   */
  private routeSseData(dataStr: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      return;
    }

    const event = normaliseOpenCodeSseEvent(parsed);
    if (!event) return;

    const ownerKeyStr = this.resolveSseEventOwner(event);
    if (ownerKeyStr === undefined) return;

    if (ownerKeyStr === null) {
      // Session-less event (server.connected / heartbeat) — no owner to look up.
      this.dispatchSessionLessEvent(event);
      return;
    }

    const ownerSession = this.sessions.get(ownerKeyStr);
    if (!ownerSession?.isActive) return;
    // The owning project instance is the envelope's `directory` (session-less
    // events have none and need none) — used for instance-scoped replies.
    this.dispatchSseEvent(ownerSession.key, event, event.directory);
  }

  /**
   * @description Resolve which thread (if any) should process `event`, applying
   * the single-owner invariant (B20) and recording subagent lineage. Owner
   * resolution is by sessionID (direct id, else lineage ancestor) with a
   * DIRECTORY fallback off the event ENVELOPE'S `directory` when both miss
   * (plan 2026-06-17). Returns:
   *   - the owning thread's serialised key for a per-session event;
   *   - `null` for a session-less event (`server.connected`/`heartbeat`) that
   *     every reader handles directly;
   *   - `undefined` to signal "do not dispatch" (missing sessionID, or no bound
   *     thread owns the session — a genuine drop, loud-logged for every critical
   *     type incl. question/permission, so a routable event is never a no-op).
   *     Events for directories the bot does not own (the user's by-hand opencode
   *     in other folders, now visible on the global stream) drop here cheaply.
   */
  private resolveSseEventOwner(event: OpenCodeSseEvent): string | null | undefined {
    const eventType = event.type;

    // OpenCode runs subagents in CHILD sessions; their events carry the child
    // sessionID, not the bound parent's. The child→parent link must be known
    // BEFORE the child's first routed event or that event drops "no owner".
    // `session.updated` is no longer the ONLY source — record from ANY event
    // whose properties expose `parentID` (S2 lineage durability), capturing it
    // BEFORE the session-id gate below so descendant events route to the owner.
    this.trackSessionLineage(event.properties);

    // Session-less events are server-wide by design; they have no owner to
    // resolve and are processed directly by the dispatch switch.
    if (eventType === 'server.connected' || eventType === 'server.heartbeat') {
      return null;
    }

    const eventSessionId = this.getSessionIdFromEvent(event);
    if (!eventSessionId) {
      console.warn(`[OpenCode] dropping ${eventType} without sessionID`);
      if (criticalSseEventTypes.has(eventType)) {
        this.logSseDropOncePerWindow(eventType, '<no-session-id>');
      }
      return undefined;
    }

    // Single-owner delivery (B20): resolve the ONE thread that owns
    // `eventSessionId` (direct id match, else nearest lineage ancestor). A
    // false lineage link or a duplicated session id must never emit the same
    // answer to two topics. On success, refresh the lineage links walked so an
    // actively-routing child is never the eviction victim (S2 durability).
    const ownerKeyStr = this.resolveEventOwnerKey(eventSessionId, { refreshLineageOnUse: true });
    if (ownerKeyStr !== null) return ownerKeyStr;

    // Id/lineage resolution failed. Before dropping, fall back to the event
    // ENVELOPE'S DIRECTORY (plan 2026-06-17): `/global/event` tags every session
    // event with its owning folder, so the event provably belongs to a thread
    // bound to THAT folder even when the per-session lineage map briefly
    // disagrees (link evicted / not yet recorded). The fallback also drops an
    // event for a directory the bot does not own (the user's by-hand opencode in
    // another folder): no active bound session there → `null` → cheap drop. SYNC
    // only — no HTTP on the per-event hot path; the decision uses in-memory state.
    const eventDirectory = event.directory;
    const fallbackOwnerKeyStr = eventDirectory !== undefined
      ? this.resolveOwnerByDirectoryFallback(eventSessionId, eventDirectory)
      : null;
    if (fallbackOwnerKeyStr !== null) {
      appendDiagLog(
        `sse dir-fallback ${eventType} es=${eventSessionId} dir=${eventDirectory} -> ${fallbackOwnerKeyStr}`,
      );
      return fallbackOwnerKeyStr;
    }

    // A genuine loss is "no thread owns this event at all". Throttle the log
    // per (eventType, eventSessionId) — an orphaned session's delta firehose
    // would otherwise flood the diag file (B19). question/permission are now
    // critical, so a vanished question is LOUD, never silent (S1).
    if (criticalSseEventTypes.has(eventType)) {
      this.logSseDropOncePerWindow(eventType, eventSessionId);
    }
    return undefined;
  }

  /**
   * @description Handle a session-less event (`server.connected` /
   * `server.heartbeat`) — server-wide by design, with no owning topic. Kept
   * separate from {@link dispatchSseEvent} so the latter always has a real
   * owner key.
   */
  private dispatchSessionLessEvent(event: OpenCodeSseEvent): void {
    if (event.type === 'server.connected') {
      console.log(`[OpenCode] SSE: server.connected`);
    }
    // server.heartbeat is intentionally silent — it only re-arms the watchdog.
  }

  /**
   * @description Dispatch a normalised, OWNED SSE event to its owning session's
   * handlers. `key` is the resolved single owner (B20); `directory` is the
   * owning project instance (the event envelope's `directory`), used for
   * instance-scoped question / permission replies.
   */
  private dispatchSseEvent(key: ThreadKey, event: OpenCodeSseEvent, directory: string | undefined): void {
    const eventType = event.type;
    const eventSessionId = this.getSessionIdFromEvent(event);

    const session = this.sessions.get(keyToString(key));
    // A routed event whose session id is NOT the owner's own id reached us via
    // lineage descent → it belongs to a SUB-AGENT (child session). Computed
    // ONCE here and threaded into the part handlers — they must never
    // re-derive it (S4).
    const isSubagentEvent = Boolean(
      session?.isActive && eventSessionId && eventSessionId !== session.sessionId,
    );
    if (session && isSubagentEvent) {
      appendDiagLog(`sse route-descendant ${eventType} es=${eventSessionId} -> ${session.sessionId}`);
    }

    switch (eventType) {
      case 'message.part.updated':
      case 'message.part.delta':
        this.handlePartUpdate(key, event.properties, isSubagentEvent);
        break;

      case 'message.updated':
        this.handleMessageUpdate(key, event.properties);
        break;

      case 'session.idle':
        this.handleSessionIdle(key, event.properties);
        break;

      case 'session.status':
        this.handleSessionStatus(key, eventSessionId, event.properties);
        break;

      case 'session.next.compaction.started':
        this.setCompacting(key, true);
        break;

      case 'session.next.compaction.ended':
      case 'session.compacted':
        this.setCompacting(key, false);
        break;

      case 'session.error':
        this.handleSessionError(key, eventSessionId, event.properties);
        break;

      case 'permission.asked':
        this.handlePermissionAsked(key, event.properties, directory);
        break;

      case 'question.asked':
        this.handleQuestionAsked(key, event.properties, directory);
        break;

      default:
        // Log unhandled event types for debugging, skipping the ones we
        // intentionally ignore (heartbeat + global-only bookkeeping) so the
        // multiplexed global stream doesn't spam stdout (plan 2026-06-17 S2).
        if (eventType !== 'server.heartbeat' && !ignoredSseEventTypes.has(eventType)) {
          console.log(`[OpenCode] SSE event: ${eventType}`);
        }
        break;
    }
  }

  private getSessionIdFromEvent(event: OpenCodeSseEvent): string | null {
    const props = event.properties;
    // Different events carry sessionID in different places
    if (typeof props.sessionID === 'string') return props.sessionID;
    if (props.part && typeof (props.part as OpenCodePart).sessionID === 'string') {
      return (props.part as OpenCodePart).sessionID!;
    }
    if (props.info && typeof (props.info as OpenCodeMessageInfo).sessionID === 'string') {
      return (props.info as OpenCodeMessageInfo).sessionID!;
    }
    return null;
  }

  /**
   * @description Record a child→parent session link from ANY event that exposes
   * `parentID`, so subagent (child-session) events route to the topic bound to
   * the parent. Reliably populated by `session.updated` (its `info` carries the
   * child id + `parentID`); also reads a top-level `properties.parentID`
   * (paired with the event's session id) when a build emits it on other events,
   * so a child's link is known BEFORE its first routed event instead of dropping
   * "no owner" until the next `session.updated` beat (S2 durability). Root
   * sessions (no `parentID`) and non-session ids are ignored by
   * {@link updateSessionLineage}; the map is bounded by
   * `maxTrackedSessionLineageEntries`.
   */
  private trackSessionLineage(properties: Record<string, unknown>): void {
    const info = properties.info as OpenCodeSessionUpdatedInfo | undefined;
    // `session.updated` shape: info.id is the CHILD, info.parentID its parent.
    this.recordSessionLineageLink(info?.id, info?.parentID);

    // Other events: a top-level parentID belongs to the event's OWN session id.
    const topLevelParentId = properties.parentID;
    if (typeof topLevelParentId === 'string') {
      this.recordSessionLineageLink(this.getSessionIdFromEvent({ type: '', properties }), topLevelParentId);
    }
  }

  /** @description Store one child→parent link and diag-log it when it is new. */
  private recordSessionLineageLink(childSessionId: string | null | undefined, parentSessionId: string | undefined): void {
    const recorded = updateSessionLineage(
      this.sessionLineage,
      childSessionId ?? undefined,
      parentSessionId,
      maxTrackedSessionLineageEntries,
    );
    if (recorded) {
      appendDiagLog(`sse lineage child=${childSessionId} parent=${parentSessionId}`);
    }
  }

  /**
   * @description Tear down any OTHER active thread already bound to
   * `sessionId` before `keyStr` adopts it (B20 prevention). One server-side
   * OpenCode session belongs to exactly one thread; if two threads held the
   * same id (e.g. resuming a session already live in another topic), the
   * server's multiplexed events would match BOTH and the same answer would
   * land in two topics. Detaching the stale owner keeps the single-owner
   * invariant true at the source, not just in dispatch.
   */
  private detachDuplicateSessionOwners(keyStr: string, sessionId: string): void {
    for (const [otherKeyStr, otherSession] of this.sessions) {
      if (otherKeyStr === keyStr) continue;
      if (!otherSession.isActive || otherSession.sessionId !== sessionId) continue;
      console.warn(
        `[OpenCode] session ${sessionId} already owned by ${otherKeyStr}; detaching it before ${keyStr} adopts it`,
      );
      appendDiagLog(`sse dup-owner-detach session=${sessionId} from=${otherKeyStr} to=${keyStr}`);
      // SOFT detach: tear down the stale thread's local tracking (SSE, timers,
      // map entry) and announce `stopped`, but do NOT abort the server session
      // — the new thread is adopting that exact live session, so aborting it
      // would kill the generation the new owner wants to keep streaming.
      this.softDetachSession(otherSession.key);
    }
  }

  /**
   * @description Tear down a thread's local session tracking WITHOUT aborting
   * the server-side session. Used when another thread is adopting the same
   * server session (B20 prevention) — a normal `stopSessionInner` would abort
   * the shared generation. Mirrors `stopSessionInner` minus the abort POST.
   */
  private softDetachSession(key: ThreadKey): void {
    const k = keyToString(key);
    const session = this.sessions.get(k);
    if (!session) return;

    session.isActive = false;
    if (session.outputTimer) {
      clearTimeout(session.outputTimer);
      session.outputTimer = null;
    }
    if (session.childOutputTimer) {
      clearTimeout(session.childOutputTimer);
      session.childOutputTimer = null;
    }
    if (session.statusDebounceTimer) {
      clearTimeout(session.statusDebounceTimer);
      session.statusDebounceTimer = null;
    }
    // Tear down the directory's SSE stream if this was its last active session.
    this.disconnectSse(key);
    this.sessions.delete(k);
    this.emit('stopped', key);
  }

  /**
   * @description Resolve the SINGLE active thread that owns an SSE event for
   * `eventSessionId` (single-owner delivery, B20). Direct session-id match wins
   * over lineage descent; ties resolve deterministically. Returns the owning
   * thread's serialised key, or `null` if no active thread owns it.
   *
   * `refreshLineageOnUse` marks the lineage links walked to reach the owner as
   * most-recently-used, so an actively-routing child can never be the eviction
   * victim of the bounded lineage map (S2 durability) — only set on the live
   * routing path, never when merely probing.
   */
  private resolveEventOwnerKey(
    eventSessionId: string,
    options?: { refreshLineageOnUse: boolean },
  ): string | null {
    const boundSessions = this.getActiveBoundSessions();
    const ownerKeyStr = getEventOwnerKey(eventSessionId, boundSessions, this.sessionLineage);
    if (ownerKeyStr !== null && options?.refreshLineageOnUse) {
      const ownerSessionId = boundSessions.find((bound) => bound.keyStr === ownerKeyStr)?.sessionId;
      // Only a descendant (event id ≠ owner id) walked the lineage chain; a
      // direct id match used no links to refresh.
      if (ownerSessionId !== undefined && ownerSessionId !== eventSessionId) {
        touchLineageOnUse(this.sessionLineage, eventSessionId, ownerSessionId);
      }
    }
    return ownerKeyStr;
  }

  /** @description Every currently-active session as a routing `BoundSessionRef`. */
  private getActiveBoundSessions(): BoundSessionRef[] {
    const boundSessions: BoundSessionRef[] = [];
    for (const [keyStr, session] of this.sessions) {
      if (session.isActive) boundSessions.push({ keyStr, sessionId: session.sessionId });
    }
    return boundSessions;
  }

  /**
   * @description Directory fallback (plan 2026-06-17): resolve an owner from the
   * event envelope's `directory` when id/lineage resolution already failed.
   * `/global/event` tags every session event with its owning folder, so an event
   * provably belongs to a thread bound to that folder — and an event for a
   * directory with no active bound session (the user's by-hand opencode
   * elsewhere) resolves to `null` and is dropped. SYNC — uses only in-memory
   * session state, NEVER an HTTP call on the per-event hot path. Delegates the
   * decision to the pure {@link resolveOwnerByDirectoryFallbackPure}; the wiring
   * here is just selecting the directory's active sessions.
   */
  private resolveOwnerByDirectoryFallback(eventSessionId: string, directory: string): string | null {
    const directoryActiveSessions: BoundSessionRef[] = [];
    for (const [keyStr, session] of this.sessions) {
      if (session.isActive && session.workDir === directory) {
        directoryActiveSessions.push({ keyStr, sessionId: session.sessionId });
      }
    }
    return resolveOwnerByDirectoryFallbackPure(eventSessionId, directoryActiveSessions, this.sessionLineage);
  }

  /**
   * @description Diag-log one "sse drop" line for an event no thread owns,
   * throttled to at most once per (eventType, eventSessionId) per
   * `sseDropLogThrottleMs`. Without throttling an orphaned session's delta
   * firehose floods the diag log — once per delta per bound thread (B19).
   */
  private logSseDropOncePerWindow(eventType: string, eventSessionId: string): void {
    const shouldLog = checkShouldLogDrop(
      this.sseDropLogThrottle,
      eventType,
      eventSessionId,
      Date.now(),
      sseDropLogThrottleMs,
      maxSseDropThrottleEntries,
    );
    if (shouldLog) {
      appendDiagLog(`sse drop ${eventType} es=${eventSessionId} (no owner)`);
    }
  }

  /**
   * @description Handle streaming part updates from assistant response.
   * Two event formats:
   *   message.part.updated: { part: OpenCodePart, delta?: string }
   *   message.part.delta:   { sessionID, messageID, partID, field, delta }
   *
   * Text parts are accumulated and emitted as 'output' (permanent messages).
   * Tool, reasoning, step-* parts are emitted as 'status' (transient messages).
   *
   * `isSubagent` (resolved ONCE in `dispatchSseEvent`) marks parts streamed by
   * a CHILD session (sub-agent); they are routed per the
   * {@link getSubagentPartAction} matrix instead of the parent's handlers, so
   * a child transcript can never merge unmarked into the parent's reply (S4).
   */
  private handlePartUpdate(key: ThreadKey, properties: Record<string, unknown>, isSubagent: boolean): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    // Any part (own or sub-agent child) means the turn genuinely started —
    // clears the wedged-turn suspicion for the pending prompt.
    session.sawTurnActivity = true;

    const part = properties.part as OpenCodePart | undefined;
    const delta = properties.delta as string | undefined;
    const field = properties.field as string | undefined;
    const partId = (properties.partID as string) || part?.id;

    // Track part type from message.part.updated events (full part object)
    if (part?.type && partId) {
      session.partTypes.set(partId, part.type);
    }

    // Resolve the part type: from the part object or from our tracking map
    const partType = part?.type || (partId ? session.partTypes.get(partId) : undefined) || 'text';

    // Reasoning end signal #1: the first NON-reasoning part after reasoning was
    // streaming (the answer or a tool call begins). The most responsive of the
    // three end signals; `endReasoning` is idempotent so the later
    // `message.updated` finish / `session.idle` signals are harmless no-ops.
    // Child parts are excluded: a sub-agent streaming must not collapse the
    // PARENT's thinking indicator (its own first non-reasoning part — e.g. the
    // `task` tool call — already ended it).
    if (partType !== 'reasoning' && !isSubagent) this.endReasoning(key, session);

    switch (partType) {
      case 'text':
        if (isSubagent) {
          this.handleSubagentTextPart(key, session, delta, field);
          break;
        }
        this.handleTextDelta(key, session, delta, field);
        break;
      case 'tool':
        this.handleToolPart(key, session, part, isSubagent);
        break;
      case 'reasoning':
        // Child chain-of-thought is never rendered in ANY mode (locked
        // decision — `getSubagentPartAction` returns 'ignore' for reasoning):
        // it must not feed the parent's thinking channel.
        if (isSubagent) break;
        this.handleReasoningPart(key, session, part, delta, field);
        break;
      case 'step-start':
      case 'step-finish':
        // Silently skip step markers — tool parts provide better status info
        break;
      default:
        // Log unknown part types for future debugging
        if (part?.type) {
          console.log(`[OpenCode] Unhandled part type: ${part.type}`);
        }
        break;
    }
  }

  /**
   * @description Handle text delta — accumulate and emit as 'output'.
   */
  private handleTextDelta(
    key: ThreadKey,
    session: OpenCodeSession,
    delta: string | undefined,
    field: string | undefined,
  ): void {
    // For message.part.delta: only process text field deltas
    if (field && field !== 'text') return;

    const text = delta || '';
    if (!text) return;

    session.currentResponseText += text;

    // Debounce: batch rapid SSE deltas before emitting
    if (session.outputTimer) {
      clearTimeout(session.outputTimer);
    }

    session.outputTimer = setTimeout(() => {
      session.outputTimer = null;
      this.emitResponseTail(key, session);
    }, sseOutputBatchMs);
  }

  /**
   * @description Emit only the part of `currentResponseText` not yet sent as
   * an `output` event, then advance `lastEmittedLength`. The bot does not
   * delta-render OpenCode output (`outputsDeltas` is unset), so each emit is a
   * raw tail of the in-flight response — possibly cut mid-word.
   *
   * Every tail except the FIRST of a response carries `isContinuation: true`
   * (a {@link OutputEventMeta}). The bot appends a continuation tail to the
   * same growing Telegram message instead of starting a new one, so the long
   * reply reads as one message rather than each edit replacing the previous
   * text. `lastEmittedLength === 0` means this is the first tail of a fresh
   * response (nothing emitted yet), so it is NOT a continuation. `flushOutput`
   * resets `lastEmittedLength` to 0 after the final tail, so the next response
   * again starts with a non-continuation first tail.
   */
  private emitResponseTail(key: ThreadKey, session: OpenCodeSession, isFinal = false): void {
    const tail = session.currentResponseText.slice(session.lastEmittedLength);
    if (!tail.trim()) return;
    const isContinuation = session.lastEmittedLength > 0;
    // `isFinal` rides only the idle-triggered flush so the bot can skip the
    // possibly-429-stretched debounce for the turn's last frame.
    const meta: OutputEventMeta = { isContinuation, isFinal };
    this.emit('output', key, tail, meta);
    session.lastEmittedLength = session.currentResponseText.length;
  }

  /**
   * @description Handle a SUB-AGENT (child session) text part per the
   * mode×kind matrix ({@link getSubagentPartAction}):
   *
   * - `compact` → never touch any accumulator; signal the dedicated
   *   `subagentStatus` event instead (the bot owns a single self-updating
   *   "🤖 sub-agent: <title> · m:ss" message + elapsed timer). This replaced
   *   the old shared-status refresh, whose lost single-message identity between
   *   sparse bursts re-`sendMessage`d a new message each time (the flood bug).
   * - `full` → accumulate into the SEPARATE child accumulator and flush via
   *   the same debounce discipline as {@link handleTextDelta} — never through
   *   `currentResponseText` (a child transcript in the parent accumulator
   *   would corrupt the parent reply's continuation accounting).
   */
  private handleSubagentTextPart(
    key: ThreadKey,
    session: OpenCodeSession,
    delta: string | undefined,
    field: string | undefined,
  ): void {
    if (field && field !== 'text') return;

    const text = delta || '';
    if (!text) return;

    if (getSubagentPartAction(this.getSubagentMode(key), 'text') === 'status') {
      // Dedicated channel (NOT the shared transient status): the bot keeps ONE
      // self-updating message with a ticking elapsed counter, edited in place.
      this.emit('subagentStatus', key, { active: true, title: session.activeSubagentTitle });
      return;
    }

    session.childResponseText += text;
    if (session.childOutputTimer) {
      clearTimeout(session.childOutputTimer);
    }
    session.childOutputTimer = setTimeout(() => {
      session.childOutputTimer = null;
      this.emitChildResponseTail(key, session);
    }, sseOutputBatchMs);
  }

  /**
   * @description Emit the unsent tail of the CHILD (sub-agent) accumulator as
   * a marked `output` event (`meta.isSubagent`, `/subagent full` mode only).
   * Mirrors {@link emitResponseTail} over the dedicated child fields so the
   * parent's emit cursor is never advanced by child text. Carries NO
   * `isContinuation`: the bot renders every sub-agent chunk as its own marked
   * message outside the parent's edit-in-place chain (acceptable v1 — `full`
   * is opt-in). The empty-string guard doubles as runtime tolerance for test
   * fixtures that inject minimal session shapes.
   */
  private emitChildResponseTail(key: ThreadKey, session: OpenCodeSession): void {
    if (!session.childResponseText) return;
    const tail = session.childResponseText.slice(session.childLastEmittedLength);
    if (!tail.trim()) return;
    const meta: OutputEventMeta = { isSubagent: true };
    this.emit('output', key, tail, meta);
    session.childLastEmittedLength = session.childResponseText.length;
  }

  /**
   * @description Is this part the delegation (`task`) tool still in flight
   * (pending/running)? Drives both the delegation-title tracking and the
   * dedicated "🤖 Delegating: <title> …" activity status (S5) — once the
   * delegation completes/errors the generic ✅/❌ status forms take over.
   */
  private checkIsDelegationInFlight(part: OpenCodePart, toolState: OpenCodeToolState): boolean {
    return part.tool === delegationToolName
      && (toolState.status === 'pending' || toolState.status === 'running');
  }

  /**
   * @description Read the delegation's title off a `task` tool part's state:
   * the explicit `title` when present, else the prompt `description` from the
   * tool input. `null` when the part carries neither (the status builders fall
   * back to a localized generic label).
   */
  private getDelegationTitle(toolState: OpenCodeToolState): string | null {
    const inputDescription = typeof toolState.input?.description === 'string' ? toolState.input.description : null;
    return toolState.title || inputDescription;
  }

  /**
   * @description Record / clear the CURRENT delegation's title from the
   * PARENT's `task` tool part: stored while the delegation is pending/running
   * (feeds the dedicated sub-agent status message; S5's "Delegating" activity
   * status reuses this field), cleared once it completes/errors. Only ever
   * called for the parent's own parts — a child's nested `task` must not
   * overwrite the parent-level title.
   *
   * The title is STICKY (D2 fix): while in-flight we only OVERWRITE it with a
   * non-null title — a beat where the `task` part momentarily lacks
   * title/description leaves the last known title intact, instead of clobbering
   * it to `null` mid-run (which made the line read "sub-agent: sub-agent").
   * It is cleared to `null` only on the terminal (completed/error) part.
   */
  private trackDelegationTitle(session: OpenCodeSession, part: OpenCodePart, toolState: OpenCodeToolState): void {
    if (part.tool !== delegationToolName) return;
    if (this.checkIsDelegationInFlight(part, toolState)) {
      const title = this.getDelegationTitle(toolState);
      if (title) session.activeSubagentTitle = title;
      return;
    }
    session.activeSubagentTitle = null;
  }

  /**
   * @description Handle tool part — format and emit as 'status'.
   */
  private handleToolPart(
    key: ThreadKey,
    session: OpenCodeSession,
    part: OpenCodePart | undefined,
    isSubagent = false,
  ): void {
    if (!part) return;

    const toolName = part.tool || 'tool';
    const state = part.state;
    if (!state) return;

    // Whether THIS part is the PARENT's own in-flight delegation whose
    // "working" indicator is owned by the dedicated `subagentStatus` message
    // (minimal/short) — in that case the shared-status "Delegating…" emit below
    // must be SUPPRESSED so the two lines don't compete. Full mode keeps the
    // shared-status behaviour (the streamed child transcript is the indicator).
    let suppressSharedDelegatingStatus = false;

    if (isSubagent) {
      // Child tool part: `ignore` in compact (a generic 🔧 status would
      // overwrite the sub-agent status line); transient `status` in full.
      // Child toolResult BODIES are suppressed in both modes (the return at
      // the bottom never runs `maybeEmitToolResult` for a child): the
      // parent's `task` output already carries the child's final result.
      if (getSubagentPartAction(this.getSubagentMode(key), 'tool') === 'ignore') return;
    } else {
      this.trackDelegationTitle(session, part, state);
      // Parent's own `task` part drives the dedicated sub-agent status message
      // (minimal/short modes): open/refresh while in flight, close on
      // completed/error. Full mode keeps the old shared "Delegating…" status.
      if (part.tool === delegationToolName && this.getSubagentMode(key) !== 'full') {
        if (this.checkIsDelegationInFlight(part, state)) {
          this.emit('subagentStatus', key, {
            active: true,
            title: this.getDelegationTitle(state) ?? session.activeSubagentTitle,
          });
          suppressSharedDelegatingStatus = true;
        } else if (state.status === 'completed' || state.status === 'error') {
          this.emit('subagentStatus', key, { active: false, title: null });
        }
      }
    }

    let statusText: string;
    if (this.checkIsDelegationInFlight(part, state)) {
      // An in-flight delegation mirrors the terminal's "~ Delegating…" line
      // instead of the generic 🔄/🔧 forms (S5) — the parent-side counterpart
      // of the compact "🤖 sub-agent: …" status, same style. The title comes
      // off THIS part's state, so a child's own nested `task` (full mode)
      // renders its own title, never the parent's tracked one. In minimal/short
      // the dedicated `subagentStatus` message already owns this indicator, so
      // skip the competing shared-status emit.
      if (suppressSharedDelegatingStatus) {
        if (!isSubagent) this.maybeEmitToolResult(key, session, part);
        return;
      }
      statusText = this.tl(key, () => buildDelegatingStatusText(this.getDelegationTitle(state)));
    } else {
      switch (state.status) {
        case 'pending':
          statusText = `🔄 ${toolName}...`;
          break;
        case 'running':
          statusText = `🔧 ${state.title || toolName}...`;
          break;
        case 'completed':
          statusText = `✅ ${state.title || toolName}`;
          break;
        case 'error':
          statusText = `❌ ${toolName}: ${state.error || 'failed'}`;
          break;
        default:
          statusText = `🔧 ${toolName}`;
          break;
      }
    }

    this.emitStatus(key, session, statusText);
    if (!isSubagent) this.maybeEmitToolResult(key, session, part);
  }

  /**
   * @description Emit the dedicated MODE-AGNOSTIC `toolResult` event once a
   * tool part reaches `completed` with a non-empty output (S3). The bot
   * resolves the per-thread tool-results mode (`minimal` drops it there) — the
   * adapter emits every result exactly once, guarded by
   * {@link OpenCodeSession.emittedToolResultPartIds} against the re-sent part
   * shapes. The output is kept strictly OUT of `currentResponseText` so it can
   * never pollute the answer or its continuation accounting.
   */
  private maybeEmitToolResult(key: ThreadKey, session: OpenCodeSession, part: OpenCodePart): void {
    const toolState = part.state;
    if (toolState?.status !== 'completed') return;
    if (typeof toolState.output !== 'string' || !toolState.output.trim()) return;
    // A part id is required for the double-emit guard. Only full
    // `message.part.updated` part objects reach handleToolPart, and those
    // always carry an id — an id-less shape is safer dropped than duplicated.
    if (!part.id || session.emittedToolResultPartIds.has(part.id)) return;
    session.emittedToolResultPartIds.add(part.id);

    const payload: ToolResultEvent = { tool: part.tool || 'tool', output: toolState.output };
    if (toolState.title) payload.title = toolState.title;
    this.emit('toolResult', key, payload);
  }

  /** Debounce delay (ms) for live `thinking` emits — the reasoning delta
   * stream is chatty, so live frames are coalesced like text deltas. */
  private static readonly reasoningLiveEmitMs = 400;

  /**
   * @description Handle a reasoning (chain-of-thought) part.
   *
   * Reasoning text is accumulated into {@link OpenCodeSession.reasoningText}
   * — kept STRICTLY separate from `currentResponseText` so it never leaks into
   * the answer — and surfaced through the DEDICATED `thinking` event (not the
   * generic `status` coalescer), so the thinking indicator can persist
   * independently of tool status. The adapter stays MODE-AGNOSTIC: it emits the
   * raw accumulated text + phase, and the bot applies the per-thread mode.
   *
   * On the FIRST reasoning delta of a response we record `reasoningStartedAt`
   * (drives the "thought for {N}s" duration on the eventual `done` emit). Live
   * emits are debounced.
   */
  private handleReasoningPart(
    key: ThreadKey,
    session: OpenCodeSession,
    part: OpenCodePart | undefined,
    delta: string | undefined,
    field: string | undefined,
  ): void {
    // For message.part.delta only the reasoning `text` field carries content.
    if (field && field !== 'text') return;

    const text = delta || part?.text || '';
    if (!text) return;

    if (session.reasoningStartedAt === null) {
      session.reasoningStartedAt = Date.now();
    }
    session.reasoningText += text;

    // Debounce the live emit — newest accumulated text always wins.
    if (session.reasoningTimer) clearTimeout(session.reasoningTimer);
    session.reasoningTimer = setTimeout(() => {
      session.reasoningTimer = null;
      this.emitThinking(key, session, 'live');
    }, OpenCodeAdapter.reasoningLiveEmitMs);
  }

  /**
   * @description Emit the `thinking` event for the current phase. `live` carries
   * the accumulated reasoning text so far; `done` adds the elapsed `durationMs`.
   */
  private emitThinking(key: ThreadKey, session: OpenCodeSession, phase: ThinkingEvent['phase']): void {
    const payload: ThinkingEvent = { phase, text: session.reasoningText };
    if (phase === 'done' && session.reasoningStartedAt !== null) {
      payload.durationMs = Date.now() - session.reasoningStartedAt;
    }
    this.emit('thinking', key, payload);
  }

  /**
   * @description End the current response's reasoning stream, if one is active.
   * Flushes any pending live frame, emits the `thinking` `done` event (so the
   * bot can collapse / persist per mode), and resets the per-response reasoning
   * accumulator. Idempotent — a no-op when no reasoning is in flight, so it can
   * be called from every "reasoning end" signal (first non-reasoning part,
   * `message.updated` finish, `session.idle`) without double-emitting.
   */
  private endReasoning(key: ThreadKey, session: OpenCodeSession): void {
    if (session.reasoningStartedAt === null) return;
    if (session.reasoningTimer) {
      clearTimeout(session.reasoningTimer);
      session.reasoningTimer = null;
    }
    this.emitThinking(key, session, 'done');
    session.reasoningText = '';
    session.reasoningStartedAt = null;
  }

  /** Debounce delay (ms) for status updates to avoid Telegram rate limits */
  private static readonly statusDebounceMs = 400;

  /**
   * @description Debounced emit of 'status' event.
   * Rapid status updates (e.g. multiple tool state changes) are batched —
   * only the latest status text is emitted after a quiet period.
   */
  private emitStatus(key: ThreadKey, session: OpenCodeSession, text: string): void {
    session.pendingStatus = text;

    if (session.statusDebounceTimer) {
      clearTimeout(session.statusDebounceTimer);
    }

    session.statusDebounceTimer = setTimeout(() => {
      session.statusDebounceTimer = null;
      if (session.pendingStatus) {
        this.emit('status', key, session.pendingStatus);
        session.pendingStatus = null;
      }
    }, OpenCodeAdapter.statusDebounceMs);
  }

  /**
   * @description Handle message completion.
   * Event properties: { info: OpenCodeMessageInfo }
   */
  private handleMessageUpdate(key: ThreadKey, properties: Record<string, unknown>): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    const info = properties.info as OpenCodeMessageInfo | undefined;
    if (!info) return;

    // An assistant message (own or sub-agent child) means the turn genuinely
    // started — clears the wedged-turn suspicion for the pending prompt.
    if (info.role === 'assistant') session.sawTurnActivity = true;

    // Track and show model info on first assistant message (or after model change)
    if (info.role === 'assistant' && info.modelID) {
      const modelLabel = info.providerID
        ? `${info.providerID}/${info.modelID}`
        : info.modelID;
      const selectedModelLabel = session.modelOverride
        ? `${session.modelOverride.providerID}/${session.modelOverride.modelID}`
        : null;
      const isAbortedRetryModel = session.isAwaitingModelAfterProviderRetryAbort
        && selectedModelLabel !== null
        && modelLabel !== selectedModelLabel;

      // Aborting a provider retry finalises its old assistant message before the
      // replacement prompt starts. That stale update must not overwrite the
      // newly-selected /model or announce the old provider as the new turn.
      if (isAbortedRetryModel) {
        console.log(`[OpenCode] Ignoring model from aborted provider retry: ${modelLabel}`);
      } else {
        if (selectedModelLabel === modelLabel) session.isAwaitingModelAfterProviderRetryAbort = false;
        session.currentModelLabel = modelLabel;

        if (!session.isModelInfoShown) {
          session.isModelInfoShown = true;
          console.log(`[OpenCode] Using model: ${modelLabel}`);
          this.emit('output', key, `Model: ${modelLabel}`);
        }
      }
    }

    // When assistant message completes (has finish reason), flush output
    if (info.finish && info.role === 'assistant') {
      // A CHILD (sub-agent) assistant message finishing must NOT close the
      // dedicated sub-agent status — the parent's delegation is still in flight.
      // Only the PARENT's own finishing message ends the delegation defensively.
      const isParentMessage = !info.sessionID || info.sessionID === session.sessionId;
      if (isParentMessage) {
        // Anchor the seen-watermark on the PARENT turn's final assistant message
        // id (a child's id must never become the watermark).
        if (info.id) session.lastMessageId = info.id;
        this.closeSubagentStatusOnParentTurnEnd(key);
        // S7: advance the persisted watermark on EACH parent-message `finish`,
        // not only at turn-end idle. The bot relays every completed assistant
        // message live (`flushOutput` below), so tracking each finished parent id
        // keeps `missedCount` at what was genuinely unseen — a mid-turn restart
        // after these messages already landed re-shows nothing (the false
        // "missed N" fix, live 2026-07-04). The `session.idle` advance stays as
        // the final safety net (a dropped `finish`); child messages never reach
        // here (the `isParentMessage` guard).
        this.advanceSeenWatermark(key, { sessionId: session.sessionId, opencodeMessageId: session.lastMessageId });
      }
      this.flushOutput(key);
    }

    // Surface errors to the user — except a bot-issued abort ("Aborted"), which
    // the aborted turn's assistant message also carries in `info.error`. It is
    // swallowed for the same reason as the `session.error` twin above (the
    // question-cancel / `/esc` / provider-retry interrupt is ours, not a fault).
    if (info.error) {
      const errorMsg = this.extractErrorMessage(info.error);
      if (checkIsOpenCodeAbortError(errorMsg)) {
        console.log(`[OpenCode] Swallowed bot-issued abort (message.error "Aborted") for ${keyToString(key)}`);
      } else {
        console.error(`[OpenCode] Message error:`, errorMsg);
        this.emit('output', key, `Error: ${errorMsg}`);
      }
    }
  }

  /**
   * @description Handle session becoming idle (AI done processing).
   * Flush any remaining accumulated output.
   */
  private handleSessionIdle(key: ThreadKey, properties: Record<string, unknown>): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    const sessionId = properties.sessionID as string | undefined;
    if (sessionId && !checkIsEventForSession(sessionId, session.sessionId, this.sessionLineage)) return;

    const isOwnIdle = !sessionId || sessionId === session.sessionId;
    // Snapshot the wedged-turn guards BEFORE the own-idle clears below reset
    // them: a legitimate compaction cycle and a still-pending provider retry
    // both idle without assistant text and must NOT be flagged as wedged.
    const wasCompacting = session.isCompacting;
    const hadPendingProviderRetry = session.providerRetrySignature !== null;

    // Idle = busy/idle transition to idle; also a defensive clear if a
    // `session.status` idle was missed. Own idle also ends any compaction
    // (the `.ended` / `session.compacted` event may be lost) — without this the
    // latched flag would force every later prompt down the queue path.
    if (isOwnIdle) {
      session.isCompacting = false;
      session.providerRetrySignature = null;
    }
    applyOpenCodeStatusEvent(
      session,
      session.sessionId,
      sessionId ?? null,
      false,
      this.checkIsVerifiedDescendant(sessionId ?? null, session.sessionId),
    );

    // The PARENT going idle ends the turn → defensively close the sub-agent
    // status. A CHILD (sub-agent) idle (routed here via lineage) must NOT close
    // it — the delegation is still in flight, only the child finished a step.
    if (!sessionId || sessionId === session.sessionId) {
      this.closeSubagentStatusOnParentTurnEnd(key);
    }

    console.log(`[OpenCode] Session idle`);
    // The turn just ended: mark this flush final so the bot delivers the last
    // frame promptly instead of letting it sit out a stretched 429 debounce.
    this.flushOutput(key, true);

    // Advance the seen-watermark only on the PARENT's own idle — a sub-agent
    // child idle (routed here via lineage) leaves the parent turn in flight.
    // Anchored on the last completed parent assistant message id (captured in
    // handleMessageUpdate); a missing anchor is skipped (recap falls back).
    // S7: this is now the SAFETY NET — the primary advance runs per parent
    // `finish` in handleMessageUpdate, so a mid-turn restart already sees the
    // relayed tail; idle still fires in case a `finish` was dropped.
    if (isOwnIdle) {
      this.advanceSeenWatermark(key, { sessionId: session.sessionId, opencodeMessageId: session.lastMessageId });
    }

    // Wedged-turn detection: a delivered prompt that produced NO assistant
    // activity before idling means OpenCode accepted it but never ran a turn
    // (a bloated / stuck session — live 2026-08-15). Surface a notice so the
    // topic doesn't look silently hung. Resolved once per prompt: the pending
    // flag is cleared on this own idle regardless of the outcome.
    if (isOwnIdle && session.awaitingTurnResponse) {
      const isWedged = checkIsWedgedTurn({
        awaitingResponse: true,
        sawActivity: session.sawTurnActivity,
        wasCompacting,
        hadPendingProviderRetry,
      });
      session.awaitingTurnResponse = false;
      if (isWedged) {
        console.warn(`[OpenCode] Prompt produced no turn (wedged session) for ${keyToString(key)}`);
        appendDiagLog(`prompt NO-RESPONSE wedged key=${keyToString(key)} session=${session.sessionId}`);
        this.emit(
          'output',
          key,
          this.tl(key, () => t('agent.no_response')),
          { isComplete: true } satisfies OutputEventMeta,
        );
      }
    }
  }

  /**
   * @description Track live busy/idle/retry from `session.status`. The own
   * session's status drives {@link OpenCodeSession.isBusy}; provider-managed
   * retry remains busy and is surfaced once, because OpenCode otherwise accepts
   * later prompts into an unread queue with no user-visible explanation. A
   * lineage-verified child
   * (sub-agent) status maintains {@link OpenCodeSession.busyChildSessionIds}
   * so a new prompt never aborts a running sub-agent. A foreign non-descendant
   * session's busy=true (dir-fallback-routed wedged sibling) is ignored —
   * see {@link applyOpenCodeStatusEvent}.
   */
  private handleSessionStatus(
    key: ThreadKey,
    eventSessionId: string | null,
    properties: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    const status = properties.status as OpenCodeSessionStatus | undefined;
    const isProviderRetry = status?.type === 'retry';
    const wasForeignBusyIgnored = applyOpenCodeStatusEvent(
      session,
      session.sessionId,
      eventSessionId,
      status?.type === 'busy' || isProviderRetry,
      this.checkIsVerifiedDescendant(eventSessionId, session.sessionId),
    );
    if (wasForeignBusyIgnored && eventSessionId) {
      this.logForeignBusyIgnoredOncePerWindow(eventSessionId, session.sessionId);
    }

    const isOwnSession = !eventSessionId || eventSessionId === session.sessionId;
    if (!isOwnSession) return;
    if (!isProviderRetry) {
      if (!session.providerRetryAbortPromise) {
        session.providerRetrySignature = null;
      }
      return;
    }

    const retryAttempt = typeof status.attempt === 'number' ? status.attempt : 1;
    const retryAt = typeof status.next === 'number' ? status.next : Date.now();
    const retryMessage = typeof status.message === 'string' ? status.message : '';
    const retrySignature = `${retryAttempt}:${retryAt}:${retryMessage}`;
    if (session.providerRetrySignature === retrySignature) return;

    session.providerRetrySignature = retrySignature;
    const retryMinutes = Math.max(1, Math.ceil((retryAt - Date.now()) / providerRetryMsPerMinute));
    console.warn(`[OpenCode] Provider retry attempt=${retryAttempt} in=${retryMinutes}m: ${retryMessage}`);
    this.emit(
      'output',
      key,
      this.tl(key, () => t('apiRetry.transientNotice', { minutes: retryMinutes, attempt: retryAttempt })),
      { isComplete: true } satisfies OutputEventMeta,
    );
  }

  /**
   * @description Strict-descendant verification for busy tracking: `true` only
   * when `eventSessionId` walks up the lineage map to `ownSessionId` — never
   * for the own id itself or a foreign sibling. Distinct from
   * {@link checkIsEventForSession} (own-or-descendant), which routing uses.
   */
  private checkIsVerifiedDescendant(eventSessionId: string | null, ownSessionId: string): boolean {
    return (
      eventSessionId !== null &&
      getLineageDepthToAncestor(eventSessionId, ownSessionId, this.sessionLineage) !== null
    );
  }

  /**
   * @description Diag-log one "busy-ignored" line for a foreign non-descendant
   * busy=true that busy tracking refused to record, throttled per session id
   * like {@link logSseDropOncePerWindow} — a wedged sibling re-emits
   * `session.status` every ~30 s and would otherwise flood the diag log.
   */
  private logForeignBusyIgnoredOncePerWindow(eventSessionId: string, ownSessionId: string): void {
    const shouldLog = checkShouldLogDrop(
      this.sseDropLogThrottle,
      foreignBusyIgnoredLogType,
      eventSessionId,
      Date.now(),
      sseDropLogThrottleMs,
      maxSseDropThrottleEntries,
    );
    if (shouldLog) {
      appendDiagLog(`sse busy-ignored foreign es=${eventSessionId} own=${ownSessionId}`);
    }
  }

  /**
   * @description Flip the compaction flag from `session.next.compaction.*` /
   * `session.compacted` events. While set, a new prompt queues instead of
   * aborting (an abort would discard the in-progress summary).
   */
  private setCompacting(key: ThreadKey, value: boolean): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;
    if (session.isCompacting !== value) console.log(`[OpenCode] compacting=${value}`);
    session.isCompacting = value;
  }

  private handleSessionError(key: ThreadKey, eventSessionId: string | null, properties: Record<string, unknown>): void {
    const errorMsg = this.extractErrorMessage(properties.error);
    const session = this.sessions.get(keyToString(key));
    const isOwnSession = !eventSessionId || (session !== undefined && eventSessionId === session.sessionId);

    // A bare "Aborted" error is ALWAYS a bot-issued abort (question-cancel SIGINT
    // / `/esc` / provider-retry interrupt) — never surface it as "OpenCode error:
    // Aborted" (the reported third bogus message on the question-cancel path).
    // The turn DID end, so still close the sub-agent status for the own session.
    if (checkIsOpenCodeAbortError(errorMsg)) {
      console.log(`[OpenCode] Swallowed bot-issued abort (session.error "Aborted") for ${keyToString(key)}`);
      if (session?.isActive && isOwnSession) this.closeSubagentStatusOnParentTurnEnd(key);
      return;
    }

    console.error(`[OpenCode] Session error:`, errorMsg);
    this.emit('output', key, `OpenCode error: ${errorMsg}`);

    // A PARENT-session error aborts the current turn/generation, so the
    // delegation the dedicated sub-agent status describes is no longer running:
    // close it defensively (mirrors the parent-idle / parent-finish closes) so
    // an error that never reaches a clean idle can't leave the "working" frame
    // and its self-re-arming tick wedged, flooding the topic (live 2026-08-03).
    // A CHILD (sub-agent) error must NOT close it — the parent delegation is
    // still in flight (guarded the same way as `handleSessionIdle`). If an
    // auto-retry re-delegates, a fresh `subagentStatus{active:true}` re-opens it.
    if (session?.isActive && isOwnSession) {
      this.closeSubagentStatusOnParentTurnEnd(key);
    }

    // Provider-side API error at the proxy boundary → emit `apiError`. transient
    // / usageLimit arm the auto-retry (the session stays active after
    // `session.error`, so the kick reuses it); `auth` (logged out / bad
    // credentials) is SURFACED as a pinned notice by the bot, never retried.
    // Unrecognised errors classify to `null` and emit nothing.
    const apiError: AgentApiErrorClass | null = classifyAgentApiError(errorMsg, Date.now());
    if (apiError) {
      this.emit('apiError', key, apiError);
    }
  }

  private handlePermissionAsked(_key: ThreadKey, properties: Record<string, unknown>, directory?: string): void {
    console.log(`[OpenCode] Permission requested:`, JSON.stringify(properties));
    // Auto-approve all permissions (headless mode). Symmetry with the
    // claude adapter, which always passes `--dangerously-skip-permissions`
    // (plan D44, §10.2). Per-thread opt-out (S1) was deliberately rejected
    // — if it ever comes back, this is where it'd hook in.
    const requestId = (properties.requestID || properties.id) as string | undefined;
    if (requestId) {
      // Permission state is instance-local, like questions: an approve sent
      // without the owning `?directory=` 404s silently and the agent hangs
      // on the permission forever.
      this.apiRequest('POST', buildDirectoryScopedPath(`/permission/${requestId}/reply`, directory), {
        reply: 'always',
      }).catch((e) => {
        console.error(`[OpenCode] Failed to reply to permission:`, e);
      });
    }
  }

  /**
   * @description Handle question.asked events from OpenCode.
   * Stores the pending question and emits a 'question' event so the bot
   * can display it to the user with interactive buttons.
   *
   * Event properties: { id, sessionID, questions: QuestionInfo[], tool? }
   */
  private handleQuestionAsked(key: ThreadKey, properties: Record<string, unknown>, directory?: string): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    const requestId = (properties.requestID || properties.id) as string | undefined;
    const questions = properties.questions as OpenCodeQuestion[] | undefined;

    console.log(`[OpenCode] Question asked (${requestId}, instance=${directory ?? 'default'}):`, JSON.stringify(properties).slice(0, 500));

    if (!requestId || !questions || questions.length === 0) {
      // No valid question — reply empty to unblock
      if (requestId) {
        this.apiRequest('POST', buildDirectoryScopedPath(`/question/${requestId}/reply`, directory), {
          answers: [['']],
        }).catch((e) => console.error(`[OpenCode] Failed to reply to question:`, e));
      }
      return;
    }

    // Store pending question so we can reply later when user answers.
    // `directory` rides along: the reply must target the instance that owns
    // the request, not the serve-cwd default (QuestionNotFoundError bug —
    // sessions live in whatever instance was current at their creation).
    session.pendingQuestion = { requestId, questions, directory };

    // Emit question event for the bot to display to user
    this.emit('question', key, session.pendingQuestion);
  }

  /**
   * @description Re-surface a question that was still open on the server when
   * the bot lost track of it — the reattach/resume path rebuilds the session
   * with `pendingQuestion: null`, so after ANY bot restart an unanswered
   * question would otherwise be forgotten and the topic hangs forever (the
   * break-out that turns a user message into the ANSWER never fires, and a
   * fresh prompt just queues behind the still-blocked turn).
   *
   * `GET /question?directory=<workDir>` returns the instance's live open
   * questions; we pick the entry owned by this session, rebuild
   * `session.pendingQuestion`, and emit `question` so the existing bot handler
   * re-posts the option buttons and repopulates (and persists) its pending map.
   * Reply id is the entry's top-level `id` (`que_…`), resolved by the pure
   * {@link getOpenQuestionForSession} helper.
   *
   * Best-effort: a read/parse failure is logged and swallowed — it must never
   * throw out of reattach. Only meaningful on the resume/reattach path; a
   * brand-new session (startSession) has no history and thus no open question,
   * so it is deliberately NOT called there.
   */
  private async restoreOpenQuestion(key: ThreadKey, sessionId: string, workDir: string): Promise<void> {
    try {
      const response = await this.apiRequest<unknown>(
        'GET',
        buildDirectoryScopedPath('/question', workDir),
      );
      const restored = getOpenQuestionForSession(response, sessionId, workDir);
      if (!restored) return;

      // The session may have been stopped/replaced between the GET and now.
      const session = this.sessions.get(keyToString(key));
      if (!session?.isActive || session.sessionId !== sessionId) return;

      session.pendingQuestion = restored;
      console.log(`[OpenCode] Restored open question ${restored.requestId} for ${keyToString(key)} on reattach`);
      this.emit('question', key, restored);
    } catch (e) {
      console.warn(`[OpenCode] restore open question failed:`, e instanceof Error ? e.message : e);
    }
  }

  /**
   * @description Backstop predicate (G2): is this session's turn wedged behind
   * an open interactive question? The authoritative signal is the server's own
   * `GET /question?directory=<workDir>` returning an entry for this session —
   * a turn that is merely streaming text / running a normal tool / has a live
   * sub-agent has NO open question, so it is never reported wedged (no
   * regression: an arriving prompt still queues-and-is-picked-up for a healthy
   * busy turn). The bot consults this only when a fresh prompt would otherwise
   * queue behind a busy session with no known pending question; on `true` it
   * aborts the dead turn before forwarding instead of queueing forever.
   *
   * Best-effort: a read/parse failure returns `false` (don't abort on doubt).
   */
  async checkIsWedgedOnQuestion(key: ThreadKey): Promise<boolean> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return false;

    try {
      const response = await this.apiRequest<unknown>(
        'GET',
        buildDirectoryScopedPath('/question', session.workDir),
      );
      return getOpenQuestionForSession(response, session.sessionId, session.workDir) !== null;
    } catch (e) {
      console.warn(`[OpenCode] wedged-question check failed:`, e instanceof Error ? e.message : e);
      return false;
    }
  }

  /**
   * @description Reply to a pending question with user-selected answers.
   * Called by the bot when the user clicks an inline button or types a custom answer.
   */
  answerQuestion(key: ThreadKey, answers: string[][]): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive || !session.pendingQuestion) return;

    const { requestId, directory } = session.pendingQuestion;
    session.pendingQuestion = null;

    // Audit S15 / #41: surface failures via `error` so the bot's
    // handleAgentError shows them in the thread, not just in console.
    this.apiRequest('POST', buildDirectoryScopedPath(`/question/${requestId}/reply`, directory), {
      answers,
    }).catch((e) => {
      console.error(`[OpenCode] Failed to reply to question:`, e);
      this.emit('error', key, e instanceof Error ? e : new Error(String(e)));
    });
  }

  /**
   * @description Reject a pending question server-side WITHOUT answering it —
   * called when the user ABANDONS the question (sends a fresh prompt instead of
   * answering, or the session is torn down while it is pending). Mirrors
   * {@link answerQuestion} but POSTs to `/question/:id/reject` (empty body)
   * instead of `/reply`. Without it the question stays "open" in the server's
   * registry and {@link restoreOpenQuestion} re-surfaces it on every reattach.
   * No-op if no active session / no pending question.
   */
  rejectQuestion(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive || !session.pendingQuestion) return;

    const { requestId, directory } = session.pendingQuestion;
    session.pendingQuestion = null;

    // Same failure surfacing as answerQuestion: route errors through `error` so
    // the bot's handleAgentError shows them in the thread, not just console.
    this.apiRequest('POST', buildDirectoryScopedPath(`/question/${requestId}/reject`, directory), {}).catch((e) => {
      console.error(`[OpenCode] Failed to reject question:`, e);
      this.emit('error', key, e instanceof Error ? e : new Error(String(e)));
    });
  }

  /**
   * @description Extract human-readable message from OpenCode error objects.
   * Handles { name, data: { message } } and { message } shapes.
   */
  private extractErrorMessage(error: unknown): string {
    if (typeof error === 'string') return error;
    if (!error || typeof error !== 'object') return String(error);

    const err = error as Record<string, unknown>;

    // Shape: { name: "APIError", data: { message: "..." } }
    if (err.data && typeof err.data === 'object') {
      const data = err.data as Record<string, unknown>;
      if (typeof data.message === 'string') return data.message;
    }

    // Shape: { message: "..." }
    if (typeof err.message === 'string') return err.message;

    return JSON.stringify(error);
  }

  private flushOutput(key: ThreadKey, isFinal = false): void {
    const session = this.sessions.get(keyToString(key));
    if (!session) return;

    if (session.outputTimer) {
      clearTimeout(session.outputTimer);
      session.outputTimer = null;
    }

    // Flush any pending status before flushing text output
    if (session.statusDebounceTimer) {
      clearTimeout(session.statusDebounceTimer);
      session.statusDebounceTimer = null;
    }
    if (session.pendingStatus) {
      this.emit('status', key, session.pendingStatus);
      session.pendingStatus = null;
    }

    // Reasoning end signals #2/#3: the turn flush fires from both the
    // `message.updated` finish and `session.idle`. Idempotent — a no-op if a
    // non-reasoning part already ended reasoning (signal #1).
    this.endReasoning(key, session);

    // Flush the CHILD (sub-agent) accumulator first (it streamed earlier than
    // the parent's closing text): clear its debounce and emit any unsent
    // marked tail before the reset below would drop it. The child idle event
    // routes here too (lineage), so a finished sub-agent flushes promptly.
    if (session.childOutputTimer) {
      clearTimeout(session.childOutputTimer);
      session.childOutputTimer = null;
    }
    this.emitChildResponseTail(key, session);

    this.emitResponseTail(key, session, isFinal);

    session.currentResponseText = '';
    session.lastEmittedLength = 0;
    session.childResponseText = '';
    session.childLastEmittedLength = 0;
    session.partTypes.clear();
  }

  /**
   * @description Defensive close of the dedicated sub-agent status when the
   * PARENT's own turn ends (its assistant message finishes, or its session goes
   * idle) so a dangling "working" indicator can't outlive the turn if the
   * terminal `task` part was missed. Strictly parent-only: a CHILD (sub-agent)
   * message finishing / going idle must NOT close it — the delegation is still
   * in flight (its child events route here via lineage). The bot no-ops the
   * close when nothing is open.
   */
  private closeSubagentStatusOnParentTurnEnd(key: ThreadKey): void {
    this.emit('subagentStatus', key, { active: false, title: null });
  }
}
