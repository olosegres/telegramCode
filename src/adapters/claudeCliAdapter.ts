import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentAdapter, AgentSession } from '../types';
import { checkIsInstalled, installTool } from '../installManager';

interface ClaudeSession {
  userId: number;
  workDir: string;
  sessionName: string;
  pollTimer: NodeJS.Timeout | null;
  lastContent: string;
  isActive: boolean;
  handledAutoEnter: boolean;
  handledAutoAccept: boolean;
}

const pollInterval = 300;
const claudePath = process.env.HOME + '/.npm-global/bin/claude';
const sessionsFile = path.join(process.env.HOME || '/tmp', '.claude-sessions.json');

function tmux(...args: string[]): string {
  try {
    return execSync(`tmux ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

function convertAnsiToMarkdown(text: string): string {
  let result = text;

  // Replace bold sequences: \x1B[1m text \x1B[0m -> *text*
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B\[1m([^\x1B]*?)(?:\x1B\[(?:0|22)m|\x1B\[)/g, (_match, content) => {
    if (content.trim()) {
      return `*${content}*`;
    }
    return content;
  });

  // Handle remaining bold start without proper end
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B\[1m([^\x1B]+)$/gm, '*$1*');

  // Remove remaining ANSI escape codes
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

  // Clean up multiple consecutive asterisks
  result = result.replace(/\*\*+/g, '*');
  result = result.replace(/\*\s*\*/g, '');

  return result;
}

/**
 * Join URLs that were broken by terminal line wrapping.
 * Terminal breaks long URLs into multiple lines, which breaks them in Telegram.
 */
function joinBrokenUrls(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const urlMatch = line.match(/(https?:\/\/\S*)$/);

    if (urlMatch) {
      let fullUrl = urlMatch[1];
      const prefix = line.slice(0, line.length - fullUrl.length);

      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.includes(' ') && /^[\w\-._~:/?#\[\]@!$&'()*+,;=%]+$/.test(nextLine)) {
          fullUrl += nextLine;
          j++;
        } else {
          break;
        }
      }

      result.push(prefix + fullUrl);
      i = j;
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

function cleanOutput(text: string): string {
  let cleaned = convertAnsiToMarkdown(text);
  cleaned = cleaned.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '');
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  cleaned = joinBrokenUrls(cleaned);
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.split('\n').filter(line => line.trim() || line === '').join('\n');
  return cleaned.trim();
}

function normalizeToolCallLine(line: string): string {
  const trimmed = line.trim();
  const toolPattern = /^(Bash|Read|Write|Edit|Glob|Grep|Task|TodoWrite|WebFetch|WebSearch)\s*\(/i;
  const bulletToolPattern = /^([●○])\s*(Bash|Read|Write|Edit|Glob|Grep|Task|TodoWrite|WebFetch|WebSearch)\s*\(/i;

  const bulletMatch = trimmed.match(bulletToolPattern);
  if (bulletMatch) {
    const bullet = bulletMatch[1];
    const rest = trimmed.slice(bulletMatch[1].length).trimStart();
    const icon = bullet === '●' ? '⏳' : '✓';
    return `${icon} ${rest}`;
  }

  const toolMatch = trimmed.match(toolPattern);
  if (toolMatch) {
    return `✓ ${trimmed}`;
  }

  return line;
}

function stripTuiElements(text: string): string {
  const lines = text.split('\n');
  const filtered: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (/^[─━]+$/.test(line.trim())) continue;
    if (/⏵⏵\s*(bypass permissions|accept edits)\s*(on|off)/i.test(line)) continue;
    if (/^❯/.test(line)) continue;
    if (/\(shift\+tab to cycle\)/i.test(line)) continue;
    if (/^[\s·✽✢✶✻⏵❯─━↵]+$/.test(line)) continue;

    const trimmedLine = line.trim();
    const isToolCall = /^[●○]?\s*(Bash|Read|Write|Edit|Glob|Grep|Task|TodoWrite|WebFetch|WebSearch)\s*\(/i.test(trimmedLine);

    if (!isToolCall && /ctrl\+c.*to interrupt/i.test(line)) continue;
    if (/claude code has switched|native installer|Run.*install.*or see/i.test(line)) continue;
    if (/^install`?\s*(or see)?/i.test(trimmedLine)) continue;
    if (/docs\.anthropic\.com/i.test(line)) continue;
    if (/more options\.?\s*$/i.test(trimmedLine) && trimmedLine.length < 20) continue;

    if (/^[╭─╮│╰╯\s]+$/.test(trimmedLine)) continue;
    if (/^[▐▛▜▌▝▘█▀▄░▒▓\s]+$/.test(trimmedLine)) continue;
    if (/Recent activity|What's new|\/resume for more/i.test(line)) continue;
    if (/Welcome\s*back/i.test(line)) continue;
    if (/[╭─╮│╰╯]/.test(line) && trimmedLine.length > 50) continue;
    if (/^\s*│.*\d+[smh]\s+ago\s+/i.test(line)) continue;
    if (/^\s*│.*[─]+\s*│\s*$/.test(line)) continue;

    if (isToolCall) {
      line = normalizeToolCallLine(line);
    }

    filtered.push(line);
  }

  let result = filtered.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

function loadStoredSessions(): StoredSession[] {
  try {
    if (fs.existsSync(sessionsFile)) {
      return JSON.parse(fs.readFileSync(sessionsFile, 'utf-8')) as StoredSession[];
    }
  } catch {
    // ignore
  }
  return [];
}

function saveStoredSession(session: StoredSession): void {
  const sessions = loadStoredSessions();
  const existingIdx = sessions.findIndex(s => s.id === session.id);
  if (existingIdx >= 0) {
    sessions[existingIdx] = session;
  } else {
    sessions.unshift(session);
  }
  // Keep last 50 sessions
  const trimmed = sessions.slice(0, 50);
  try {
    fs.writeFileSync(sessionsFile, JSON.stringify(trimmed, null, 2));
  } catch {
    // ignore
  }
}

export class ClaudeCliAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'claude';
  readonly label = 'Claude Code';

  private sessions: Map<number, ClaudeSession> = new Map();

  async startSession(userId: number, workDir: string, args?: string): Promise<void> {
    this.stopSession(userId);

    if (!checkIsInstalled('claude')) {
      this.emit('output', userId, 'Installing Claude Code...');
      await installTool('claude');
    }

    const sessionName = `claude-${userId}`;
    console.log(`[Claude] Starting tmux session ${sessionName} in ${workDir}${args ? ` with args: ${args}` : ''}`);

    tmux('kill-session', '-t', sessionName);

    const createCmd = `tmux new-session -d -s ${sessionName} -x 300 -y 50`;
    const claudeArgs = args ? ` ${args}` : '';
    const startClaudeCmd = `tmux send-keys -t ${sessionName} "cd ${workDir} && ${claudePath} --dangerously-skip-permissions${claudeArgs}" Enter`;
    try {
      execSync(createCmd, { encoding: 'utf-8', timeout: 5000 });
      console.log(`[Claude] tmux session created`);
      execSync(startClaudeCmd, { encoding: 'utf-8', timeout: 5000 });
      console.log(`[Claude] claude command sent`);
    } catch (e) {
      console.error(`[Claude] Failed to create tmux session:`, e);
      this.emit('error', userId, new Error('Failed to start Claude session'));
      return;
    }

    const now = new Date().toISOString();
    saveStoredSession({
      id: sessionName,
      title: args || `Session ${sessionName}`,
      createdAt: now,
      updatedAt: now,
    });

    const session: ClaudeSession = {
      userId,
      workDir,
      sessionName,
      pollTimer: null,
      lastContent: '',
      isActive: true,
      handledAutoEnter: false,
      handledAutoAccept: false,
    };

    this.sessions.set(userId, session);
    session.pollTimer = setInterval(() => this.pollOutput(userId), pollInterval);
    this.emit('started', userId);
  }

  stopSession(userId: number): void {
    const session = this.sessions.get(userId);
    if (!session) return;

    console.log(`[Claude] Stopping session for user ${userId}`);

    session.isActive = false;
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
    }

    tmux('kill-session', '-t', session.sessionName);
    this.sessions.delete(userId);
    this.emit('stopped', userId);
  }

  checkIsActive(userId: number): boolean {
    const session = this.sessions.get(userId);
    if (!session) return false;

    const sessions = tmux('list-sessions', '-F', '#{session_name}');
    return sessions.includes(session.sessionName);
  }

  sendInput(userId: number, input: string): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) {
      console.log(`[Claude] sendInput: no active session for user ${userId}`);
      return;
    }

    console.log(`[Claude] sendInput: "${input}"`);

    try {
      execSync(
        `tmux send-keys -t ${session.sessionName} -l ${JSON.stringify(input)}`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      execSync(
        `tmux send-keys -t ${session.sessionName} Enter`,
        { encoding: 'utf-8', timeout: 5000 }
      );
    } catch (e) {
      console.error(`[Claude] sendInput error:`, e);
    }
  }

  sendSignal(userId: number, signal: string): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    if (signal === 'SIGINT') {
      tmux('send-keys', '-t', session.sessionName, 'C-c');
      console.log(`[Claude] sent Ctrl+C`);
    }
  }

  sendEnter(userId: number): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    console.log(`[Claude] sendEnter`);
    tmux('send-keys', '-t', session.sessionName, 'Enter');
  }

  sendArrow(userId: number, direction: 'Up' | 'Down'): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    console.log(`[Claude] sendArrow: ${direction}`);
    tmux('send-keys', '-t', session.sessionName, direction);
  }

  sendTab(userId: number): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    console.log(`[Claude] sendTab`);
    tmux('send-keys', '-t', session.sessionName, 'Tab');
  }

  /**
   * @description For Claude CLI, model switching is done via the /model slash command.
   * Sends "/model <modelId>" as input to the tmux session.
   */
  setModel(userId: number, modelId: string): void {
    this.sendInput(userId, `/model ${modelId}`);
  }

  getCurrentModel(_userId: number): string | null {
    return null;
  }

  getFullOutput(userId: number, lines: number = 500): string | null {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return null;

    const raw = tmux('capture-pane', '-t', session.sessionName, '-p', '-S', `-${lines}`);
    if (!raw) return null;

    return cleanOutput(raw);
  }

  async getSessions(): Promise<AgentSession[]> {
    const stored = loadStoredSessions();
    return stored.map(s => ({
      id: s.id,
      title: s.title,
      createdAt: new Date(s.createdAt),
      updatedAt: new Date(s.updatedAt),
    }));
  }

  async resumeSession(userId: number, _sessionId: string): Promise<void> {
    // For Claude CLI, --resume resumes the last conversation in the workDir
    // sessionId is not directly used since Claude CLI resume is workDir-based
    const session = this.sessions.get(userId);
    const workDir = session?.workDir || process.env.WORK_DIR || '/workspace';

    this.stopSession(userId);

    if (!checkIsInstalled('claude')) {
      this.emit('output', userId, 'Installing Claude Code...');
      await installTool('claude');
    }

    const sessionName = `claude-${userId}`;
    console.log(`[Claude] Resuming session in ${workDir}`);

    tmux('kill-session', '-t', sessionName);

    const createCmd = `tmux new-session -d -s ${sessionName} -x 300 -y 50`;
    const startClaudeCmd = `tmux send-keys -t ${sessionName} "cd ${workDir} && ${claudePath} --dangerously-skip-permissions --resume" Enter`;

    try {
      execSync(createCmd, { encoding: 'utf-8', timeout: 5000 });
      execSync(startClaudeCmd, { encoding: 'utf-8', timeout: 5000 });
    } catch (e) {
      console.error(`[Claude] Failed to resume session:`, e);
      this.emit('error', userId, new Error('Failed to resume Claude session'));
      return;
    }

    const claudeSession: ClaudeSession = {
      userId,
      workDir,
      sessionName,
      pollTimer: null,
      lastContent: '',
      isActive: true,
      handledAutoEnter: false,
      handledAutoAccept: false,
    };

    this.sessions.set(userId, claudeSession);
    claudeSession.pollTimer = setInterval(() => this.pollOutput(userId), pollInterval);
    this.emit('started', userId);
  }

  private pollOutput(userId: number): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    const raw = tmux('capture-pane', '-t', session.sessionName, '-p', '-e', '-S', '-200');

    if (!raw) {
      if (!this.checkIsActive(userId)) {
        console.log(`[Claude] Session died, cleaning up`);
        this.stopSession(userId);
        this.emit('closed', userId);
      }
      return;
    }

    const content = cleanOutput(raw);

    if (content !== session.lastContent) {
      const newPart = this.getNewContent(session.lastContent, content);
      session.lastContent = content;

      if (newPart) {
        console.log(`[Claude] RAW output (${newPart.length}):\n---\n${newPart}\n---`);

        const cleanedOutput = stripTuiElements(newPart);
        if (cleanedOutput) {
          console.log(`[Claude] FILTERED output (${cleanedOutput.length}):\n---\n${cleanedOutput}\n---`);
          this.emit('output', userId, cleanedOutput);
        } else {
          console.log(`[Claude] Output filtered out completely`);
        }
      }

      if (newPart.length > 50) {
        session.handledAutoEnter = false;
        session.handledAutoAccept = false;
      }

      if (!session.handledAutoEnter && this.checkNeedsAutoEnter(content)) {
        session.handledAutoEnter = true;
        console.log(`[Claude] Auto-pressing Enter`);
        setTimeout(() => {
          tmux('send-keys', '-t', session.sessionName, 'Enter');
        }, 300);
      }

      if (!session.handledAutoAccept && this.checkNeedsAutoAccept(content)) {
        session.handledAutoAccept = true;
        console.log(`[Claude] Auto-accepting bypass permissions`);
        setTimeout(() => {
          tmux('send-keys', '-t', session.sessionName, 'Down');
          setTimeout(() => {
            tmux('send-keys', '-t', session.sessionName, 'Enter');
          }, 100);
        }, 300);
      }
    }
  }

  private checkNeedsAutoEnter(content: string): boolean {
    const autoEnterPatterns = [
      /Press Enter to continue/i,
      /Login successful\. Press Enter/i,
    ];
    return autoEnterPatterns.some(pattern => pattern.test(content));
  }

  private checkNeedsAutoAccept(content: string): boolean {
    const hasWarning = /WARNING.*Bypass/i.test(content) || /Bypass.*Permissions/i.test(content);
    const hasAccept = /Yes,?\s*I\s*accept/i.test(content);
    if (hasWarning || hasAccept) {
      console.log(`[Claude] checkNeedsAutoAccept: warning=${hasWarning}, accept=${hasAccept}`);
    }
    return hasWarning && hasAccept;
  }

  private normalizeForComparison(line: string): string {
    return line.trim().replace(/^[●○⏳✓]\s*/, '');
  }

  private getNewContent(oldContent: string, newContent: string): string {
    if (!oldContent) return newContent;
    if (oldContent === newContent) return '';

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const oldLinesSet = new Map<string, number>();
    for (const line of oldLines) {
      const normalized = this.normalizeForComparison(line);
      if (normalized) {
        oldLinesSet.set(normalized, (oldLinesSet.get(normalized) || 0) + 1);
      }
    }

    const newParts: string[] = [];
    const usedOldLines = new Map<string, number>();

    for (const line of newLines) {
      const normalized = this.normalizeForComparison(line);
      if (!normalized) continue;

      const oldCount = oldLinesSet.get(normalized) || 0;
      const usedCount = usedOldLines.get(normalized) || 0;

      if (usedCount < oldCount) {
        usedOldLines.set(normalized, usedCount + 1);
      } else {
        newParts.push(line);
      }
    }

    return newParts.join('\n').trim();
  }
}
