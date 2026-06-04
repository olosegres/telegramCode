import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentAdapter, AgentSession, ThreadKey } from '../types';
import { keyToString } from '../types';
import { checkIsInstalled, installTool, checkIsOpenCodeServerRunning, ensureOpenCodeServer, getToolCommand, onOpenCodeServerExit } from '../installManager';
import { resolveDataDir } from '../state';
import { appendDiagLog } from '../diagLog';
import {
  checkIsEventForSession,
  updateSessionLineage,
} from '../openCodeSessionRouting';
import { t } from '../i18n';

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
   * Drives {@link getOpenCodeInterruptAction} — a busy session is aborted
   * before a new prompt so it starts fresh instead of queuing behind the turn.
   */
  isBusy: boolean;
  /**
   * Whether context compaction is in flight (between
   * `session.next.compaction.started` and `…ended` / `session.compacted`).
   * Compaction must never be aborted — the new prompt queues instead.
   */
  isCompacting: boolean;
  /**
   * Child (sub-agent) session ids currently busy, learned from routed
   * `session.status` events. A running sub-agent must never be aborted — the
   * new prompt queues. Cleared per-child when that child goes idle.
   */
  busyChildSessionIds: Set<string>;
  /**
   * Abort controller for the live SSE `fetch` + reader. Set by
   * `pollSse`, cleared on natural exit. `disconnectSse` / `stopSession`
   * call `.abort()` so the reader unblocks immediately instead of
   * waiting for the server to deliver the next byte (audit S7 / #12).
   */
  sseController: AbortController | null;
  /**
   * Handle for the SSE reconnect `setTimeout`. Cleared by `stopSession`
   * / `disconnectSse` so the callback doesn't re-enter `pollSse` for a
   * tornDown session (audit S8 / #14).
   */
  reconnectTimer: NodeJS.Timeout | null;
  /**
   * Handle for the SSE stall watchdog `setTimeout`. OpenCode emits a
   * `server.heartbeat` every ~10 s, so a live stream always delivers bytes
   * within that window; if none arrive for `sseStallTimeoutMs` the socket is
   * silently dead (open TCP, no FIN/RST) and `reader.read()` would park
   * forever. The watchdog aborts the controller so `pollSse` reconnects.
   */
  sseStallTimer: NodeJS.Timeout | null;
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
  return { type: event.type, properties };
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

export interface OpenCodeQuestionOption {
  label: string;
  description?: string;
}

export interface OpenCodeQuestion {
  question: string;
  header?: string;
  options: OpenCodeQuestionOption[];
  multiple?: boolean;
}

export interface OpenCodePendingQuestion {
  requestId: string;
  questions: OpenCodeQuestion[];
}

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
 * Shape of `properties.info` on a `session.updated` event — the only event
 * that exposes the child→parent session link used for subagent routing.
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

/** SSE event types whose loss makes a turn silently hang — diag-logged on drop. */
const criticalSseEventTypes = new Set<string>([
  'message.part.updated',
  'message.part.delta',
  'message.updated',
  'session.idle',
  'session.error',
]);

/** Poll cadence for the in-memory busy flag while waiting for an abort to land. */
const openCodeInterruptPollMs = 100;
/**
 * @description Upper bound on waiting for the aborted generation to go idle
 * before forwarding the new prompt anyway (never drops the message). The
 * busy→idle transition is driven by SSE (`session.status` / `session.idle`),
 * which arrives within a beat of the `abort` POST.
 */
const openCodeInterruptTimeoutMs = 3000;

/**
 * @description Live interrupt-relevant state of an OpenCode session, derived
 * from SSE events (not an HTTP poll — the stream catches sub-100 ms busy/idle
 * transitions an HTTP poll races past).
 */
export interface OpenCodeInterruptState {
  /** Own session is mid-generation (`session.status` = busy). */
  isBusy: boolean;
  /** Context compaction is in flight (must not be aborted — would lose the summary). */
  isCompacting: boolean;
  /** Number of child (sub-agent) sessions currently busy (must not be aborted — kills the child). */
  busyChildCount: number;
}

export type OpenCodeInterruptAction = 'abort' | 'queue-compacting' | 'queue-subagent' | 'skip-idle';

