import type { AgentAdapter, ThreadKey } from '../types';
import { keyToString } from '../types';
import { ClaudeCliAdapter } from './claudeCliAdapter';
import { OpenCodeAdapter } from './openCodeAdapter';
import type { OpenCodePendingQuestion } from './openCodeAdapter';

type AdapterFactory = () => AgentAdapter;

const adapterFactories: Record<string, AdapterFactory> = {
  claude: () => new ClaudeCliAdapter(),
  opencode: () => new OpenCodeAdapter(),
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
type OutputHandler = (key: ThreadKey, output: string) => void;
type StatusHandler = (key: ThreadKey, status: string) => void;
type QuestionHandler = (key: ThreadKey, question: OpenCodePendingQuestion) => void;
type ThreadKeyHandler = (key: ThreadKey) => void;
type ErrorHandler = (key: ThreadKey, error: Error) => void;

let onOutput: OutputHandler | null = null;
let onStatus: StatusHandler | null = null;
let onQuestion: QuestionHandler | null = null;
let onClosed: ThreadKeyHandler | null = null;
let onStarted: ThreadKeyHandler | null = null;
let onStopped: ThreadKeyHandler | null = null;
let onError: ErrorHandler | null = null;

function wireAdapterEvents(adapter: AgentAdapter): void {
  if (onOutput) adapter.on('output', onOutput);
  if (onStatus) adapter.on('status', onStatus);
  if (onQuestion) adapter.on('question', onQuestion);
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
  onClosed: ThreadKeyHandler;
  onStarted?: ThreadKeyHandler;
  onStopped?: ThreadKeyHandler;
  onError?: ErrorHandler;
}): void {
  onOutput = handlers.onOutput;
  onStatus = handlers.onStatus ?? null;
  onQuestion = handlers.onQuestion ?? null;
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

/** Record that a given thread is now using a specific adapter. */
export function setThreadAdapter(key: ThreadKey, adapterName: string): void {
  if (!adapterFactories[adapterName]) {
    throw new Error(`Unknown adapter: ${adapterName}`);
  }
  threadAdapterNames.set(keyToString(key), adapterName);
}
