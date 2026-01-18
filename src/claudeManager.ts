import { spawn } from 'child_process';
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

    const claudeProcess = spawn('claude', ['--dangerously-skip-permissions'], {
      cwd: workDir,
      env: { ...process.env },
      shell: true,
    });

    const sessionState: ClaudeSessionState = {
      userId,
      process: claudeProcess,
      outputBuffer: '',
      lastUpdate: 0,
      isActive: true,
    };

    this.sessions.set(userId, sessionState);

    claudeProcess.stdout?.on('data', (data: Buffer) => {
      this.handleOutput(userId, data.toString());
    });

    claudeProcess.stderr?.on('data', (data: Buffer) => {
      this.handleOutput(userId, data.toString());
    });

    claudeProcess.on('close', (code) => {
      console.log(`[Claude] Process exited with code ${code} for user ${userId}`);
      this.handleClose(userId);
    });

    claudeProcess.on('error', (err) => {
      console.error(`[Claude] Process error for user ${userId}:`, err);
      this.emit('error', userId, err);
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

    if (session.process) {
      session.process.stdin?.write('\x03');
      await this.delay(100);
      session.process.kill('SIGTERM');
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
    if (!session?.isActive) return;

    session.outputBuffer = '';
    session.process.stdin?.write(input + '\n');

    this.emit('input', userId, input);
  }

  sendSignal(userId: number, signal: string): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    if (signal === 'SIGINT') {
      session.process.stdin?.write('\x03');
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
