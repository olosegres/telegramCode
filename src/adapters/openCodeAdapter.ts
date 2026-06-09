import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentAdapter, AgentApiErrorClass, AgentSession, OpenCodePendingQuestion, OpenCodeQuestion, OutputEventMeta, RecentTurn, ResumeSessionOptions, ThreadKey } from '../types';
import { keyToString } from '../types';
import { classifyAgentApiError } from '../apiErrorRetry';
import { checkIsInstalled, installTool, checkIsOpenCodeServerRunning, ensureOpenCodeServer, getToolCommand, onOpenCodeServerExit } from '../installManager';
import { resolveDataDir } from '../state';
import { appendDiagLog } from '../diagLog';
import {
  checkIsEventForSession,
  checkShouldLogDrop,
  getEventOwnerKey,
  resolveOwnerByDirectoryFallback as resolveOwnerByDirectoryFallbackPure,
  touchLineageOnUse,
  updateSessionLineage,
  type BoundSessionRef,
} from '../openCodeSessionRouting';
import { t } from '../i18n';
import { formatResumeContext, resumeContextTurnLimit } from '../resumeContext';
import { stripThreadContextPreamble } from '../threadContextPreamble';
import { buildOpenCodeSchedulerMcpRegistration } from '../scheduler/injection';
import {
  buildSessionTitleSnippet,
  checkIsMeaningfulPrompt,
  checkIsPlaceholderTitle,
} from '../openCodeSessionTitle';
import {
  countActiveSessionsForDirectory,
  getSseStreamTransition,
  type DirectoryBoundSession,
} from '../utils/sseStreamLifecycle';

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
   * probe). A new prompt never aborts a busy turn — `prompt_async` queues it
   * and OpenCode picks it up quickly (user decision 2026-06-06).
   */
  isBusy: boolean;
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
 * @description Live SSE stream owned by the adapter for ONE bound directory
 * (plan 2026-06-05 S5). Threads bound to the same folder share this single
 * stream — the server delivers only that directory instance's events on
 * `/event?directory=<workDir>`, so each event is parsed once and routed to the
 * owning session. Opened when the first active session for the directory
 * appears, closed when the last one goes away.
 */
interface SseStreamState {
  /** The bound directory this stream is scoped to (the `?directory=` value). */
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
   * directory entry is also deleted from the stream map, but a reconnect
   * promise may already hold a stale reference.
   */
  isClosed: boolean;
  /**
   * Latch set once the scheduler MCP server has been registered for this
   * directory's instance (plan S6). The stream's lifetime IS the server
   * generation: a fresh stream opens per directory on start/resume and again
   * after `restartServer` re-opens streams, so registering on the first
   * `ensureDirectoryStream` per stream re-registers exactly when the runtime
   * registration would have died with the old server — once per directory per
   * server generation, not once per session.
   */
  isSchedulerMcpRegistered: boolean;
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
      if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
        const trimmed = part.text.trim();
        if (trimmed) textChunks.push(trimmed);
      }
    }
    if (textChunks.length === 0) continue;
    turns.push({ role, text: textChunks.join('\n\n') });
  }
  return turns.slice(-limit);
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
 * @description Grace period before the bot-side fallback rename checks whether
 * opencode's native auto-title has landed. Auto-title is generated as a side
 * effect of the first prompt's LLM turn; it was observed live to appear within
 * ~2-3 s. We wait comfortably longer so the fallback only fires when auto-title
 * genuinely failed — it must never overwrite a real LLM name with a raw snippet.
 */
const fallbackRenameGraceMs = 8000;

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
 * drives `isBusy`; a routed CHILD (sub-agent) session's status maintains
 * `busyChildSessionIds` — a child going idle must NOT clear the parent's
 * `isBusy`. Pure + exported so the own-vs-child routing is unit-testable.
 */
