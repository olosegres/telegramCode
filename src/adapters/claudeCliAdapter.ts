import { execFileSync, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentAdapter, AgentSession, ThreadKey } from '../types';
import { keyToString } from '../types';
import { checkIsInstalled, installTool } from '../installManager';
import { prepareMcpFlags, cleanupMcpTempFiles } from '../mcpConfig';
import { resolveDataDir } from '../state';

/**
 * @description Per-thread Claude CLI session state.
 *
 * One tmux session is spawned per `ThreadKey`. The tmux session name embeds
 * both `chatId` and `threadId` so multiple threads sharing the same `workDir`
 * stay fully isolated (plan §10.2, D8).
 */
interface ClaudeSession {
  key: ThreadKey;
  workDir: string;
  sessionName: string;
  /** UUID we pass via `--session-id` (or, on resume, via `--resume`). */
  claudeSessionId: string;
  pollTimer: NodeJS.Timeout | null;
  lastContent: string;
  isActive: boolean;
  handledAutoEnter: boolean;
  handledAutoAccept: boolean;
  /** Normalized text of last emitted status (for deduplication of spinner updates) */
  lastStatusText: string;
}

const pollInterval = 300;

/** Locate Claude where this process can actually execute it. */
function resolveClaudeBinary(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const which = execFileSync('which', ['claude'], {
      encoding: 'utf8',
      timeout: 1500,
    }).trim();
    if (which) return which;
  } catch {
    // PATH lookup failed; fall through.
  }
  return path.join(process.env.HOME || '/tmp', '.npm-global', 'bin', 'claude');
}

const claudePath = resolveClaudeBinary();
const sessionsFile = path.join(process.env.HOME || '/tmp', '.claude-sessions.json');

/**
 * @description Tmux session name for a `ThreadKey`.
 *
 * Format: `claude-<chatId>-<threadId>`. Negative chat ids (forum supergroups
 * are negative) keep their minus sign — tmux session names accept it. The
 * format is `parse`-able back to `ThreadKey` via {@link parseTmuxSessionName}.
 */
function buildTmuxSessionName(key: ThreadKey): string {
  return `claude-${key.chatId}-${key.threadId}`;
}

/**
 * @description Inverse of {@link buildTmuxSessionName}. Returns `null` for
 * names that don't match our format (e.g. unrelated tmux sessions a user
 * started by hand).
 *
 * Carefully handles negative chat ids: `claude--1001234-42` is `chatId=-1001234, threadId=42`.
 */
function parseTmuxSessionName(name: string): ThreadKey | null {
  // The numeric pair after "claude-" is "<chatId>-<threadId>".
  // chatId may be negative (forum supergroup). We split from the right on the
  // last '-' so the trailing token is always threadId regardless of sign.
  if (!name.startsWith('claude-')) return null;
  const rest = name.slice('claude-'.length);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash <= 0) return null;
  const chatIdStr = rest.slice(0, lastDash);
  const threadIdStr = rest.slice(lastDash + 1);
  const chatId = Number(chatIdStr);
  const threadId = Number(threadIdStr);
  if (!Number.isFinite(chatId) || !Number.isFinite(threadId)) return null;
  return { chatId, threadId };
}

function tmux(...args: string[]): string {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * @description Convert ANSI escape codes to Telegram Markdown.
 * Uses a marker-based approach: bold-on → \x01, bold-off → \x02,
 * then strips all remaining ANSI, then converts markers to *bold*.
 * Previous regex approach had two bugs:
 * 1) Bold regex consumed \x1B[ of the following sequence, leaking codes like 38;5;231m
 * 2) Cleanup regex \*\s*\* merged adjacent bold sections, removing newlines between them
 */
function convertAnsiToMarkdown(text: string): string {
  let result = text;

  // Step 1: Mark bold boundaries with control characters
  // Bold on: \x1B[1m → \x01 marker
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B\[1m/g, '\x01');

  // Bold off / reset: \x1B[0m or \x1B[22m → \x02 marker
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B\[(?:0|22)m/g, '\x02');

  // Step 2: Remove ALL remaining ANSI escape codes (colors, cursor, etc.)
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

  // Step 3: Convert bold markers to Markdown *bold*
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x01([^\x01\x02]*)\x02/g, (_match, content) => {
    const trimmed = content.trim();
    return trimmed ? `*${trimmed}*` : content;
  });

  // Handle unclosed bold (bold start without matching end, e.g. at end of line)
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x01([^\x01\x02]+)$/gm, '*$1*');

  // Step 4: Clean up remaining markers
  // eslint-disable-next-line no-control-regex
  result = result.replace(/[\x01\x02]/g, '');

  // Separate adjacent bold sections: *text1**text2* → *text1* *text2*
  result = result.replace(/\*\*/g, '* *');

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

