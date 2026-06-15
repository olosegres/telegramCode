import type { AgentAdapter, AgentApiErrorClass, ClaudeSurveyEvent, DisplayPrefsReader, OutputEventMeta, SubagentStatusEvent, ThinkingEvent, ToolResultEvent, ThreadKey } from '../types';
import { keyToString } from '../types';
import { ClaudeCliAdapter } from './claudeCliAdapter';
import { OpenCodeAdapter } from './openCodeAdapter';
import type { OpenCodePendingQuestion } from './openCodeAdapter';
import { TerminalAdapter } from './terminalAdapter';

type AdapterFactory = () => AgentAdapter;

const adapterFactories: Record<string, AdapterFactory> = {
  claude: () => new ClaudeCliAdapter(),
  opencode: () => new OpenCodeAdapter(),
  terminal: () => new TerminalAdapter(),
};

/** Singleton adapter instances — one per adapter name */
const adapterInstances = new Map<string, AgentAdapter>();

/**
 * Which adapter each thread is currently using. Keyed by serialised `ThreadKey`
 * (`"<chatId>:<threadId>"`) so the choice is per-thread, not per-user
 * (plan §10.4). One physical Telegram user may drive multiple threads on
 * different agents simultaneously.
 */
const threadAdapterNames = new Map<string, string>();

/** Event listener forwarder — wired up per adapter instance. */
type OutputHandler = (key: ThreadKey, output: string, meta?: OutputEventMeta) => void;
type StatusHandler = (key: ThreadKey, status: string) => void;
type QuestionHandler = (key: ThreadKey, question: OpenCodePendingQuestion) => void;
type SurveyHandler = (key: ThreadKey, survey: ClaudeSurveyEvent) => void;
type ThinkingHandler = (key: ThreadKey, payload: ThinkingEvent) => void;
type ToolResultHandler = (key: ThreadKey, payload: ToolResultEvent) => void;
type SubagentStatusHandler = (key: ThreadKey, payload: SubagentStatusEvent) => void;
type ApiErrorHandler = (key: ThreadKey, error: AgentApiErrorClass) => void;
type ThreadKeyHandler = (key: ThreadKey) => void;
type ErrorHandler = (key: ThreadKey, error: Error) => void;

let onOutput: OutputHandler | null = null;
let onStatus: StatusHandler | null = null;
let onQuestion: QuestionHandler | null = null;
let onSurvey: SurveyHandler | null = null;
let onThinking: ThinkingHandler | null = null;
let onToolResult: ToolResultHandler | null = null;
let onSubagentStatus: SubagentStatusHandler | null = null;
let onApiError: ApiErrorHandler | null = null;
let onClosed: ThreadKeyHandler | null = null;
let onStarted: ThreadKeyHandler | null = null;
let onStopped: ThreadKeyHandler | null = null;
let onError: ErrorHandler | null = null;

/** Per-thread display-prefs reader for BOTH adapters — same late-wiring idiom
 * as the event handlers above: registered once at bot boot, applied to each
 * instance whether it exists already or is created later. */
let displayPrefsReader: DisplayPrefsReader | null = null;

/**
 * @description Register the per-thread display-prefs reader both adapters
 * consult while PRODUCING output (the prefs that cannot be resolved at the
 * bot's render time): OpenCode branches a child-session part on its SSE hot
 * path (compact = status, full = separate streamed accumulator) and Claude's
 * relay classifies each scraped chunk and routes tool / panel / sub-agent
 * segments per the `toolResults` and `subagent` prefs (S4). Until registered,
 * both adapters fall back to all-fields-`minimal`.
 */
export function registerDisplayPrefsReader(reader: DisplayPrefsReader): void {
  displayPrefsReader = reader;
  const existingOpenCode = adapterInstances.get('opencode');
  if (existingOpenCode instanceof OpenCodeAdapter) existingOpenCode.setDisplayPrefsReader(reader);
  const existingClaude = adapterInstances.get('claude');
  if (existingClaude instanceof ClaudeCliAdapter) existingClaude.setDisplayPrefsReader(reader);
}

