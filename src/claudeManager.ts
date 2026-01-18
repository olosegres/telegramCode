import * as pty from 'node-pty';
import type { ClaudeSessionState } from './types';
import { EventEmitter } from 'events';

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function cleanOutput(text: string): string {
  let cleaned = stripAnsi(text);

  cleaned = cleaned.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '');
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

export class ClaudeManager extends EventEmitter {
  private sessions: Map<number, ClaudeSessionState> = new Map();

  private readonly updateInterval = 500;

  async startSession(userId: number, workDir: string): Promise<void> {
    await this.stopSession(userId);

    console.log(`[Claude] Starting session for user ${userId} in ${workDir}`);

    const ptyProcess = pty.spawn('claude', ['--dangerously-skip-permissions'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });

    console.log(`[Claude] PTY process spawned, PID: ${ptyProcess.pid}`);

    const sessionState: ClaudeSessionState = {
      userId,
      ptyProcess,
      outputBuffer: '',
      lastUpdate: 0,
      isActive: true,
    };

    this.sessions.set(userId, sessionState);

    ptyProcess.onData((data: string) => {
      console.log(`[Claude] data: ${data.slice(0, 100)}...`);
      this.handleOutput(userId, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[Claude] Process exited with code ${exitCode} for user ${userId}`);
      this.handleClose(userId);
    });

    this.emit('started', userId);
  }

  async stopSession(userId: number): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) return;

    session.isActive = false;

    if (session.updateTimer) {
      clearTimeout(session.updateTimer);
    }

    if (session.ptyProcess) {
      session.ptyProcess.write('\x03');
      await this.delay(100);
      session.ptyProcess.kill();
    }

    this.sessions.delete(userId);
    this.emit('stopped', userId);
  }

  checkIsActive(userId: number): boolean {
    const session = this.sessions.get(userId);
    return session !== undefined && session.isActive;
  }

  sendInput(userId: number, input: string): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) {
      console.log(`[Claude] sendInput: no active session for user ${userId}`);
      return;
    }

    console.log(`[Claude] sendInput: sending "${input}" to user ${userId}`);
    session.outputBuffer = '';
    session.ptyProcess.write(input + '\n');

    this.emit('input', userId, input);
  }

  sendSignal(userId: number, signal: string): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    if (signal === 'SIGINT') {
      session.ptyProcess.write('\x03');
    }
  }

  private handleOutput(userId: number, data: string): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    session.outputBuffer += data;
    session.lastUpdate = Date.now();

    if (session.updateTimer) {
      clearTimeout(session.updateTimer);
    }

    session.updateTimer = setTimeout(() => {
      this.flushOutput(userId);
    }, this.updateInterval);
  }

  private flushOutput(userId: number): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    const output = cleanOutput(session.outputBuffer);
    if (output) {
      this.emit('output', userId, output);
    }
  }

  getOutputBuffer(userId: number): string {
    const session = this.sessions.get(userId);
    return session ? cleanOutput(session.outputBuffer) : '';
  }

  clearBuffer(userId: number): void {
    const session = this.sessions.get(userId);
    if (session) {
      session.outputBuffer = '';
    }
  }

  private handleClose(userId: number): void {
    const session = this.sessions.get(userId);
    if (session) {
      session.isActive = false;
      if (session.updateTimer) {
        clearTimeout(session.updateTimer);
      }

      const output = cleanOutput(session.outputBuffer);
      if (output) {
        this.emit('output', userId, output);
      }
    }

    this.sessions.delete(userId);
    this.emit('closed', userId);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const claudeManager = new ClaudeManager();