/**
 * @description Check if output consists only of transient status lines (spinners, progress).
 * Uses generic heuristics instead of hardcoded spinner chars/words,
 * because Claude CLI can change its TUI symbols and wording at any time.
 *
 * Key insight: real Claude content is substantial (> 200 chars, multi-sentence).
 * Status/progress is short, has few lines, and contains indicators like … or time/token stats.
 */
function checkIsStatusOutput(text: string): boolean {
  // Real content is always substantial
  if (text.length > 200) return false;

  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return false;
  // Many non-empty lines = real content
  if (lines.length > 3) return false;

  return lines.every(line => {
    const trimmed = line.trim();
    // Tree structure / subagent progress lines (├─, └─, │, ─)
    if (/^[├└│─]/.test(trimmed)) return true;
    // Contains unicode ellipsis — universal spinner/progress indicator ("Nesting…", "Reading…", "Simmering…")
    if (/…/.test(trimmed)) return true;
    // Contains progress stats: time patterns (3m 36s), token counts (↓ 12.2k tokens), thought duration
    if (/\d+[smh]\b.*[·↓]|↓\s*[\d.]+k?\s*tokens|thought for \d/i.test(trimmed)) return true;
    // Very short line without sentence-like structure (two 3+ letter words) — likely a lone spinner/icon
    if (trimmed.length < 40 && !/[а-яёa-z]{3,}\s+[а-яёa-z]{3,}/i.test(trimmed)) return true;
    return false;
  });
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
    // Interactive question UI: tab bar navigation (← ☐ ... →)
    if (/^←.*→\s*$/.test(trimmedLine)) continue;
    // Interactive question UI: selection/navigation hints
    if (/Enter to select/i.test(line)) continue;
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

/**
 * @description Shell-quote a path for safe inclusion in a tmux `send-keys "..."` command.
 *
 * The tmux command line concatenates: `tmux send-keys -t <name> "cd <dir> && claude ..."`.
 * The dir is interpreted by the user's shell after tmux delivers the keystrokes, so we
 * single-quote it. Embedded single quotes are escaped via the standard
 * `'\''` close-reopen idiom. This is the path Claude will `cd` into, so paths with
 * spaces or special chars (e.g. `~/my projects/foo`) must survive untouched.
 */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class ClaudeCliAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'claude';
  readonly label = 'Claude Code';
  readonly outputsDeltas = true;

  /**
   * Map of serialised `ThreadKey` (`"<chatId>:<threadId>"`) → live session.
   * Keyed by string rather than `ThreadKey` object so map lookups work — JS
   * Map compares object identity, not structural equality.
   */
  private sessions: Map<string, ClaudeSession> = new Map();

  async startSession(
    key: ThreadKey,
    workDir: string,
    args?: string,
    sessionId?: string,
  ): Promise<void> {
    this.stopSession(key);

    if (!checkIsInstalled('claude')) {
      this.emit('output', key, 'Installing Claude Code...');
      await installTool('claude');
    }

    const sessionName = buildTmuxSessionName(key);
    // If the bot didn't provide a UUID, mint one ourselves. The plan owns
    // generation in bot.ts so it can be persisted in state.json (D14), but
    // until §11 Этап 3 wires that up we mint here as a safe default.
    const claudeSessionId = sessionId || randomUUID();
    console.log(
      `[Claude] Starting tmux session ${sessionName} in ${workDir} ` +
      `(sessionId=${claudeSessionId})${args ? ` with args: ${args}` : ''}`,
    );

    // Make sure no stale session with the same name is lingering.
    tmux('kill-session', '-t', sessionName);

    const createCmd = `tmux new-session -d -s ${sessionName} -x 300 -y 50`;
    // Build the command we'll send into tmux as a single shell line.
    // --session-id <uuid> assigns the UUID to the NEW session so we can later
    // resume by UUID (plan §13.1). --dangerously-skip-permissions stays hardcoded
    // by D44 (symmetry with opencode auto-approve).
    //
    // MCP servers come from up to four sources (user/group/project/thread,
    // plan §19); user + project are auto-loaded by Claude from cwd, the
    // other two reach Claude through repeated `--mcp-config` flags that
    // we build here. The flag values point at tmp files because the bot
    // expands `${VAR}` env-var placeholders itself before handing the
    // config off (plan §13.18, T2).
    const claudeArgs = args ? ` ${args}` : '';
    // The `prepareMcpFlags` array alternates flag literal, path, flag
    // literal, path, …. Only the path tokens need quoting (DATA_DIR can
    // contain spaces); quoting the `--mcp-config` literal too is harmless
    // but obscures the intent.
    const mcpFlagsArr = prepareMcpFlags({ key, dataDir: resolveDataDir() });
    const mcpSegment = mcpFlagsArr.length
      ? ' ' + mcpFlagsArr.map((a, i) => (i % 2 ? shellSingleQuote(a) : a)).join(' ')
      : '';
    const claudeCmd =
      `cd ${shellSingleQuote(workDir)} && ` +
      `${claudePath} --dangerously-skip-permissions ` +
      `--session-id ${claudeSessionId}${mcpSegment}${claudeArgs}`;
    const startClaudeCmd = `tmux send-keys -t ${sessionName} ${JSON.stringify(claudeCmd)} Enter`;
    try {
      execSync(createCmd, { encoding: 'utf-8', timeout: 5000 });
      console.log(`[Claude] tmux session created`);
      execSync(startClaudeCmd, { encoding: 'utf-8', timeout: 5000 });
      console.log(`[Claude] claude command sent`);
    } catch (e) {
      console.error(`[Claude] Failed to create tmux session:`, e);
      this.emit('error', key, new Error('Failed to start Claude session'));
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
      key,
      workDir,
      sessionName,
      claudeSessionId,
      pollTimer: null,
      lastContent: '',
      isActive: true,
      handledAutoEnter: false,
      handledAutoAccept: false,
      lastStatusText: '',
    };

    this.sessions.set(keyToString(key), session);
    session.pollTimer = setInterval(() => this.pollOutput(key), pollInterval);
    this.emit('started', key);
  }

  stopSession(key: ThreadKey): void {
    const k = keyToString(key);
    const session = this.sessions.get(k);
    if (!session) return;

    console.log(`[Claude] Stopping session for ${k}`);

    session.isActive = false;
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
    }

    tmux('kill-session', '-t', session.sessionName);
    // Remove the tmp MCP files we wrote on startSession — claude inlines
    // their content into the session at boot, so once tmux is killed they
    // serve no purpose and would just leak secrets on disk (plan §13.18).
    cleanupMcpTempFiles({ key, dataDir: resolveDataDir() });
    this.sessions.delete(k);
    this.emit('stopped', key);
  }

  checkIsActive(key: ThreadKey): boolean {
    const session = this.sessions.get(keyToString(key));
    if (!session) return false;

    const sessions = tmux('list-sessions', '-F', '#{session_name}');
    return sessions.includes(session.sessionName);
  }

  sendInput(key: ThreadKey, input: string): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) {
      console.log(`[Claude] sendInput: no active session for ${keyToString(key)}`);
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

  sendSignal(key: ThreadKey, signal: string): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    if (signal === 'SIGINT') {
      tmux('send-keys', '-t', session.sessionName, 'C-c');
      console.log(`[Claude] sent Ctrl+C`);
    }
  }

  sendEnter(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    console.log(`[Claude] sendEnter`);
    tmux('send-keys', '-t', session.sessionName, 'Enter');
  }

  sendArrow(key: ThreadKey, direction: 'Up' | 'Down'): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    console.log(`[Claude] sendArrow: ${direction}`);
    tmux('send-keys', '-t', session.sessionName, direction);
  }

  sendTab(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    console.log(`[Claude] sendTab`);
    tmux('send-keys', '-t', session.sessionName, 'Tab');
  }

  /**
   * @description For Claude CLI, model switching is done via the /model slash command.
   * Sends "/model <modelId>" as input to the tmux session.
   */
  setModel(key: ThreadKey, modelId: string): void {
    this.sendInput(key, `/model ${modelId}`);
  }

  getCurrentModel(_key: ThreadKey): string | null {
    return null;
  }

  getFullOutput(key: ThreadKey, lines: number = 500): string | null {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return null;

    const raw = tmux('capture-pane', '-t', session.sessionName, '-p', '-S', `-${lines}`);
    if (!raw) return null;

    return cleanOutput(raw);
  }

  /**
   * @description Expose the Claude `--session-id` UUID for a live session.
   * The bot calls this right after `startSession()` so the UUID can be
   * persisted in state.json and reused on later resumes (plan §13.1, D14).
   */
  getClaudeSessionId(key: ThreadKey): string | null {
    return this.sessions.get(keyToString(key))?.claudeSessionId ?? null;
  }

  async getSessions(_key: ThreadKey): Promise<AgentSession[]> {
    const stored = loadStoredSessions();
    return stored.map(s => ({
      id: s.id,
      title: s.title,
      createdAt: new Date(s.createdAt),
      updatedAt: new Date(s.updatedAt),
    }));
  }

  /**
   * @description Resume a Claude session by UUID.
   *
   * Two fixes vs. the legacy implementation:
   *
   * 1. **Required `workDir`.** The old `resumeSession` fell back to
   *    `process.env.WORK_DIR || '/workspace'`, which is wrong as soon as the
   *    bot manages multiple folders. The bot now passes the correct workDir
   *    from the thread binding.
   *
   * 2. **Use `--resume <uuid>` instead of `--resume` with no argument.** The
   *    no-arg form opens an interactive picker that can't be driven from a
   *    headless tmux pane, which manifested as a silent hang (see plan
   *    §13.1, fix to claudeCliAdapter.ts:455). If Claude can't find the UUID
   *    (history pruned, different machine), it just starts a new session;
   *    we surface that to the user (T8 in plan §16.3).
   */
  async resumeSession(key: ThreadKey, workDir: string, sessionId: string): Promise<void> {
    this.stopSession(key);

    if (!checkIsInstalled('claude')) {
      this.emit('output', key, 'Installing Claude Code...');
      await installTool('claude');
    }

    const sessionName = buildTmuxSessionName(key);
    console.log(`[Claude] Resuming session ${sessionId} in ${workDir} for ${keyToString(key)}`);

    tmux('kill-session', '-t', sessionName);

    const createCmd = `tmux new-session -d -s ${sessionName} -x 300 -y 50`;
    // Pass the UUID explicitly. If it's unknown to claude, it'll just print a
    // notice and start fresh — better than hanging on a picker. MCP flags
    // are re-applied here so a resumed session sees the same servers as a
    // fresh one would (plan §19). Only path tokens are quoted; see
    // startSession for the rationale.
    const mcpFlagsArr = prepareMcpFlags({ key, dataDir: resolveDataDir() });
    const mcpSegment = mcpFlagsArr.length
      ? ' ' + mcpFlagsArr.map((a, i) => (i % 2 ? shellSingleQuote(a) : a)).join(' ')
      : '';
    const claudeCmd =
      `cd ${shellSingleQuote(workDir)} && ` +
      `${claudePath} --dangerously-skip-permissions --resume ${sessionId}${mcpSegment}`;
    const startClaudeCmd = `tmux send-keys -t ${sessionName} ${JSON.stringify(claudeCmd)} Enter`;

    try {
      execSync(createCmd, { encoding: 'utf-8', timeout: 5000 });
      execSync(startClaudeCmd, { encoding: 'utf-8', timeout: 5000 });
    } catch (e) {
      console.error(`[Claude] Failed to resume session:`, e);
      this.emit('error', key, new Error('Failed to resume Claude session'));
      return;
    }

    const claudeSession: ClaudeSession = {
      key,
      workDir,
      sessionName,
      claudeSessionId: sessionId,
      pollTimer: null,
      lastContent: '',
      isActive: true,
      handledAutoEnter: false,
      handledAutoAccept: false,
      lastStatusText: '',
    };

    this.sessions.set(keyToString(key), claudeSession);
    claudeSession.pollTimer = setInterval(() => this.pollOutput(key), pollInterval);
    this.emit('started', key);
  }

  /**
   * @description Pick up tmux sessions that outlived the bot process.
   *
   * Called by `bot.ts` on startup, BEFORE `bot.launch()`. Scans
   * `tmux list-sessions` for names matching our `claude-<chatId>-<threadId>`
   * convention. For each match, returns the parsed key + tmux session name —
   * the bot then decides which ones to re-adopt (must have a live binding in
   * state.json) and which are orphans to garbage-collect (plan §10.2 / §13.19, E1).
   *
   * This method does NOT itself adopt sessions: it has no knowledge of state.json
   * or which sessions are still bound. The actual re-attach is done by the bot
   * calling {@link adoptExistingTmuxSession} for each key it wants to keep.
   *
   * Returns an empty array if tmux isn't installed or no matching sessions exist.
   */
  async listExistingTmuxSessions(): Promise<Array<{ key: ThreadKey; sessionName: string }>> {
    const raw = tmux('list-sessions', '-F', '#{session_name}');
    if (!raw) return [];
    const names = raw.split('\n').map(s => s.trim()).filter(Boolean);
    const result: Array<{ key: ThreadKey; sessionName: string }> = [];
    for (const name of names) {
      const key = parseTmuxSessionName(name);
      if (key) result.push({ key, sessionName: name });
    }
    return result;
  }

  /**
   * @description Adopt a tmux session that survived a bot restart.
   *
   * The bot calls this after `listExistingTmuxSessions()` for each
   * `(key, sessionName)` pair it wants to keep alive. Restores the in-memory
   * `ClaudeSession` and resumes polling so output flows back to Telegram.
   *
   * `workDir` and `claudeSessionId` come from state.json (the bot keeps a
   * binding `(key → subdir, claudeSessionId)`). If we ever lose them, the
   * caller should kill the tmux session as an orphan instead.
   *
   * Returns `true` on success, `false` if the tmux session disappeared between
   * the `list` call and now (race with manual `tmux kill-session`).
   */
  adoptExistingTmuxSession(
    key: ThreadKey,
    sessionName: string,
    workDir: string,
    claudeSessionId: string,
  ): boolean {
    const sessions = tmux('list-sessions', '-F', '#{session_name}');
    if (!sessions.includes(sessionName)) {
      console.log(`[Claude] adopt: tmux session ${sessionName} no longer exists`);
      return false;
    }

    const k = keyToString(key);
    // If we already have a tracked session for this key, leave it alone.
    if (this.sessions.has(k)) {
      console.log(`[Claude] adopt: already tracking ${k}, skipping`);
      return true;
    }

    console.log(`[Claude] adopt: re-attaching to ${sessionName} in ${workDir}`);
    const session: ClaudeSession = {
      key,
      workDir,
      sessionName,
      claudeSessionId,
      pollTimer: null,
      lastContent: '',
      isActive: true,
      handledAutoEnter: true,  // don't try to auto-Enter on a session that's already past startup
      handledAutoAccept: true, // same — bypass-permissions was accepted on the original launch
      lastStatusText: '',
    };
    this.sessions.set(k, session);
    session.pollTimer = setInterval(() => this.pollOutput(key), pollInterval);
    this.emit('started', key);
    return true;
  }

  /**
   * @description Kill a tmux session by name without touching adapter state.
   *
   * The bot uses this on startup to garbage-collect orphan tmux sessions
   * (`claude-<chatId>-<threadId>` names with no corresponding binding in
   * state.json). See plan §10.2 / §13.19.
   */
  killOrphanTmuxSession(sessionName: string): void {
    console.log(`[Claude] kill orphan tmux session: ${sessionName}`);
    tmux('kill-session', '-t', sessionName);
  }

  // Exposed for tests (see §11 Этап 7, R10): keeps the tmux-name parsing
  // logic unit-testable without instantiating the adapter (which would try to
  // auto-install claude on construction).
  static parseTmuxSessionName = parseTmuxSessionName;
  static buildTmuxSessionName = buildTmuxSessionName;

  private pollOutput(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    const raw = tmux('capture-pane', '-t', session.sessionName, '-p', '-e', '-S', '-200');

    if (!raw) {
      if (!this.checkIsActive(key)) {
        console.log(`[Claude] Session died, cleaning up`);
        this.stopSession(key);
        this.emit('closed', key);
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

          if (checkIsStatusOutput(cleanedOutput)) {
            // Deduplicate spinner updates: normalize spinner character and compare
            const normalized = cleanedOutput.replace(/^[✻✽✶✢·*●○]\s*/gm, '');
            if (normalized !== session.lastStatusText) {
              session.lastStatusText = normalized;
              this.emit('status', key, cleanedOutput);
            }
          } else {
            session.lastStatusText = '';
            this.emit('output', key, cleanedOutput);
          }
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
