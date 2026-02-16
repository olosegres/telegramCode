import { EventEmitter } from 'events';

export interface AgentSession {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @description Unified interface for AI agent backends (Claude CLI, OpenCode, etc.).
 * Each adapter manages sessions per user and communicates via EventEmitter.
 *
 * Events emitted:
 * - 'output'  (userId: number, text: string)   — permanent text response
 * - 'status'  (userId: number, text: string)   — transient status (tool calls, thinking); shown as editable message
 * - 'closed'  (userId: number)
 * - 'started' (userId: number)
 * - 'stopped' (userId: number)
 * - 'error'   (userId: number, error: Error)
 */
export interface AgentAdapter extends EventEmitter {
  /** Unique adapter identifier, e.g. 'claude', 'opencode' */
  readonly name: string;
  /** Human-readable label for Telegram UI */
  readonly label: string;

  // — Lifecycle —

  startSession(userId: number, workDir: string, args?: string): Promise<void>;
  stopSession(userId: number): void;
  checkIsActive(userId: number): boolean;

  // — Input —

  sendInput(userId: number, input: string): void;
  sendSignal(userId: number, signal: string): void;

  // — Session history —

  getSessions(userId: number): Promise<AgentSession[]>;
  resumeSession(userId: number, sessionId: string): Promise<void>;

  // — Model selection —

  /** Set model override. Returns error message on failure, null on success */
  setModel?(userId: number, modelId: string): string | null | void | Promise<string | null>;
  getCurrentModel?(userId: number): string | null;
  /** Get available models from backend */
  getAvailableModels?(): Promise<string[]>;

  // — Optional TUI controls (Claude CLI specific) —

  sendEnter?(userId: number): void;
  sendArrow?(userId: number, direction: 'Up' | 'Down'): void;
  sendTab?(userId: number): void;
  getFullOutput?(userId: number, lines?: number): string | null;
}
