import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { AgentAdapter, AgentSession } from '../types';
import { checkIsInstalled, installTool, checkIsOpenCodeServerRunning, ensureOpenCodeServer, getToolCommand } from '../installManager';

const execAsync = promisify(exec);

interface OpenCodeModelOverride {
  providerID: string;
  modelID: string;
}

interface OpenCodeSession {
  userId: number;
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

interface OpenCodePart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
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

  private sessions: Map<number, OpenCodeSession> = new Map();
  private baseUrl: string;
  private authHeader: string | null;

  constructor() {
    super();
    this.baseUrl = (process.env.OPENCODE_URL || 'http://localhost:4096').replace(/\/$/, '');

    const password = process.env.OPENCODE_PASSWORD;
    if (password) {
      const username = process.env.OPENCODE_USERNAME || 'opencode';
      this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    } else {
      this.authHeader = null;
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

  private async apiRequest<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${urlPath}`;
    const options: RequestInit = {
      method,
      headers: this.getHeaders(),
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (e) {
      const cause = e instanceof TypeError && (e as NodeJS.ErrnoException).cause
        ? (e.cause as NodeJS.ErrnoException)
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
    return undefined as T;
  }

  async startSession(userId: number, workDir: string, args?: string): Promise<void> {
    this.stopSession(userId);

    if (!checkIsInstalled('opencode')) {
      this.emit('output', userId, 'Installing OpenCode...');
      await installTool('opencode');
    }

    if (!await checkIsOpenCodeServerRunning()) {
      this.emit('output', userId, 'Starting OpenCode server...');
      await ensureOpenCodeServer();
    }

    console.log(`[OpenCode] Starting session for user ${userId} in ${workDir}`);

    try {
      const apiSession = await this.apiRequest<OpenCodeApiSession>('POST', '/session', {
        title: args || `Telegram session ${userId}`,
      });

      const session: OpenCodeSession = {
        userId,
        sessionId: apiSession.id,
        workDir,
        isActive: true,
        currentResponseText: '',
        outputTimer: null,
        isModelInfoShown: false,
        modelOverride: null,
        currentModelLabel: null,
      };

      this.sessions.set(userId, session);
      this.connectSse(userId);

      // Fetch default model info from OpenCode server and show to user
      await this.fetchModelInfo(userId);

      // If args provided, send as first message
      if (args) {
        this.sendPromptAsync(userId, args);
      }

      this.emit('started', userId);
    } catch (e) {
      console.error(`[OpenCode] Failed to start session:`, e);
      throw e;
    }
  }

  stopSession(userId: number): void {
    const session = this.sessions.get(userId);
    if (!session) return;

    console.log(`[OpenCode] Stopping session for user ${userId}`);

    session.isActive = false;

    if (session.outputTimer) {
      clearTimeout(session.outputTimer);
    }

    this.disconnectSse(userId);

    // Abort any running generation
    this.apiRequest('POST', `/session/${session.sessionId}/abort`).catch(() => {});

    this.sessions.delete(userId);
    this.emit('stopped', userId);
  }

  checkIsActive(userId: number): boolean {
    const session = this.sessions.get(userId);
    return session?.isActive ?? false;
  }

  sendInput(userId: number, input: string): void {
    this.sendPromptAsync(userId, input);
  }

  /**
   * @description Send message via async endpoint (returns 204, response streams via SSE).
   * Fire-and-forget — errors are logged but don't block.
   */
  private sendPromptAsync(userId: number, input: string): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) {
      console.log(`[OpenCode] sendInput: no active session for user ${userId}`);
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
      this.emit('error', userId, e instanceof Error ? e : new Error(String(e)));
    });
  }

  sendSignal(userId: number, signal: string): void {
    if (signal === 'SIGINT') {
      const session = this.sessions.get(userId);
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
  async setModel(userId: number, modelId: string): Promise<string | null> {
    const session = this.sessions.get(userId);
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
    console.log(`[OpenCode] Model set to: ${label}`);
    return null;
  }

  /**
   * @description Get list of available models from OpenCode CLI.
   */
  async getAvailableModels(): Promise<string[]> {
    return fetchAvailableModels();
  }

  getCurrentModel(userId: number): string | null {
    const session = this.sessions.get(userId);
    if (!session) return null;
    return session.currentModelLabel;
  }

  async getSessions(): Promise<AgentSession[]> {
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

  async resumeSession(userId: number, sessionId: string): Promise<void> {
    this.stopSession(userId);

    if (!checkIsInstalled('opencode')) {
      this.emit('output', userId, 'Installing OpenCode...');
      await installTool('opencode');
    }

    if (!await checkIsOpenCodeServerRunning()) {
      this.emit('output', userId, 'Starting OpenCode server...');
      await ensureOpenCodeServer();
    }

    console.log(`[OpenCode] Resuming session ${sessionId} for user ${userId}`);

    try {
      // Verify session exists
      const apiSession = await this.apiRequest<OpenCodeApiSession>('GET', `/session/${sessionId}`);

      const session: OpenCodeSession = {
        userId,
        sessionId: apiSession.id,
        workDir: process.env.WORK_DIR || '/workspace',
        isActive: true,
        currentResponseText: '',
        outputTimer: null,
        isModelInfoShown: false,
        modelOverride: null,
        currentModelLabel: null,
      };

      this.sessions.set(userId, session);
      this.connectSse(userId);
      this.emit('started', userId);
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
  private connectSse(userId: number): void {
    const session = this.sessions.get(userId);
    if (!session) return;

    const sseUrl = `${this.baseUrl}/event`;
    console.log(`[OpenCode] Connecting SSE: ${sseUrl}`);

    this.pollSse(userId, sseUrl).catch((e) => {
      console.error(`[OpenCode] SSE connection error:`, e);
    });
  }

  private disconnectSse(userId: number): void {
    const session = this.sessions.get(userId);
    if (!session) return;
    session.isActive = false;
  }

  /**
   * @description Fetch default model from OpenCode server via GET /config.
   * The server returns `defaultModel: { providerID, modelID }` which is the resolved
   * model (from config.model -> model.json recent -> first available provider).
   * Sets modelOverride so that prompts are sent with the correct model.
   */
  private async fetchModelInfo(userId: number): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session?.isActive || session.isModelInfoShown) return;

    try {
      const config = await this.apiRequest<{
        model?: string;
        defaultModel?: { providerID: string; modelID: string };
      }>('GET', '/config');
      
      console.log(`[OpenCode] GET /config response: model=${config?.model || 'unset'}, defaultModel=${config?.defaultModel ? `${config.defaultModel.providerID}/${config.defaultModel.modelID}` : 'unset'}`);
      
      // defaultModel is the resolved model from OpenCode's priority chain
      if (config?.defaultModel?.providerID && config?.defaultModel?.modelID) {
        const label = `${config.defaultModel.providerID}/${config.defaultModel.modelID}`;
        session.currentModelLabel = label;
        session.modelOverride = {
          providerID: config.defaultModel.providerID,
          modelID: config.defaultModel.modelID,
        };
        session.isModelInfoShown = true;
        console.log(`[OpenCode] Default model: ${label}`);
        this.emit('output', userId, `Model: ${label}`);
        return;
      }
      
      // Fallback: config.model string (e.g. "provider/model")
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
        this.emit('output', userId, `Model: ${config.model}`);
        return;
      }
    } catch (e) {
      console.log(`[OpenCode] fetchModelInfo failed:`, e instanceof Error ? e.message : e);
    }
    
    // No model resolved
    console.log(`[OpenCode] No default model resolved`);
    session.currentModelLabel = 'not set';
    this.emit('output', userId, `Model: not set (use /model to select)`);
  }

  /**
   * @description Fetch-based SSE reader. OpenCode sends all events as `data:` lines
   * with JSON payload { type, properties }. No `event:` field is used.
   */
  private async pollSse(userId: number, sseUrl: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) return;

    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
    };
    if (this.authHeader) {
      headers['Authorization'] = this.authHeader;
    }

    try {
      const response = await fetch(sseUrl, { headers });

      if (!response.ok || !response.body) {
        console.error(`[OpenCode] SSE connection failed: ${response.status}`);
        return;
      }

      console.log(`[OpenCode] SSE connected successfully`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (session.isActive) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const dataStr = line.slice(6);
          this.handleSseData(userId, dataStr);
        }
      }

      reader.cancel().catch(() => {});
    } catch (e) {
      if (session.isActive) {
        console.error(`[OpenCode] SSE error:`, e);
        // Reconnect after delay
        setTimeout(() => {
          if (session.isActive) {
            console.log(`[OpenCode] SSE reconnecting...`);
            this.pollSse(userId, sseUrl).catch(() => {});
          }
        }, 3000);
      }
    }
  }

  /**
   * @description Parse a single SSE data line. The JSON envelope is { type, properties }.
   */
  private handleSseData(userId: number, dataStr: string): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    let event: OpenCodeSseEvent;
    try {
      event = JSON.parse(dataStr);
    } catch {
      return;
    }

    const eventType = event.type;
    if (!eventType) return;

    // Filter events by session ID (SSE stream contains events for all sessions)
    const eventSessionId = this.getSessionIdFromEvent(event);
    if (eventSessionId && eventSessionId !== session.sessionId) return;

    switch (eventType) {
      case 'message.part.updated':
        this.handlePartUpdate(userId, event.properties);
        break;

      case 'message.updated':
        this.handleMessageUpdate(userId, event.properties);
        break;

      case 'session.idle':
        this.handleSessionIdle(userId, event.properties);
        break;

      case 'session.error':
        this.handleSessionError(userId, event.properties);
        break;

      case 'permission.asked':
        this.handlePermissionAsked(userId, event.properties);
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
   * @description Handle streaming text delta from assistant response.
   * Event properties: { part: OpenCodePart, delta?: string }
   */
  private handlePartUpdate(userId: number, properties: Record<string, unknown>): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    const part = properties.part as OpenCodePart | undefined;
    const delta = properties.delta as string | undefined;

    // Only process text parts
    if (part?.type && part.type !== 'text') return;

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
        this.emit('output', userId, session.currentResponseText);
      }
    }, sseOutputBatchMs);
  }

  /**
   * @description Handle message completion.
   * Event properties: { info: OpenCodeMessageInfo }
   */
  private handleMessageUpdate(userId: number, properties: Record<string, unknown>): void {
    const session = this.sessions.get(userId);
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
        this.emit('output', userId, `Model: ${modelLabel}`);
      }
    }

    // When assistant message completes (has finish reason), flush output
    if (info.finish && info.role === 'assistant') {
      this.flushOutput(userId);
    }

    // Surface errors to the user
    if (info.error) {
      const errorMsg = this.extractErrorMessage(info.error);
      console.error(`[OpenCode] Message error:`, errorMsg);
      this.emit('output', userId, `Error: ${errorMsg}`);
    }
  }

  /**
   * @description Handle session becoming idle (AI done processing).
   * Flush any remaining accumulated output.
   */
  private handleSessionIdle(userId: number, properties: Record<string, unknown>): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    const sessionId = properties.sessionID as string | undefined;
    if (sessionId && sessionId !== session.sessionId) return;

    console.log(`[OpenCode] Session idle`);
    this.flushOutput(userId);
  }

  private handleSessionError(userId: number, properties: Record<string, unknown>): void {
    const errorMsg = this.extractErrorMessage(properties.error);
    console.error(`[OpenCode] Session error:`, errorMsg);
    this.emit('output', userId, `OpenCode error: ${errorMsg}`);
  }

  private handlePermissionAsked(userId: number, properties: Record<string, unknown>): void {
    console.log(`[OpenCode] Permission requested:`, JSON.stringify(properties));
    // Auto-approve all permissions (headless mode)
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

  private flushOutput(userId: number): void {
    const session = this.sessions.get(userId);
    if (!session) return;

    if (session.outputTimer) {
      clearTimeout(session.outputTimer);
      session.outputTimer = null;
    }

    if (session.currentResponseText.trim()) {
      this.emit('output', userId, session.currentResponseText);
    }

    session.currentResponseText = '';
  }
}
