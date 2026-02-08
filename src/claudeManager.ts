import { execSync } from 'child_process';
import { EventEmitter } from 'events';

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

function tmux(...args: string[]): string {
  try {
    return execSync(`tmux ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch (e) {
    return '';
  }
}

function convertAnsiToMarkdown(text: string): string {
  let result = text;

  // Track style state
  const isBold = false;
  const isItalic = false;

  // Process ANSI codes and convert to markdown
  // Bold: \x1B[1m ... \x1B[0m or \x1B[22m
  // We'll do a simple approach: find bold sequences and wrap in *

  // Replace bold sequences: \x1B[1m text \x1B[0m -> *text*
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B\[1m([^\x1B]*?)(?:\x1B\[(?:0|22)m|\x1B\[)/g, (match, content, offset) => {
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

function cleanOutput(text: string): string {
  // Convert ANSI styles to markdown before stripping
  let cleaned = convertAnsiToMarkdown(text);
  // Remove control characters except newline
  cleaned = cleaned.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // Normalize newlines
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Remove excessive newlines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  // Remove lines that are just spaces
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
    // ● = running, replace with ⏳
    // ○ = done, replace with ✓
    const icon = bullet === '●' ? '⏳' : '✓';
    return `${icon} ${rest}`;
  }

  const toolMatch = trimmed.match(toolPattern);
  if (toolMatch) {
    // No bullet = done, add ✓
    return `✓ ${trimmed}`;
  }

  return line;
}

function stripTuiElements(text: string): string {
  const lines = text.split('\n');
  const filtered: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Skip horizontal border lines (made of ─ or ━ characters)
    if (/^[─━]+$/.test(line.trim())) {
      continue;
    }

    // Skip status line with mode indicators
    if (/⏵⏵\s*(bypass permissions|accept edits)\s*(on|off)/i.test(line)) {
      continue;
    }

    // Skip all input prompt lines with cursor (❯)
    // These are: empty prompt, suggestions, or echoed user input
    if (/^❯/.test(line)) {
      continue;
    }

    // Skip shift+tab hint lines
    if (/\(shift\+tab to cycle\)/i.test(line)) {
      continue;
    }

    // Skip lines with only special Unicode symbols (spinners, etc)
    if (/^[\s·✽✢✶✻⏵❯─━↵]+$/.test(line)) {
      continue;
    }

    // Skip spinner/thinking/thought lines - lines starting with spinner symbol containing thinking/thought status
    // Examples: "· Discombobulating… (thinking)", "✽ Crunching… (thought for 2s)", 
    // "✢ Crunching… (30s · ↓ 377 tokens · thought for 2s)"
    const trimmedLine = line.trim();
    if (/^[·✽✢✶✻●○*]\s*.+\((thinking|thought\s)/i.test(trimmedLine)) {
      continue;
    }

    // Check if it's a tool call line
    const isToolCall = /^[●○]?\s*(Bash|Read|Write|Edit|Glob|Grep|Task|TodoWrite|WebFetch|WebSearch)\s*\(/i.test(trimmedLine);

    // Skip "ctrl+c to interrupt" hint lines (but not if it's part of a tool call)
    if (!isToolCall && /ctrl\+c.*to interrupt/i.test(line)) {
      continue;
    }

    // Skip installer/update notices
    if (/claude code has switched|native installer|Run.*install.*or see/i.test(line)) {
      continue;
    }
    if (/docs\.anthropic\.com/i.test(line)) {
      continue;
    }
    if (/more options\.?\s*$/i.test(trimmedLine) && trimmedLine.length < 20) {
      continue;
    }

    // Skip Claude Code welcome screen and ASCII art
    // Box borders: ╭─╮│╰─╯
    if (/^[╭─╮│╰╯\s]+$/.test(trimmedLine)) {
      continue;
    }
    if (/^[▐▛▜▌▝▘█▀▄░▒▓\s]+$/.test(trimmedLine)) {
      continue;
    }
    // Welcome screen elements
    if (/Claude Code.*v\d+\.\d+/i.test(line)) {
      continue;
    }
    if (/Recent activity|What's new|\/resume for more/i.test(line)) {
      continue;
    }
    if (/Welcome\s*back/i.test(line)) {
      continue;
    }
    if (/Opus|Sonnet|Claude Max/i.test(line)) {
      continue;
    }
    // Lines that are mostly box drawing characters with some text
    if (/[╭─╮│╰╯]/.test(line) && trimmedLine.length > 50) {
      continue;
    }
    // Recent activity entries (timestamp + message)
    if (/^\s*│.*\d+[smh]\s+ago\s+/i.test(line)) {
      continue;
    }
    if (/^\s*│.*[─]+\s*│\s*$/.test(line)) {
      continue;
    }

    // Normalize tool call lines for consistent animation
    if (isToolCall) {
      line = normalizeToolCallLine(line);
    }

    filtered.push(line);
  }

  // Remove excessive newlines after filtering
  let result = filtered.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

export class ClaudeManager extends EventEmitter {
  private sessions: Map<number, ClaudeSession> = new Map();

  startSession(userId: number, workDir: string, args?: string): void {
    this.stopSession(userId);

    const sessionName = `claude-${userId}`;
    console.log(`[Claude] Starting tmux session ${sessionName} in ${workDir}${args ? ` with args: ${args}` : ''}`);

    // Kill any existing session with this name
    tmux('kill-session', '-t', sessionName);

    // Create new detached tmux session with bash, then send claude command
    const createCmd = `tmux new-session -d -s ${sessionName} -x 120 -y 30`;
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

    // Start polling for output
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

    // Kill tmux session
    tmux('kill-session', '-t', session.sessionName);

    this.sessions.delete(userId);
    this.emit('stopped', userId);
  }

  checkIsActive(userId: number): boolean {
    const session = this.sessions.get(userId);
    if (!session) return false;

    // Check if tmux session still exists
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

    // Use tmux send-keys with literal flag for special characters
    try {
      execSync(
        `tmux send-keys -t ${session.sessionName} -l ${JSON.stringify(input)}`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      // Send Enter separately
      execSync(
        `tmux send-keys -t ${session.sessionName} Enter`,
        { encoding: 'utf-8', timeout: 5000 }
      );
    } catch (e) {
      console.error(`[Claude] sendInput error:`, e);
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

  getFullOutput(userId: number, lines: number = 500): string | null {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return null;

    const raw = tmux('capture-pane', '-t', session.sessionName, '-p', '-S', `-${lines}`);
    if (!raw) return null;

    return cleanOutput(raw);
  }

  sendSignal(userId: number, signal: string): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    if (signal === 'SIGINT') {
      tmux('send-keys', '-t', session.sessionName, 'C-c');
      console.log(`[Claude] sent Ctrl+C`);
    }
  }

  private pollOutput(userId: number): void {
    const session = this.sessions.get(userId);
    if (!session?.isActive) return;

    // Capture current pane content
    // -e flag preserves ANSI escape sequences (for bold, colors, etc.)
    // -S -200 captures last 200 lines to include tool call headers even with long output
    const raw = tmux('capture-pane', '-t', session.sessionName, '-p', '-e', '-S', '-200');

    if (!raw) {
      // Session might have died
      if (!this.checkIsActive(userId)) {
        console.log(`[Claude] Session died, cleaning up`);
        this.stopSession(userId);
        this.emit('closed', userId);
      }
      return;
    }

    const content = cleanOutput(raw);

    // Check if content changed
    if (content !== session.lastContent) {
      const newPart = this.getNewContent(session.lastContent, content);
      session.lastContent = content;

      if (newPart) {
        // Debug: show raw output before filtering
        console.log(`[Claude] RAW output (${newPart.length}):\n---\n${newPart}\n---`);

        const cleanedOutput = stripTuiElements(newPart);
        if (cleanedOutput) {
          console.log(`[Claude] FILTERED output (${cleanedOutput.length}):\n---\n${cleanedOutput}\n---`);
          this.emit('output', userId, cleanedOutput);
        } else {
          console.log(`[Claude] Output filtered out completely`);
        }
      }

      // Reset flags when content changes significantly
      if (newPart.length > 50) {
        session.handledAutoEnter = false;
        session.handledAutoAccept = false;
      }

      // Auto-press Enter for "Press Enter to continue" prompts
      if (!session.handledAutoEnter && this.checkNeedsAutoEnter(content)) {
        session.handledAutoEnter = true;
        console.log(`[Claude] Auto-pressing Enter`);
        setTimeout(() => {
          tmux('send-keys', '-t', session.sessionName, 'Enter');
        }, 300);
      }

      // Auto-accept bypass permissions warning
      if (!session.handledAutoAccept && this.checkNeedsAutoAccept(content)) {
        session.handledAutoAccept = true;
        console.log(`[Claude] Auto-accepting bypass permissions`);
        setTimeout(() => {
          // Navigate to "Yes, I accept" and press Enter
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
    // Remove tool status symbols for comparison (● ○ ⏳ ✓)
    return line.trim().replace(/^[●○⏳✓]\s*/, '');
  }

  private getNewContent(oldContent: string, newContent: string): string {
    if (!oldContent) return newContent;
    if (oldContent === newContent) return '';

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Build a set of old lines for quick lookup (normalized, with count for duplicates)
    const oldLinesSet = new Map<string, number>();
    for (const line of oldLines) {
      const normalized = this.normalizeForComparison(line);
      if (normalized) {
        oldLinesSet.set(normalized, (oldLinesSet.get(normalized) || 0) + 1);
      }
    }

    // Find lines in new content that weren't in old content
    const newParts: string[] = [];
    const usedOldLines = new Map<string, number>();

    for (const line of newLines) {
      const normalized = this.normalizeForComparison(line);
      if (!normalized) continue;

      const oldCount = oldLinesSet.get(normalized) || 0;
      const usedCount = usedOldLines.get(normalized) || 0;

      if (usedCount < oldCount) {
        // This line existed in old content, mark as used
        usedOldLines.set(normalized, usedCount + 1);
      } else {
        // This is a new line
        newParts.push(line);
      }
    }

    return newParts.join('\n').trim();
  }
}

export const claudeManager = new ClaudeManager();