/**
 * @description Decide how to handle a new prompt for a (possibly busy) OpenCode
 * session. Compaction and a running sub-agent must NOT be aborted (abort would
 * lose the summary / kill the child) — the prompt queues behind the current
 * turn instead. A plain busy generation IS aborted so the prompt starts fresh.
 * An idle session needs no interrupt. Compaction is checked before sub-agent
 * before busy so the most-protective rule wins when several overlap. Pure +
 * exported for unit testing.
 */
export function getOpenCodeInterruptAction(state: OpenCodeInterruptState): OpenCodeInterruptAction {
  if (state.isCompacting) return 'queue-compacting';
  if (state.busyChildCount > 0) return 'queue-subagent';
  if (!state.isBusy) return 'skip-idle';
  return 'abort';
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
   * child sessionID → parent sessionID, learned from `session.updated` events.
   * OpenCode runs subagents (e.g. `@explore`) in child sessions whose SSE
   * events carry the child id; this map routes them back to the topic bound to
   * the parent. Bounded by `maxTrackedSessionLineageEntries`.
   */
  private sessionLineage: Map<string, string> = new Map();

  private baseUrl: string;
  private authHeader: string | null;

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

      // Audit S8 / #14: after a restart the new server doesn't know any
      // previous session ids, so every in-memory session is effectively
      // orphaned — SSE reconnects would succeed at the TCP layer but
      // never see traffic for these ids. Tear them down explicitly so
      // the bot's state store can clean up too (via `emit('closed')`,
      // wired through createAdapter.ts). Take a snapshot first.
      const snapshot = Array.from(this.sessions.entries());
      for (const [k, session] of snapshot) {
        if (!session.isActive) continue;
        this.emit('output', session.key, `OpenCode server restarted; previous session lost. Starting a fresh one with /opencode (or /stop to release).`);
        this.stopSessionInner(session.key);
        // `stopSessionInner` already emits `stopped`. Also emit `closed`
        // so downstream (bot.ts) wipes the persisted session id, not
        // just the in-memory state — otherwise the next bot restart
        // would try to resume an id the server doesn't recognise.
        this.emit('closed', session.key);
        // Defensive: stopSessionInner deletes from `this.sessions`, but
        // emit order matters for downstream cleanup races.
        this.sessions.delete(k);
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
    // Audit S7 / #12: every fetch now carries a timeout. Caller may also
    // pass an external `AbortSignal` (e.g. tied to session lifetime) —
    // we don't compose those into one signal because `AbortSignal.any` is
    // Node-22-only and we want to keep the dependency surface tight; the
    // 30 s timeout is a safety net regardless.
    const timeoutSignal = AbortSignal.timeout(apiRequestTimeoutMs);
    const requestInit: RequestInit = {
      method,
      headers: this.getHeaders(),
      signal: options?.signal ?? timeoutSignal,
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
        const apiSession = await this.apiRequest<OpenCodeApiSession>('POST', '/session', {
          title: args || `Telegram session ${k}`,
        });

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
          sseController: null,
          reconnectTimer: null,
          sseStallTimer: null,
        };

        this.sessions.set(k, session);
        this.connectSse(key);

        // Fetch default model info from OpenCode server and show to user
        await this.fetchModelInfo(key);

        // If args provided, send as first message
        if (args) {
          this.sendPromptAsync(key, args);
        }

        this.emit('started', key);
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
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }

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
   * @description Interrupt the running turn (HTTP `abort`) and resolve only
   * once the session is idle, so the caller can forward a fresh prompt without
   * it queuing behind the current generation — the OpenCode counterpart of the
   * Claude TUI's Escape-and-wait. OpenCode is not keystroke-driven, so there is
   * no Escape (single or double) — the interrupt is `POST /session/:id/abort`.
   *
   * Exceptions ({@link getOpenCodeInterruptAction}): while a sub-agent (child
   * session) is running or context is compacting, we do NOT abort — that would
   * kill the child / discard the summary — so we return without aborting and
   * the prompt queues behind the current turn. An idle session needs no abort.
   * Busy/compaction/sub-agent state is tracked live from the SSE stream.
   */
  async interruptAndWaitIdle(key: ThreadKey): Promise<void> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    const action = getOpenCodeInterruptAction({
      isBusy: session.isBusy,
      isCompacting: session.isCompacting,
      busyChildCount: session.busyChildSessionIds.size,
    });

    if (action === 'queue-compacting') {
      console.log(`[OpenCode] compaction in progress — queueing prompt, not aborting`);
      return;
    }
    if (action === 'queue-subagent') {
      console.log(`[OpenCode] sub-agent running — queueing prompt, not aborting`);
      return;
    }
    if (action === 'skip-idle') return;

    console.log(`[OpenCode] aborting current generation before new prompt`);
    await this.apiRequest('POST', `/session/${session.sessionId}/abort`).catch((e) => {
      console.warn(`[OpenCode] abort before prompt failed:`, e instanceof Error ? e.message : e);
    });

    const deadline = Date.now() + openCodeInterruptTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, openCodeInterruptPollMs));
      const current = this.sessions.get(keyToString(key));
      if (!current?.isActive) return;
      if (!current.isBusy) {
        console.log(`[OpenCode] abort landed — idle, forwarding prompt`);
        return;
      }
    }
    console.log(`[OpenCode] still busy after ${openCodeInterruptTimeoutMs}ms, forwarding anyway`);
  }

  /**
   * @description Set model override for the current session.
   * Accepts either "provider/modelId" format or partial name to search.
   * @returns Error message if model not found, null on success
   */
  async setModel(key: ThreadKey, modelId: string): Promise<string | null> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return 'No active session';

    const models = await fetchAvailableModels();
    const resolved = await resolveModelId(modelId, models);

    if (!resolved) {
      return `Model "${modelId}" not found. Use /model to see available models.`;
    }

    session.modelOverride = resolved;
    session.isModelInfoShown = false;
    const label = `${resolved.providerID}/${resolved.modelID}`;
    session.currentModelLabel = label;
    saveModelPref(key, label);
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

  /**
   * @description Get list of available models from OpenCode CLI.
   */
  async getAvailableModels(): Promise<string[]> {
    return fetchAvailableModels();
  }

  getCurrentModel(key: ThreadKey): string | null {
    const session = this.sessions.get(keyToString(key));
    if (!session) return null;
    return session.currentModelLabel;
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
   * @description Variant names the thread's CURRENT model exposes, or `[]`
   * when no model is set or the model declares no variants. Resolves the
   * provider/model id from the live override (preferred) or the label.
   */
  private async getModelVariants(session: OpenCodeSession): Promise<string[]> {
    const label = session.currentModelLabel;
    const providerID = session.modelOverride?.providerID
      ?? (label && label.includes('/') ? label.slice(0, label.indexOf('/')) : null);
    const modelID = session.modelOverride?.modelID
      ?? (label && label.includes('/') ? label.slice(label.indexOf('/') + 1) : null);
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
   * @description Effort levels the current thread can use: exactly the
   * variants the current model declares. Empty when no session is running
   * or the model has no variants.
   */
  async getAvailableEffortLevels(key: ThreadKey): Promise<string[]> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return [];
    return this.getModelVariants(session);
  }

  getEffort(key: ThreadKey): string | null {
    const session = this.sessions.get(keyToString(key));
    if (session) return session.effortLevel;
    return loadSavedEffort(key);
  }

  /**
   * @description Set the per-thread effort (variant). Validates against the
   * current model's available variants; persists on success (applied
   * per-prompt by `sendPromptAsync`, plan D3). Returns a user-facing notice
   * string on any non-success, `null` on success.
   */
  async setEffort(key: ThreadKey, level: string): Promise<string | null> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return 'No active session';

    const available = await this.getAvailableEffortLevels(key);
    if (available.length === 0) {
      return t('effort.not_supported', { model: session.currentModelLabel ?? '?' });
    }
    if (!available.includes(level)) {
      return t('effort.invalid_level', { level, valid: available.join(', ') });
    }

    session.effortLevel = level;
    saveEffortPref(key, level);
    console.log(`[OpenCode] Effort set to: ${level}`);
    return null;
  }

  getOpenCodeSessionId(key: ThreadKey): string | null {
    return this.sessions.get(keyToString(key))?.sessionId ?? null;
  }

  // `_workDir` is part of the shared `getSessions` contract but unused
  // here: OpenCode's `GET /session` returns a server-wide list with no
  // directory field to filter on, so the list is not folder-scoped.
  async getSessions(_key: ThreadKey, _workDir: string): Promise<AgentSession[]> {
    try {
      const apiSessions = await this.apiRequest<OpenCodeApiSession[]>('GET', '/session');

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

  async resumeSession(key: ThreadKey, workDir: string, sessionId: string): Promise<void> {
    // `workDir` is now an explicit argument from the bot, sourced from the
    // thread's binding in state.json. The old code defaulted to
    // `process.env.WORK_DIR || '/workspace'`, which silently mis-routed
    // resumes to the wrong folder as soon as the bot started managing
    // multiple bindings (plan §10.3, fix to old openCodeAdapter.ts:599).
    const k = keyToString(key);
    return this.withLifecycleLock(k, () => this.resumeSessionInner(key, workDir, sessionId));
  }

  private async resumeSessionInner(key: ThreadKey, workDir: string, sessionId: string): Promise<void> {
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
        sseController: null,
        reconnectTimer: null,
        sseStallTimer: null,
      };

      this.sessions.set(k, session);
      // Re-resolve the model on every resume so a session that took its model
      // from the server default (no saved /model pref) keeps a populated
      // modelOverride/currentModelLabel after a bot restart — otherwise /effort
      // can't resolve the model and reports "levels unavailable" (B17).
      // Silent (emitOutput=false): the label is unchanged from the previous run
      // and already shown in the topic, so re-emitting on each restart is noise.
      await this.fetchModelInfo(key, false);
      this.connectSse(key);
      this.emit('started', key);
    } catch (e) {
      console.error(`[OpenCode] Failed to resume session:`, e);
      throw e;
    }
  }

  /**
   * @description Connect to OpenCode SSE event stream.
   * OpenCode SSE uses only `data:` lines (no `event:` field).
   * Each data line contains JSON: { type: "event.name", properties: {...} }
   */
  private connectSse(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session) return;

    // OpenCode 1.14.48 closes `/event` after `server.connected`; the global
    // stream stays open and is safe because `handleSseData` filters session ids.
    const sseUrl = `${this.baseUrl}/global/event`;
    console.log(`[OpenCode] Connecting SSE: ${sseUrl}`);

    this.pollSse(key, sseUrl).catch((e) => {
      console.error(`[OpenCode] SSE connection error:`, e);
      // Audit S10 / #43: surface SSE start failures so the bot can
      // notify the user — previously they vanished into console logs
      // and the user saw a silently-dead session.
      this.emit('error', key, e instanceof Error ? e : new Error(String(e)));
    });
  }

  private disconnectSse(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session) return;
    session.isActive = false;
    // Audit S7 / #12: unblock the SSE reader immediately. Without this,
    // the in-flight `reader.read()` would only return when the server
    // happened to send the next byte — could be minutes for a silent
    // session.
    if (session.sseController) {
      session.sseController.abort();
      session.sseController = null;
    }
    // Audit S8 / #14: also kill any pending reconnect timer.
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
    // Also disarm the stall watchdog so it can't fire after teardown.
    this.clearSseStallTimer(session);
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
   * @description Fetch-based SSE reader. OpenCode sends all events as `data:` lines
   * with JSON payload { type, properties }. No `event:` field is used.
   *
   * On connection failure: checks if server is alive, attempts restart if dead,
   * retries forever with capped exponential backoff until reconnect succeeds.
   */
  private async pollSse(key: ThreadKey, sseUrl: string, reconnectAttempt = 0, reconnectStartTs = Date.now()): Promise<void> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
    };
    if (this.authHeader) {
      headers['Authorization'] = this.authHeader;
    }

    // Audit S7 / #12: SSE was previously read with no abort path —
    // `await reader.read()` blocks until bytes arrive, so a `stopSession`
    // during a silent server couldn't actually free the connection. The
    // session-scoped controller is stored so `disconnectSse` / `stopSession`
    // can abort the in-flight `fetch` and `reader.read` immediately.
    const controller = new AbortController();
    session.sseController = controller;

    let sawData = false;

    try {
      const response = await fetch(sseUrl, { headers, signal: controller.signal });

      if (!response.ok || !response.body) {
        console.error(`[OpenCode] SSE connection failed: ${response.status}`);
        await response.body?.cancel().catch(() => {});
        await this.handleSseReconnect(key, sseUrl, reconnectAttempt, reconnectStartTs, `HTTP ${response.status}`);
        return;
      }

      console.log(`[OpenCode] SSE connected successfully`);
      appendDiagLog(`sse connected key=${keyToString(key)} attempt=${reconnectAttempt}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Arm the stall watchdog before the first read and re-arm on every chunk;
      // a silently dead stream (no bytes, not even a heartbeat) would otherwise
      // park `reader.read()` forever with no reconnect.
      this.armSseStallWatchdog(session, key, controller);

      while (session.isActive) {
        const { done, value } = await reader.read();
        if (done) break;
        this.armSseStallWatchdog(session, key, controller);

        // Audit S7 / #12: a flapping server used to reset `reconnectAttempt`
        // on a *successful TCP connect*, so the 5-attempts ceiling never
        // bounded anything. Reset only once we observe actual application
        // data, and keep a wall-clock budget so even data-producing flaps
        // get capped.
        if (!sawData) {
          sawData = true;
          reconnectAttempt = 0;
          reconnectStartTs = Date.now();
          appendDiagLog(`sse first-data key=${keyToString(key)}`);
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const dataStr = line.slice(6);
          this.handleSseData(key, dataStr);
        }
      }

      // Leaving the read loop: disarm before any reconnect await so the
      // watchdog can't fire against this (now-finished) controller.
      this.clearSseStallTimer(session);
      reader.cancel().catch(() => {});

      // If session is still active but stream ended (server-side close), try to reconnect
      if (session.isActive) {
        console.log(`[OpenCode] SSE stream ended while session active, reconnecting...`);
        await this.handleSseReconnect(key, sseUrl, reconnectAttempt, reconnectStartTs, 'stream ended');
      }
    } catch (e) {
      this.clearSseStallTimer(session);
      // An aborted controller means either `stopSession`/`disconnectSse`
      // (session no longer active → just exit) or the stall watchdog firing
      // on a silently dead stream (session still active → reconnect).
      if (controller.signal.aborted) {
        if (session.isActive) {
          await this.handleSseReconnect(key, sseUrl, reconnectAttempt, reconnectStartTs, 'stall');
        }
        return;
      }
      if (session.isActive) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error(`[OpenCode] SSE error:`, errorMessage);
        await this.handleSseReconnect(key, sseUrl, reconnectAttempt, reconnectStartTs, errorMessage);
      }
    } finally {
      this.clearSseStallTimer(session);
      if (session.sseController === controller) session.sseController = null;
    }
  }

  /**
   * @description (Re)arm the SSE stall watchdog. OpenCode emits a
   * `server.heartbeat` every ~10 s, so a live stream always delivers bytes
   * within `sseStallTimeoutMs`; if none arrive the socket is silently dead
   * (open TCP, no FIN/RST) and `reader.read()` would park forever. Aborting
   * the controller unblocks the reader so `pollSse`'s catch path reconnects.
   * Re-armed on every chunk, so heartbeats keep a healthy stream alive.
   */
  private armSseStallWatchdog(session: OpenCodeSession, key: ThreadKey, controller: AbortController): void {
    this.clearSseStallTimer(session);
    session.sseStallTimer = setTimeout(() => {
      session.sseStallTimer = null;
      appendDiagLog(`sse stall key=${keyToString(key)} idle>${sseStallTimeoutMs}ms`);
      controller.abort();
    }, sseStallTimeoutMs);
  }

  /** Cancel the SSE stall watchdog if armed. Idempotent. */
  private clearSseStallTimer(session: OpenCodeSession): void {
    if (session.sseStallTimer) {
      clearTimeout(session.sseStallTimer);
      session.sseStallTimer = null;
    }
  }

  /**
   * @description Handle SSE reconnection with server health check, auto-restart, and exponential backoff.
   * If the server is dead, attempts to restart it before reconnecting SSE.
   * Never gives up while the session is active — reconnects until success —
   * with the backoff capped at `maxSseReconnectDelayMs`. The only exits are an
   * unrestartable server (handled by `restartServer`) or an inactive session.
   */
  private async handleSseReconnect(
    key: ThreadKey,
    sseUrl: string,
    attempt: number,
    reconnectStartTs: number,
    reason: string,
  ): Promise<void> {
    const k = keyToString(key);
    const session = this.sessions.get(k);
    if (!session?.isActive) return;

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
      // Server restarted — reset the attempt counter so backoff starts fresh.
      attempt = 0;
    }

    // Never give up while the session is active: reconnect forever until
    // success. Cap the exponential backoff so steady-state retries settle at
    // `maxSseReconnectDelayMs` instead of growing without bound.
    const delay = Math.min(
      sseReconnectBaseDelayMs * Math.pow(2, Math.min(attempt, maxSseReconnectBackoffExponent)),
      maxSseReconnectDelayMs,
    );
    console.log(`[OpenCode] SSE reconnecting in ${delay}ms (attempt ${attempt + 1}, reason: ${reason}, elapsed: ${Math.round(elapsed / 1000)}s)`);
    appendDiagLog(`sse reconnect attempt=${attempt + 1} reason=${reason} delay=${delay}ms`);

    // Store the timer handle on the session so `stopSession` / `disconnectSse`
    // can cancel it; otherwise a `setTimeout` fired after the session is
    // gone re-enters `pollSse` for a dead session and keeps the event
    // loop alive (audit S8 / #14).
    await new Promise<void>(resolve => {
      session.reconnectTimer = setTimeout(() => {
        session.reconnectTimer = null;
        resolve();
      }, delay);
    });

    if (session.isActive) {
      this.pollSse(key, sseUrl, attempt + 1, reconnectStartTs).catch(() => {});
    }
  }

  /**
   * @description Parse a single SSE data line. The JSON envelope is either
   * { type, properties } or `/global/event`'s { payload: { type, properties } }.
   *
   * The OpenCode server multiplexes events for ALL sessions on one `/event` stream,
   * so we filter by `sessionID` to dispatch only the ones belonging to this `key`.
   * Note: every `ThreadKey` opens its own SSE connection to the server, so this
   * filter is double-defence — even if the server ever changes its routing,
   * we never deliver a cross-thread event by accident.
   */
  private handleSseData(key: ThreadKey, dataStr: string): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      return;
    }

    const event = normaliseOpenCodeSseEvent(parsed);
    if (!event) return;

    const eventType = event.type;

    // OpenCode runs subagents in CHILD sessions; their events carry the child
    // sessionID, not the bound parent's. `session.updated` is the only event
    // exposing the child→parent link — capture it BEFORE the session-id gate
    // below (which would otherwise drop it as "without sessionID"), so
    // descendant events can be routed back to the owning topic.
    if (eventType === 'session.updated') {
      this.trackSessionLineage(event.properties);
    }

    // Filter events by session ID (SSE stream contains events for all sessions).
    // Audit S5 / #6: the previous filter `if (eventSessionId &&
    // eventSessionId !== session.sessionId) return` LET THROUGH events
    // whose `eventSessionId` was null. For `permission.asked` and
    // `question.asked`, whose payloads carry `requestID`/`id` but no
    // `sessionID`, this meant every active thread's SSE handler processed
    // the same global event — each POST'ing `reply: 'always'` and each
    // emitting `question` to its own user. We now require sessionID for
    // any event that mutates per-session state; events that are
    // genuinely server-wide (server.connected, server.heartbeat) are
    // session-less by design and handled separately.
    const eventSessionId = this.getSessionIdFromEvent(event);
    const sessionLessOk = eventType === 'server.connected' || eventType === 'server.heartbeat';
    if (!sessionLessOk) {
      if (!eventSessionId) {
        console.warn(`[OpenCode] dropping ${eventType} without sessionID`);
        return;
      }
      if (!checkIsEventForSession(eventSessionId, session.sessionId, this.sessionLineage)) {
        if (criticalSseEventTypes.has(eventType)) {
          appendDiagLog(`sse drop ${eventType} es=${eventSessionId} bound=${session.sessionId}`);
        }
        return;
      }
      if (eventSessionId !== session.sessionId) {
        appendDiagLog(`sse route-descendant ${eventType} es=${eventSessionId} -> ${session.sessionId}`);
      }
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
        this.handlePermissionAsked(key, event.properties);
        break;

      case 'question.asked':
        this.handleQuestionAsked(key, event.properties);
        break;

      case 'server.connected':
        console.log(`[OpenCode] SSE: server.connected`);
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
   * @description Record a child→parent session link from a `session.updated`
   * event so subagent (child-session) events can be routed to the topic bound
   * to the parent. Root sessions (no `parentID`) and non-session ids are
   * ignored; the map is bounded by `maxTrackedSessionLineageEntries`.
   */
  private trackSessionLineage(properties: Record<string, unknown>): void {
    const info = properties.info as OpenCodeSessionUpdatedInfo | undefined;
    const recorded = updateSessionLineage(
      this.sessionLineage,
      info?.id,
      info?.parentID,
      maxTrackedSessionLineageEntries,
    );
    if (recorded) {
      appendDiagLog(`sse lineage child=${info?.id} parent=${info?.parentID}`);
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
   * standalone message/chunk; `queueOutput` joins pending chunks with `\n`, so
   * successive tails reconstruct the full response exactly once. Without this,
   * the debounce timer and `flushOutput` both emitted the whole accumulated
   * text, duplicating the response in Telegram.
   */
  private emitResponseTail(key: ThreadKey, session: OpenCodeSession): void {
    const tail = session.currentResponseText.slice(session.lastEmittedLength);
    if (!tail.trim()) return;
    this.emit('output', key, tail);
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
    this.flushOutput(key);
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
  }

  private handlePermissionAsked(_key: ThreadKey, properties: Record<string, unknown>): void {
    console.log(`[OpenCode] Permission requested:`, JSON.stringify(properties));
    // Auto-approve all permissions (headless mode). Symmetry with the
    // claude adapter, which always passes `--dangerously-skip-permissions`
    // (plan D44, §10.2). Per-thread opt-out (S1) was deliberately rejected
    // — if it ever comes back, this is where it'd hook in.
    const requestId = (properties.requestID || properties.id) as string | undefined;
    if (requestId) {
      this.apiRequest('POST', `/permission/${requestId}/reply`, {
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
  private handleQuestionAsked(key: ThreadKey, properties: Record<string, unknown>): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    const requestId = (properties.requestID || properties.id) as string | undefined;
    const questions = properties.questions as OpenCodeQuestion[] | undefined;

    console.log(`[OpenCode] Question asked (${requestId}):`, JSON.stringify(properties).slice(0, 500));

    if (!requestId || !questions || questions.length === 0) {
      // No valid question — reply empty to unblock
      if (requestId) {
        this.apiRequest('POST', `/question/${requestId}/reply`, {
          answers: [['']],
        }).catch((e) => console.error(`[OpenCode] Failed to reply to question:`, e));
      }
      return;
    }

    // Store pending question so we can reply later when user answers
    session.pendingQuestion = { requestId, questions };

    // Emit question event for the bot to display to user
    this.emit('question', key, { requestId, questions });
  }

  /**
   * @description Reply to a pending question with user-selected answers.
   * Called by the bot when the user clicks an inline button or types a custom answer.
   */
  answerQuestion(key: ThreadKey, answers: string[][]): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive || !session.pendingQuestion) return;

    const { requestId } = session.pendingQuestion;
    session.pendingQuestion = null;

    // Audit S15 / #41: surface failures via `error` so the bot's
    // handleAgentError shows them in the thread, not just in console.
    this.apiRequest('POST', `/question/${requestId}/reply`, {
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

  private flushOutput(key: ThreadKey): void {
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

    this.emitResponseTail(key, session);

    session.currentResponseText = '';
    session.lastEmittedLength = 0;
    session.partTypes.clear();
  }
}