function wireAdapterEvents(adapter: AgentAdapter): void {
  if (onOutput) adapter.on('output', onOutput);
  if (onStatus) adapter.on('status', onStatus);
  if (onQuestion) adapter.on('question', onQuestion);
  if (onSurvey) adapter.on('survey', onSurvey);
  if (onThinking) adapter.on('thinking', onThinking);
  if (onToolResult) adapter.on('toolResult', onToolResult);
  if (onSubagentStatus) adapter.on('subagentStatus', onSubagentStatus);
  if (onApiError) adapter.on('apiError', onApiError);
  if (onClosed) adapter.on('closed', onClosed);
  if (onStarted) adapter.on('started', onStarted);
  if (onStopped) adapter.on('stopped', onStopped);
  // Always register error handler to prevent ERR_UNHANDLED_ERROR crash.
  adapter.on('error', (key: ThreadKey, error: Error) => {
    if (onError) {
      onError(key, error);
    } else {
      console.error(`[${adapter.name}] Unhandled adapter error for ${keyToString(key)}:`, error.message);
    }
  });
}

/**
 * @description Register global event handlers that will be wired to all adapter instances.
 * Call this once at bot startup before any adapters are created.
 */
export function registerAdapterEventHandlers(handlers: {
  onOutput: OutputHandler;
  onStatus?: StatusHandler;
  onQuestion?: QuestionHandler;
  onSurvey?: SurveyHandler;
  onThinking?: ThinkingHandler;
  onToolResult?: ToolResultHandler;
  onSubagentStatus?: SubagentStatusHandler;
  onApiError?: ApiErrorHandler;
  onClosed: ThreadKeyHandler;
  onStarted?: ThreadKeyHandler;
  onStopped?: ThreadKeyHandler;
  onError?: ErrorHandler;
}): void {
  onOutput = handlers.onOutput;
  onStatus = handlers.onStatus ?? null;
  onQuestion = handlers.onQuestion ?? null;
  onSurvey = handlers.onSurvey ?? null;
  onThinking = handlers.onThinking ?? null;
  onToolResult = handlers.onToolResult ?? null;
  onSubagentStatus = handlers.onSubagentStatus ?? null;
  onApiError = handlers.onApiError ?? null;
  onClosed = handlers.onClosed;
  onStarted = handlers.onStarted ?? null;
  onStopped = handlers.onStopped ?? null;
  onError = handlers.onError ?? null;

  // Wire to already-created instances
  for (const adapter of adapterInstances.values()) {
    wireAdapterEvents(adapter);
  }
}

export function getAdapter(name: string): AgentAdapter {
  let adapter = adapterInstances.get(name);
  if (!adapter) {
    const factory = adapterFactories[name];
    if (!factory) {
      throw new Error(`Unknown adapter: ${name}. Available: ${Object.keys(adapterFactories).join(', ')}`);
    }
    adapter = factory();
    adapterInstances.set(name, adapter);
    wireAdapterEvents(adapter);
    if (displayPrefsReader && (adapter instanceof OpenCodeAdapter || adapter instanceof ClaudeCliAdapter)) {
      adapter.setDisplayPrefsReader(displayPrefsReader);
    }
  }
  return adapter;
}

export function getAvailableAdapters(): Array<{ name: string; label: string }> {
  return Object.keys(adapterFactories).map(name => {
    // Get label from factory by creating a temp instance only if not already created
    const adapter = adapterInstances.get(name);
    if (adapter) {
      return { name, label: adapter.label };
    }
    // Use known labels to avoid creating unnecessary instances
    const labels: Record<string, string> = {
      claude: 'Claude Code',
      opencode: 'OpenCode',
      terminal: 'Terminal',
    };
    return { name, label: labels[name] || name };
  });
}

export function getDefaultAdapterName(): string {
  const env = process.env.DEFAULT_AGENT;
  if (env && adapterFactories[env]) return env;
  return 'claude';
}

/**
 * @description Resolve the adapter instance currently bound to `key`.
 *
 * Replaces the old `getUserAdapter(userId)` — see plan §10.4. The bot picks
 * an adapter per-thread (e.g. one thread runs Claude, the next OpenCode in
 * the same folder). If no choice has been made for this thread, falls back
 * to `DEFAULT_AGENT`.
 */
