import type { IPty } from 'node-pty';

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
  ptyProcess: IPty;
  outputBuffer: string;
  lastUpdate: number;
  updateTimer?: NodeJS.Timeout;
  isActive: boolean;
}
