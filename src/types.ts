import type { ChildProcess } from 'child_process';

/**
 * User configuration - maps Telegram user to workdir
 */
export interface UserConfig {
  userId: number;
  workDir: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Claude session state
 */
export interface ClaudeSessionState {
  userId: number;
  process: ChildProcess;
  outputBuffer: string;
  lastUpdate: number;
  updateTimer?: NodeJS.Timeout;
  isActive: boolean;
}