export function getThreadAdapter(key: ThreadKey): AgentAdapter {
  const adapterName = threadAdapterNames.get(keyToString(key)) || getDefaultAdapterName();
  return getAdapter(adapterName);
}

/** Returns the adapter NAME for a thread (without instantiating it). */
export function getThreadAdapterName(key: ThreadKey): string {
  return threadAdapterNames.get(keyToString(key)) || getDefaultAdapterName();
}

/**
 * @description The thread's EXPLICIT in-memory adapter pick, or `undefined`
 * when none was made this run. Unlike {@link getThreadAdapterName} this does
 * NOT fold in the `DEFAULT_AGENT` fallback, so a caller building a longer
 * resolution chain (e.g. in-memory → persisted → snapshot → default) can tell
 * "no pick yet" apart from "picked the default".
 */
export function getThreadAdapterNameRaw(key: ThreadKey): string | undefined {
  return threadAdapterNames.get(keyToString(key));
}

/** Record that a given thread is now using a specific adapter. */
export function setThreadAdapter(key: ThreadKey, adapterName: string): void {
  if (!adapterFactories[adapterName]) {
    throw new Error(`Unknown adapter: ${adapterName}`);
  }
  threadAdapterNames.set(keyToString(key), adapterName);
}

/**
 * @description Names of every adapter the bot knows how to drive. Single
 * source of truth used by sweep helpers below — these need to enumerate
 * adapters without instantiating them just to read a label, so the list
 * is derived directly from `adapterFactories`.
 */
export function getKnownAdapterNames(): string[] {
  return Object.keys(adapterFactories);
}

/**
 * @description Minimal interface a sweep helper needs from an adapter.
 * Extracted so unit tests can pass fakes without instantiating real
 * Claude/OpenCode adapters (those hit `which claude`, spawn opencode
 * servers, etc.).
 */
export interface AdapterSweepTarget {
  readonly name: string;
  readonly label: string;
  checkIsActive(key: ThreadKey): boolean;
  stopSession(key: ThreadKey): void;
}

/**
 * @description Result of {@link stopAllAdaptersFor}. `stopped` are the
 * labels whose `stopSession` returned without throwing; `attempted` is
 * the count of adapters that were `checkIsActive === true` before the
 * sweep. `attempted > stopped.length` means at least one stop call
 * threw, which the bot uses to distinguish "fully stopped" from
 * "stopped some, others failed" in the user-facing reply.
 */
export interface StopAllAdaptersResult {
  stopped: string[];
  attempted: number;
}

/**
 * @description Stop **every** adapter that has a live session for `key`,
 * regardless of which adapter the in-memory thread map currently points at.
 *
 * Why this is its own helper: adapter switching used to leak the previous
 * adapter's session — e.g. `/claude` then `/opencode` left the claude
 * tmux session alive while the thread map said opencode. `/stop` and
 * `/quit` would then silently no-op the surviving session because they
 * only stopped the adapter the map pointed at. Routing every stop call
 * through this sweep makes the user's intent ("stop the thing in this
 * topic") immune to that drift.
 *
 * `resolveAdapter` is taken as a parameter so tests can pass fakes; the
 * production caller passes `getAdapter` from this module. Adapter names
 * that fail to resolve (renamed/removed) are skipped silently — they
 * can't have an active session if they don't exist.
 */
export function stopAllAdaptersFor(
  key: ThreadKey,
  resolveAdapter: (name: string) => AdapterSweepTarget,
  adapterNames: string[] = getKnownAdapterNames(),
): StopAllAdaptersResult {
  const stopped: string[] = [];
  let attempted = 0;
  for (const name of adapterNames) {
    let adapter: AdapterSweepTarget;
    try { adapter = resolveAdapter(name); } catch { continue; }
    if (!adapter.checkIsActive(key)) continue;
    attempted += 1;
    try {
      adapter.stopSession(key);
      stopped.push(adapter.label);
    } catch (e) {
      console.error(`[stopAllAdaptersFor] ${name} stopSession failed for ${keyToString(key)}:`, e);
    }
  }
  return { stopped, attempted };
}