export function applyOpenCodeStatusEvent(
  tracking: OpenCodeBusyTracking,
  ownSessionId: string,
  eventSessionId: string | null,
  isBusy: boolean,
): void {
  if (!eventSessionId || eventSessionId === ownSessionId) {
    tracking.isBusy = isBusy;
  } else if (isBusy) {
    tracking.busyChildSessionIds.add(eventSessionId);
  } else {
    tracking.busyChildSessionIds.delete(eventSessionId);
  }
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
   * One SSE stream per unique bound directory (plan 2026-06-05 S5), keyed by
   * the directory path. The server delivers only that directory instance's
   * events on `/event?directory=<dir>`, so threads sharing a folder share one
   * stream and each event is JSON-parsed once. Opened when the first active
   * session for a directory appears, closed when the last one goes away.
   */
  private sseStreams: Map<string, SseStreamState> = new Map();

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
  private async restartServer(): Promise<boolean> {
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
      await ensureOpenCodeServer();
      console.log(`[OpenCode] Server restarted successfully`);

      // Close every directory stream up front: their readers point at the
      // crashed server's connection. The resume loop below re-opens a fresh
      // stream per still-active directory (plan 2026-06-05 S5: re-open the
      // directory streams, then restore sessions). Without this, a stream
      // shared by two threads would keep its stale reader (it only self-heals
      // later via the stall watchdog) — re-opening here makes recovery
      // deterministic and tied to the restart.
      this.closeAllStreams();

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
          this.emit('output', sessionKey, `OpenCode server restarted; previous session lost. Starting a fresh one with /opencode (or /stop to release).`);
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
          isModelInfoShown: false,
          modelOverride: null,
          currentModelLabel: null,
          partTypes: new Map(),
          statusDebounceTimer: null,
          pendingStatus: null,
          pendingQuestion: null,
          effortLevel: loadSavedEffort(key),
          isBusy: false,
          isCompacting: false,
          busyChildSessionIds: new Set(),
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
    // Audit S8 / #11: previously the status timer kept firing after
    // `stopSession`, emitting transient `status` events to a thread that
    // had just announced `stopped`.
    if (session.statusDebounceTimer) {
      clearTimeout(session.statusDebounceTimer);
      session.statusDebounceTimer = null;
    }

    // Tear down the directory's SSE stream if this was its last active session
    // (also clears that stream's reconnect + stall timers).
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
    // Mark busy optimistically so an immediately-following message correctly
    // sees a turn in flight; the `session.status` stream corrects/confirms it.
    session.isBusy = true;

    // Model + reasoning-effort overrides ride the prompt body (see buildPromptBody).
    const body = buildPromptBody(input, session.modelOverride, session.effortLevel);

    void (async () => {
      try {
        await this.apiRequest('POST', `/session/${session.sessionId}/prompt_async`, body);
      } catch (e) {
        // The optimistic `isBusy = true` above never gets a `session.status`
        // idle to clear it if the POST failed — clear it so the next prompt
        // doesn't eat a spurious abort + wait.
        const current = this.sessions.get(keyToString(key));
        if (current) current.isBusy = false;
        console.error(`[OpenCode] Failed to send message:`, e);
        this.emit('error', key, e instanceof Error ? e : new Error(String(e)));
      }
    })();
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

      // Plan 2026-05-30-effort-command / S4: a stored effort the NEW model
      // can't honour (variant absent) is dropped so the next prompt doesn't
      // POST an invalid variant — and the user is told why their effort reset.
      if (session.effortLevel) {
        const stillValid = (await this.getAvailableEffortLevels(key)).includes(session.effortLevel);
        if (!stillValid) {
          const dropped = session.effortLevel;
          session.effortLevel = null;
          clearEffortPref(key);
          this.emit('output', key, t('effort.cleared_on_model_switch', { level: dropped, model: label }));
        }
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
        isModelInfoShown: false,
        modelOverride: null,
        currentModelLabel: null,
        partTypes: new Map(),
        statusDebounceTimer: null,
        pendingStatus: null,
        pendingQuestion: null,
        effortLevel: loadSavedEffort(key),
        isBusy: false,
        isCompacting: false,
        busyChildSessionIds: new Set(),
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
          if (rendered) this.emit('output', key, rendered);
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
    } catch (e) {
      console.error(`[OpenCode] Failed to resume session:`, e);
      throw e;
    }
  }

  /**
   * @description Ensure the SSE stream for this session's bound directory is
   * open (plan 2026-06-05 S5). Called after a session is inserted active into
   * `this.sessions` (start / resume / restart). Threads sharing a folder share
   * one stream: the stream opens only for the FIRST active session in a
   * directory; later sessions reuse it. Keeps the `(key)` signature so the
   * lifecycle paths and tests (which stub `connectSse` to a no-op) are
   * unchanged.
   */
  private connectSse(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session) return;
    this.ensureDirectoryStream(session.workDir);
  }

  /**
   * @description Mark a session inactive and tear down its directory's SSE
   * stream IFF it was the last active session sharing that folder. The stream
   * is reference-counted by directory (recomputed from `this.sessions` so it
   * can never drift): a sibling session in the same folder keeps it open.
   *
   * Order-independent: callers vary in whether they pre-set `isActive = false`
   * (`stopSessionInner` does, before calling here), so the decision counts
   * OTHER active sessions for the directory and treats this one as departing.
   * `before = other + 1`, `after = other` → `close` exactly when no sibling
   * keeps the stream alive.
   */
  private disconnectSse(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session) return;
    const { workDir } = session;
    session.isActive = false;
    const otherActive = this.countOtherActiveSessionsForDir(workDir, key);
    if (getSseStreamTransition(otherActive + 1, otherActive) === 'close') {
      this.closeDirectoryStream(workDir);
    }
  }

  /**
   * @description All sessions reduced to the directory-routing shape for the
   * pure helpers, optionally excluding one key (the departing session in a
   * teardown decision).
   */
  private getDirectoryBoundSessions(excludeKey?: ThreadKey): DirectoryBoundSession[] {
    const excludeKeyStr = excludeKey ? keyToString(excludeKey) : null;
    const bound: DirectoryBoundSession[] = [];
    for (const [keyStr, session] of this.sessions) {
      if (keyStr === excludeKeyStr) continue;
      bound.push({ workDir: session.workDir, isActive: session.isActive });
    }
    return bound;
  }

  /**
   * @description Active sessions bound to `directory` EXCLUDING `key` — the
   * sibling count that decides whether a departing session's stream stays up.
   */
  private countOtherActiveSessionsForDir(directory: string, key: ThreadKey): number {
    return countActiveSessionsForDirectory(this.getDirectoryBoundSessions(key), directory);
  }

  /**
   * @description Open the SSE stream for `directory` if it is not already open.
   * Idempotent — a second active session in the same folder finds the stream
   * present and no-ops. The reader runs detached; a fatal start error surfaces
   * to every session bound to the directory so the user isn't left with a
   * silently-dead session (audit S10 / #43).
   */
  private ensureDirectoryStream(directory: string): void {
    if (this.sseStreams.has(directory)) return;

    const stream: SseStreamState = {
      directory,
      controller: null,
      stallTimer: null,
      reconnectTimer: null,
      isClosed: false,
      isSchedulerMcpRegistered: false,
    };
    this.sseStreams.set(directory, stream);

    // Register the bot's scheduler MCP server for this directory's instance
    // (plan S6). Tied to the stream so it re-runs once per server generation:
    // a runtime registration dies with the opencode server, and a fresh stream
    // is what `restartServer` re-opens after the self-heal. Fire-and-forget —
    // `ensureDirectoryStream` is sync and the registration is an enhancement,
    // not a dependency of the session starting.
    void this.registerSchedulerMcpForDirectory(stream);

    // `/event?directory=<dir>` delivers ONLY this directory instance's events
    // (verified live, opencode 1.16.0) — no `/global/event` multiplex, so each
    // event is parsed once here and routed to its owning session.
    const sseUrl = `${this.baseUrl}${buildDirectoryScopedPath('/event', directory)}`;
    console.log(`[OpenCode] Connecting SSE for ${directory}: ${sseUrl}`);
    appendDiagLog(`sse open dir=${directory}`);

    this.pollSseStream(stream, sseUrl).catch((e) => {
      console.error(`[OpenCode] SSE connection error for ${directory}:`, e);
      this.emitToDirectorySessions(directory, 'error', e instanceof Error ? e : new Error(String(e)));
    });
  }

  /**
   * @description Register the bot's scheduler MCP server for `stream.directory`'s
   * OpenCode instance via the runtime `POST /mcp?directory=` endpoint (plan S6).
   * Idempotent on the server (re-POSTing the same `name` overwrites/no-ops), and
   * gated by `stream.isSchedulerMcpRegistered` so it runs once per stream (i.e.
   * once per directory per server generation). Inert until S8 wires injection —
   * the builder returns `null` and this no-ops. A registration FAILURE is logged
   * and swallowed: scheduling tools are an enhancement, the session must still
   * start (and the stream may have closed mid-flight, so re-check before latching).
   */
  private async registerSchedulerMcpForDirectory(stream: SseStreamState): Promise<void> {
    if (stream.isSchedulerMcpRegistered || stream.isClosed) return;
    const registration = await buildOpenCodeSchedulerMcpRegistration(stream.directory);
    if (!registration) return;
    if (stream.isClosed) return;
    try {
      await this.apiRequest(
        'POST',
        buildDirectoryScopedPath('/mcp', stream.directory),
        registration,
      );
      stream.isSchedulerMcpRegistered = true;
      appendDiagLog(`scheduler mcp registered dir=${stream.directory}`);
    } catch (e) {
      console.warn(
        `[OpenCode] scheduler MCP registration failed for ${stream.directory}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  /**
   * @description Tear down the SSE stream for `directory`: latch it closed,
   * abort the in-flight reader (unblocks `reader.read()` immediately — audit
   * S7 / #12), cancel its stall + reconnect timers, and drop it from the map.
   */
  private closeDirectoryStream(directory: string): void {
    const stream = this.sseStreams.get(directory);
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
    this.sseStreams.delete(directory);
    appendDiagLog(`sse close dir=${directory}`);
  }

  /**
   * @description Close every open directory stream (used on server restart
   * before re-opening fresh ones). Iterates a snapshot of directories so
   * deletion during the loop is safe.
   */
  private closeAllStreams(): void {
    for (const directory of Array.from(this.sseStreams.keys())) {
      this.closeDirectoryStream(directory);
    }
  }

  /** Emit an event to every active session bound to `directory`. */
  private emitToDirectorySessions(
    directory: string,
    eventName: 'error',
    error: Error,
  ): void {
    for (const session of this.sessions.values()) {
      if (session.isActive && session.workDir === directory) {
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
   * @description Fetch-based SSE reader for ONE directory's `/event?directory=`
   * stream (plan 2026-06-05 S5). OpenCode sends every event as a `data:` line
   * with JSON payload { type, properties }; this stream carries only the
   * directory instance's own events, so each line is parsed once here and
   * routed to its owning session.
   *
   * On connection failure: checks if the server is alive, attempts a restart if
   * dead, and retries forever with capped exponential backoff until reconnect
   * succeeds — as long as the stream is still wanted (not closed).
   */
  private async pollSseStream(stream: SseStreamState, sseUrl: string, reconnectAttempt = 0, reconnectStartTs = Date.now()): Promise<void> {
    if (stream.isClosed) return;
    const { directory } = stream;

    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
    };
    if (this.authHeader) {
      headers['Authorization'] = this.authHeader;
    }

    // Audit S7 / #12: SSE was previously read with no abort path —
    // `await reader.read()` blocks until bytes arrive, so a teardown during a
    // silent server couldn't actually free the connection. The stream-scoped
    // controller is stored so `closeDirectoryStream` can abort the in-flight
    // `fetch` and `reader.read` immediately.
    const controller = new AbortController();
    stream.controller = controller;

    let sawData = false;

    try {
      const response = await fetch(sseUrl, { headers, signal: controller.signal });

      if (!response.ok || !response.body) {
        console.error(`[OpenCode] SSE connection failed for ${directory}: ${response.status}`);
        await response.body?.cancel().catch(() => {});
        await this.handleSseReconnect(stream, sseUrl, reconnectAttempt, reconnectStartTs, `HTTP ${response.status}`);
        return;
      }

      console.log(`[OpenCode] SSE connected for ${directory}`);
      appendDiagLog(`sse connected dir=${directory} attempt=${reconnectAttempt}`);

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
          appendDiagLog(`sse first-data dir=${directory}`);
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const dataStr = line.slice(6);
          this.routeSseData(directory, dataStr);
        }
      }

      // Leaving the read loop: disarm before any reconnect await so the
      // watchdog can't fire against this (now-finished) controller.
      this.clearStreamStallTimer(stream);
      reader.cancel().catch(() => {});

      // If the stream is still wanted but the server closed it, reconnect.
      if (!stream.isClosed) {
        console.log(`[OpenCode] SSE stream for ${directory} ended while wanted, reconnecting...`);
        await this.handleSseReconnect(stream, sseUrl, reconnectAttempt, reconnectStartTs, 'stream ended');
      }
    } catch (e) {
      this.clearStreamStallTimer(stream);
      // An aborted controller means either `closeDirectoryStream` (stream no
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
        console.error(`[OpenCode] SSE error for ${directory}:`, errorMessage);
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
   * @description Handle SSE reconnection for a directory's stream with server
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
    const { directory } = stream;

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
      // restartServer re-opens streams for every still-active directory via the
      // resume path; if this stream was torn down in the process, stop here so
      // we don't double-open it.
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
    console.log(`[OpenCode] SSE reconnecting ${directory} in ${delay}ms (attempt ${attempt + 1}, reason: ${reason}, elapsed: ${Math.round(elapsed / 1000)}s)`);
    appendDiagLog(`sse reconnect dir=${directory} attempt=${attempt + 1} reason=${reason} delay=${delay}ms`);

    // Store the timer handle on the stream so `closeDirectoryStream` can cancel
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
   * @description Route a single raw SSE `data:` line from a directory's stream
   * (the live per-directory reader path, plan 2026-06-05 S5). The JSON is parsed
   * ONCE here, the owning session is resolved from its sessionID/lineage, and
   * the event is dispatched to that session. `streamDirectory` is the stream's
   * own bound folder — passed through so instance-local replies
   * (questions/permissions) target the right project instance even though the
   * bare `/event` payload carries no `directory` field.
   *
   * Also the entry the SSE unit tests drive (a session injected into the map +
   * synthesized event JSON for its own folder), so the real parse→route→dispatch
   * path is exercised end to end.
   */
  private routeSseData(streamDirectory: string, dataStr: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      return;
    }

    const event = normaliseOpenCodeSseEvent(parsed);
    if (!event) return;

    const ownerKeyStr = this.resolveSseEventOwner(event, streamDirectory);
    if (ownerKeyStr === undefined) return;

    // The instance directory is the stream's own folder; the bare `/event`
    // payload omits it, so a wrapped envelope's value (legacy/global) is only a
    // fallback when present.
    const directory = event.directory ?? streamDirectory;

    if (ownerKeyStr === null) {
      // Session-less event (server.connected / heartbeat) — no owner to look up.
      this.dispatchSessionLessEvent(event);
      return;
    }

    const ownerSession = this.sessions.get(ownerKeyStr);
    if (!ownerSession?.isActive) return;
    this.dispatchSseEvent(ownerSession.key, event, directory);
  }

  /**
   * @description Resolve which thread (if any) should process `event`, applying
   * the single-owner invariant (B20) and recording subagent lineage. Owner
   * resolution is by sessionID (direct id, else lineage ancestor) with a
   * DIRECTORY fallback off `streamDirectory` when both miss (S2). Returns:
   *   - the owning thread's serialised key for a per-session event;
   *   - `null` for a session-less event (`server.connected`/`heartbeat`) that
   *     every reader handles directly;
   *   - `undefined` to signal "do not dispatch" (missing sessionID, or no bound
   *     thread owns the session — a genuine drop, loud-logged for every critical
   *     type incl. question/permission, so a routable event is never a no-op).
   */
  private resolveSseEventOwner(event: OpenCodeSseEvent, streamDirectory: string): string | null | undefined {
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

    // Id/lineage resolution failed. Before dropping, fall back to the stream's
    // DIRECTORY (S2): the stream is opened per bound folder, so the event
    // provably belongs to a thread bound to THAT folder even when the per-session
    // lineage map briefly disagrees (link evicted / not yet recorded). SYNC only
    // — no HTTP on the per-event hot path; the decision uses in-memory state.
    const fallbackOwnerKeyStr = this.resolveOwnerByDirectoryFallback(eventSessionId, streamDirectory);
    if (fallbackOwnerKeyStr !== null) {
      appendDiagLog(
        `sse dir-fallback ${eventType} es=${eventSessionId} dir=${streamDirectory} -> ${fallbackOwnerKeyStr}`,
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
   * owning project instance (the stream's folder), used for instance-scoped
   * question / permission replies.
   */
  private dispatchSseEvent(key: ThreadKey, event: OpenCodeSseEvent, directory: string | undefined): void {
    const eventType = event.type;
    const eventSessionId = this.getSessionIdFromEvent(event);

    const session = this.sessions.get(keyToString(key));
    if (session?.isActive && eventSessionId && eventSessionId !== session.sessionId) {
      appendDiagLog(`sse route-descendant ${eventType} es=${eventSessionId} -> ${session.sessionId}`);
    }

    switch (eventType) {
      case 'message.part.updated':
      case 'message.part.delta':
        this.handlePartUpdate(key, event.properties);
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
        this.handleSessionError(key, event.properties);
        break;

      case 'permission.asked':
        this.handlePermissionAsked(key, event.properties, directory);
        break;

      case 'question.asked':
        this.handleQuestionAsked(key, event.properties, directory);
        break;

      default:
        // Log unhandled event types for debugging (skip heartbeats)
        if (eventType !== 'server.heartbeat') {
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
   * @description Directory fallback (S2): resolve an owner from the stream's
   * bound folder when id/lineage resolution already failed. The stream is opened
   * per directory (`?directory=`), so an event on it provably belongs to a
   * thread bound to that folder. SYNC — uses only in-memory session state, NEVER
   * an HTTP call on the per-event hot path. Delegates the decision to the pure
   * {@link resolveOwnerByDirectoryFallbackPure}; the wiring here is just
   * selecting the directory's active sessions.
   */
  private resolveOwnerByDirectoryFallback(eventSessionId: string, streamDirectory: string): string | null {
    const directoryActiveSessions: BoundSessionRef[] = [];
    for (const [keyStr, session] of this.sessions) {
      if (session.isActive && session.workDir === streamDirectory) {
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
   */
  private handlePartUpdate(key: ThreadKey, properties: Record<string, unknown>): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

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

    switch (partType) {
      case 'text':
        this.handleTextDelta(key, session, delta, field);
        break;
      case 'tool':
        this.handleToolPart(key, session, part);
        break;
      case 'reasoning':
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
   * @description Handle tool part — format and emit as 'status'.
   */
  private handleToolPart(
    key: ThreadKey,
    session: OpenCodeSession,
    part: OpenCodePart | undefined,
  ): void {
    if (!part) return;

    const toolName = part.tool || 'tool';
    const state = part.state;
    if (!state) return;

    let statusText: string;
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

    this.emitStatus(key, session, statusText);
  }

  /**
   * @description Handle reasoning (thinking) part — format and emit as 'status'.
   */
  private handleReasoningPart(
    key: ThreadKey,
    session: OpenCodeSession,
    part: OpenCodePart | undefined,
    delta: string | undefined,
    _field: string | undefined,
  ): void {
    // For deltas on reasoning parts, show a thinking indicator
    const text = delta || part?.text || '';
    if (!text) return;

    // Show thinking text preview — first line up to 300 chars
    const preview = text.split('\n')[0].slice(0, 300);
    const statusText = preview ? `💭 ${preview}${text.length > 300 ? '...' : ''}` : '💭 Thinking...';

    this.emitStatus(key, session, statusText);
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

    // Track and show model info on first assistant message (or after model change)
    if (info.role === 'assistant' && info.modelID) {
      const modelLabel = info.providerID
        ? `${info.providerID}/${info.modelID}`
        : info.modelID;
      session.currentModelLabel = modelLabel;

      if (!session.isModelInfoShown) {
        session.isModelInfoShown = true;
        console.log(`[OpenCode] Using model: ${modelLabel}`);
        this.emit('output', key, `Model: ${modelLabel}`);
      }
    }

    // When assistant message completes (has finish reason), flush output
    if (info.finish && info.role === 'assistant') {
      this.flushOutput(key);
    }

    // Surface errors to the user
    if (info.error) {
      const errorMsg = this.extractErrorMessage(info.error);
      console.error(`[OpenCode] Message error:`, errorMsg);
      this.emit('output', key, `Error: ${errorMsg}`);
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

    // Idle = busy/idle transition to idle; also a defensive clear if a
    // `session.status` idle was missed. Own idle also ends any compaction
    // (the `.ended` / `session.compacted` event may be lost) — without this the
    // latched flag would force every later prompt down the queue path.
    if (!sessionId || sessionId === session.sessionId) session.isCompacting = false;
    applyOpenCodeStatusEvent(session, session.sessionId, sessionId ?? null, false);

    console.log(`[OpenCode] Session idle`);
    // The turn just ended: mark this flush final so the bot delivers the last
    // frame promptly instead of letting it sit out a stretched 429 debounce.
    this.flushOutput(key, true);
  }

  /**
   * @description Track live busy/idle from `session.status`. The own session's
   * status drives {@link OpenCodeSession.isBusy}; a routed child (sub-agent)
   * status maintains {@link OpenCodeSession.busyChildSessionIds} so a new
   * prompt never aborts a running sub-agent.
   */
  private handleSessionStatus(
    key: ThreadKey,
    eventSessionId: string | null,
    properties: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    const status = properties.status as { type?: string } | undefined;
    applyOpenCodeStatusEvent(session, session.sessionId, eventSessionId, status?.type === 'busy');
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

  private handleSessionError(key: ThreadKey, properties: Record<string, unknown>): void {
    const errorMsg = this.extractErrorMessage(properties.error);
    console.error(`[OpenCode] Session error:`, errorMsg);
    this.emit('output', key, `OpenCode error: ${errorMsg}`);

    // Provider-side API error at the proxy boundary → arm the auto-retry. The
    // session stays active after `session.error`, so the kick (S5) reuses it.
    // Auth / non-retryable errors classify to `null` and emit nothing.
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

    this.emitResponseTail(key, session, isFinal);

    session.currentResponseText = '';
    session.lastEmittedLength = 0;
    session.partTypes.clear();
  }
}
