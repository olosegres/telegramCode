import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentAdapter, AgentSession, ThreadKey } from '../types';
import { keyToString } from '../types';
import { checkIsInstalled, installTool, checkIsOpenCodeServerRunning, ensureOpenCodeServer, getToolCommand, onOpenCodeServerExit } from '../installManager';
import { resolveDataDir } from '../state';

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
  } catch {
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
    console.log(`[OpenCode] Failed to save model pref:`, e instanceof Error ? e.message : e);
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
   * Abort controller for the live SSE `fetch` + reader. Set by
   * `pollSse`, cleared on natural exit. `disconnectSse` / `stopSession`
   * call `.abort()` so the reader unblocks immediately instead of
   * waiting for the server to deliver the next byte (audit S7 / #12).
   */
  sseController: AbortController | null;
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

/** Delay (ms) to batch SSE text deltas before emitting output event */
const sseOutputBatchMs = 500;

/** Max number of SSE reconnection attempts before giving up */
const maxSseReconnectAttempts = 5;

/** Base delay (ms) for exponential backoff on SSE reconnect */
const sseReconnectBaseDelayMs = 2000;

/**
 * @description Default timeout for non-SSE HTTP requests to OpenCode.
 * 30 s comfortably covers `prompt_async` (returns 204 immediately) and
 * `getSessions` / `getModels` (file scans on the server side). The SSE
 * stream uses its own long-lived connection without this timeout.
 */
const apiRequestTimeoutMs = 30_000;

/**
 * @description Wall-clock cap on SSE reconnect attempts for one session.
 * Audit S7 / #12: a flapping OpenCode server reset `attempt = 0` after
 * each successful connect, so the legacy 5-attempts ceiling never
 * actually bounded retry time. Cap total reconnect lifetime to 10 min
 * before giving up regardless of per-attempt counter.
 */
const sseReconnectTotalBudgetMs = 10 * 60 * 1000;

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
  private baseUrl: string;
  private authHeader: string | null;

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

      // Notify all active session threads about recovery
      for (const session of this.sessions.values()) {
        if (session.isActive) {
          this.emit('output', session.key, `OpenCode server restarted. Session may need to be restarted (/stop then /opencode).`);
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

  async startSession(key: ThreadKey, workDir: string, args?: string, _sessionId?: string): Promise<void> {
    // OpenCode's session id is server-assigned via POST /session, so an
    // externally-supplied sessionId is not honoured here. The bot keeps the
    // mapping `ThreadKey → opencodeSessionId` in state.json (plan §13.19) so
    // resumes after a restart go through `resumeSession()`, not startSession.
    this.stopSession(key);

    const k = keyToString(key);

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
        outputTimer: null,
        isModelInfoShown: false,
        modelOverride: null,
        currentModelLabel: null,
        partTypes: new Map(),
        statusDebounceTimer: null,
        pendingStatus: null,
        pendingQuestion: null,
        sseController: null,
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
  }

  stopSession(key: ThreadKey): void {
    const k = keyToString(key);
    const session = this.sessions.get(k);
    if (!session) return;

    console.log(`[OpenCode] Stopping session for ${k}`);

    session.isActive = false;

    if (session.outputTimer) {
      clearTimeout(session.outputTimer);
    }

    this.disconnectSse(key);

    // Abort any running generation
    this.apiRequest('POST', `/session/${session.sessionId}/abort`).catch(() => {});

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
   */
  private sendPromptAsync(key: ThreadKey, input: string): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) {
      console.log(`[OpenCode] sendInput: no active session for ${keyToString(key)}`);
      return;
    }

    console.log(`[OpenCode] sendPromptAsync: "${input}"`);

    // Reset accumulated response text for new message
    session.currentResponseText = '';

    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: input }],
    };
    if (session.modelOverride) {
      const modelParam: Record<string, string> = { modelID: session.modelOverride.modelID };
      if (session.modelOverride.providerID) {
        modelParam.providerID = session.modelOverride.providerID;
      }
      body.model = modelParam;
    }

    this.apiRequest('POST', `/session/${session.sessionId}/prompt_async`, body).catch((e) => {
      console.error(`[OpenCode] Failed to send message:`, e);
      this.emit('error', key, e instanceof Error ? e : new Error(String(e)));
    });
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

  getOpenCodeSessionId(key: ThreadKey): string | null {
    return this.sessions.get(keyToString(key))?.sessionId ?? null;
  }

  async getSessions(_key: ThreadKey): Promise<AgentSession[]> {
    try {
      const apiSessions = await this.apiRequest<OpenCodeApiSession[]>('GET', '/session');

      if (!Array.isArray(apiSessions)) return [];

      return apiSessions.map(s => ({
        id: s.id,
        title: s.title || s.id,
        createdAt: s.time?.created ? new Date(s.time.created * 1000) : new Date(),
        updatedAt: s.time?.updated ? new Date(s.time.updated * 1000) : new Date(),
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
    this.stopSession(key);

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
        outputTimer: null,
        isModelInfoShown: false,
        modelOverride: null,
        currentModelLabel: null,
        partTypes: new Map(),
        statusDebounceTimer: null,
        pendingStatus: null,
        pendingQuestion: null,
        sseController: null,
      };

      this.sessions.set(k, session);
      this.restoreSavedModel(key, session, false);
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
  }

  /**
   * @description Resolve model for the session. Priority:
   * 1. Thread's saved preference (from previous /model selection)
   * 2. OpenCode server's defaultModel (config.model -> model.json recent -> first provider)
   * 3. "not set"
   */
  private async fetchModelInfo(key: ThreadKey): Promise<void> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive || session.isModelInfoShown) return;

    // 1. Check this thread's saved model preference
    if (this.restoreSavedModel(key, session, true)) return;

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
        this.emit('output', key, `Model: ${label}`);
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
        this.emit('output', key, `Model: ${config.model}`);
        return;
      }
    } catch (e) {
      console.log(`[OpenCode] fetchModelInfo failed:`, e instanceof Error ? e.message : e);
    }

    // 3. No model resolved
    console.log(`[OpenCode] No default model resolved`);
    session.currentModelLabel = 'not set';
    this.emit('output', key, `Model: not set (use /model to select)`);
  }

  /**
   * @description Fetch-based SSE reader. OpenCode sends all events as `data:` lines
   * with JSON payload { type, properties }. No `event:` field is used.
   *
   * On connection failure: checks if server is alive, attempts restart if dead,
   * retries with exponential backoff up to maxSseReconnectAttempts.
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

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (session.isActive) {
        const { done, value } = await reader.read();
        if (done) break;

        // Audit S7 / #12: a flapping server used to reset `reconnectAttempt`
        // on a *successful TCP connect*, so the 5-attempts ceiling never
        // bounded anything. Reset only once we observe actual application
        // data, and keep a wall-clock budget so even data-producing flaps
        // get capped.
        if (!sawData) {
          sawData = true;
          reconnectAttempt = 0;
          reconnectStartTs = Date.now();
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

      reader.cancel().catch(() => {});

      // If session is still active but stream ended (server-side close), try to reconnect
      if (session.isActive) {
        console.log(`[OpenCode] SSE stream ended while session active, reconnecting...`);
        await this.handleSseReconnect(key, sseUrl, reconnectAttempt, reconnectStartTs, 'stream ended');
      }
    } catch (e) {
      // Aborted fetches are not errors — they're how `stopSession` exits.
      if (controller.signal.aborted) return;
      if (session.isActive) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error(`[OpenCode] SSE error:`, errorMessage);
        await this.handleSseReconnect(key, sseUrl, reconnectAttempt, reconnectStartTs, errorMessage);
      }
    } finally {
      if (session.sseController === controller) session.sseController = null;
    }
  }

  /**
   * @description Handle SSE reconnection with server health check, auto-restart, and exponential backoff.
   * If the server is dead, attempts to restart it before reconnecting SSE.
   * Gives up after `maxSseReconnectAttempts` consecutive failures OR
   * `sseReconnectTotalBudgetMs` of wall-clock retry time — whichever hits
   * first (audit S7 / #12).
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
    const overAttemptCap = attempt >= maxSseReconnectAttempts;
    const overTimeBudget = elapsed >= sseReconnectTotalBudgetMs;
    if (overAttemptCap || overTimeBudget) {
      const reasonHint = overTimeBudget
        ? `after ${Math.round(elapsed / 1000)}s of retries`
        : `after ${attempt} attempts`;
      console.error(`[OpenCode] SSE reconnect giving up ${reasonHint}`);
      this.emit('output', key, `Lost connection to OpenCode server ${reasonHint}. Use /stop and start a new session.`);
      session.isActive = false;
      this.sessions.delete(k);
      this.emit('stopped', key);
      return;
    }

    // Check if the server process is still alive
    const isServerAlive = await checkIsOpenCodeServerRunning();

    if (!isServerAlive) {
      console.log(`[OpenCode] Server is not responding, attempting restart before SSE reconnect...`);
      const restarted = await this.restartServer();
      if (!restarted) {
        // restartServer already notified threads and cleaned up sessions
        return;
      }
      // Server restarted — keep the wall-clock budget but allow another
      // round of per-attempt retries (in case the freshly-started server
      // refuses the first connect on its boot path).
      attempt = 0;
    }

    // Exponential backoff: 2s, 4s, 8s, 16s, 32s
    const delay = sseReconnectBaseDelayMs * Math.pow(2, attempt);
    console.log(`[OpenCode] SSE reconnecting in ${delay}ms (attempt ${attempt + 1}/${maxSseReconnectAttempts}, reason: ${reason}, elapsed: ${Math.round(elapsed / 1000)}s)`);

    await new Promise(resolve => setTimeout(resolve, delay));

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
      if (eventSessionId !== session.sessionId) return;
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
      if (session.currentResponseText.trim()) {
        this.emit('output', key, session.currentResponseText);
      }
    }, sseOutputBatchMs);
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
    if (sessionId && sessionId !== session.sessionId) return;

    console.log(`[OpenCode] Session idle`);
    this.flushOutput(key);
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

    this.apiRequest('POST', `/question/${requestId}/reply`, {
      answers,
    }).catch((e) => {
      console.error(`[OpenCode] Failed to reply to question:`, e);
      this.emit('output', key, `Failed to send answer: ${e instanceof Error ? e.message : e}`);
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

    if (session.currentResponseText.trim()) {
      this.emit('output', key, session.currentResponseText);
    }

    session.currentResponseText = '';
    session.partTypes.clear();
  }
}
