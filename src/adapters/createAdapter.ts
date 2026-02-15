import type { AgentAdapter } from '../types';
import { ClaudeCliAdapter } from './claudeCliAdapter';
import { OpenCodeAdapter } from './openCodeAdapter';

type AdapterFactory = () => AgentAdapter;

const adapterFactories: Record<string, AdapterFactory> = {
  claude: () => new ClaudeCliAdapter(),
  opencode: () => new OpenCodeAdapter(),
};

/** Singleton adapter instances — one per adapter name */
const adapterInstances = new Map<string, AgentAdapter>();

/** Which adapter each user is currently using */
const userAdapterNames = new Map<number, string>();

/** Event listener forwarder — wired up per adapter instance */
type OutputHandler = (userId: number, output: string) => void;
type UserIdHandler = (userId: number) => void;
type ErrorHandler = (userId: number, error: Error) => void;

let onOutput: OutputHandler | null = null;
let onClosed: UserIdHandler | null = null;
let onStarted: UserIdHandler | null = null;
let onStopped: UserIdHandler | null = null;
let onError: ErrorHandler | null = null;

function wireAdapterEvents(adapter: AgentAdapter): void {
  if (onOutput) adapter.on('output', onOutput);
  if (onClosed) adapter.on('closed', onClosed);
  if (onStarted) adapter.on('started', onStarted);
  if (onStopped) adapter.on('stopped', onStopped);
  // Always register error handler to prevent ERR_UNHANDLED_ERROR crash
  adapter.on('error', (userId: number, error: Error) => {
    if (onError) {
      onError(userId, error);
    } else {
      console.error(`[${adapter.name}] Unhandled adapter error for user ${userId}:`, error.message);
    }
  });
}

/**
 * @description Register global event handlers that will be wired to all adapter instances.
 * Call this once at bot startup before any adapters are created.
 */
export function registerAdapterEventHandlers(handlers: {
  onOutput: OutputHandler;
  onClosed: UserIdHandler;
  onStarted?: UserIdHandler;
  onStopped?: UserIdHandler;
  onError?: ErrorHandler;
}): void {
  onOutput = handlers.onOutput;
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

export function getUserAdapter(userId: number): AgentAdapter {
  const adapterName = userAdapterNames.get(userId) || getDefaultAdapterName();
  return getAdapter(adapterName);
}

export function getUserAdapterName(userId: number): string {
  return userAdapterNames.get(userId) || getDefaultAdapterName();
}

export function setUserAdapter(userId: number, adapterName: string): void {
  if (!adapterFactories[adapterName]) {
    throw new Error(`Unknown adapter: ${adapterName}`);
  }
  userAdapterNames.set(userId, adapterName);
}
