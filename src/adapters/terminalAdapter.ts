import { EventEmitter } from 'events';
import type {
  AgentAdapter,
  AgentSession,
  ResumeSessionOptions,
  SendInputOptions,
  ThreadKey,
} from '../types';
import { keyToString } from '../types';
import { createSerialQueue, type SerialQueue } from '../utils/serialQueue';
import { getNextPollDelay, basePollIntervalMs } from '../utils/pollBackoff';
import { tmuxAsync, tmuxOrThrowAsync, checkArgsAreSafe, shellSingleQuote } from '../utils/tmuxExec';
import { cleanOutput } from '../utils/ansiClean';
import { getNewPaneContent } from '../utils/paneDiff';
import {
  buildTmuxSessionName,
  parseTmuxSessionName,
} from '../utils/tmuxSessionName';
import {
  getTerminalEmitPlan,
  buildTerminalNewSessionArgs,
  terminalPaneCols,
  terminalPaneRows,
  terminalTmuxPrefix,
  defaultShell,
} from '../utils/terminalEmitPlan';

/**
 * @description Per-thread terminal (raw shell) session state. A deliberately
 * SMALL subset of `ClaudeSession`: a terminal has no TUI question/survey/sub-
 * agent/tool-result/resume-seeding machinery — it just streams pane output.
 */
interface TerminalSession {
  key: ThreadKey;
  workDir: string;
  sessionName: string;
  queue: SerialQueue;
  pollTimer: NodeJS.Timeout | null;
  isActive: boolean;
  /** Cleaned pane content from the previous poll — the line-set diff baseline. */
  lastContent: string;
  /**
   * Raw `capture-pane` text from the previous poll. A byte-identical capture
   * skips the `cleanOutput` pass entirely (idle pane = no work), exactly like
   * the Claude adapter's `lastRawCapture`.
   */
  lastRawCapture: string;
  /** Re-entrancy guard so a slow capture can't overlap the next scheduled poll. */
  isPolling: boolean;
  /** Current adaptive poll delay; grows while idle, snaps back on any write/change. */
  currentPollDelayMs: number;
  /** Consecutive unchanged polls — drives the backoff. */
  unchangedPollStreak: number;
  /**
   * True when the NEXT emitted output chunk starts a fresh message (a new
   * command's first output). Re-armed by every `sendInput`; cleared after the
   * first chunk so the rest of that command's output appends as continuations.
   * See {@link getTerminalEmitPlan}.
   */
  nextOutputFresh: boolean;
}

/**
 * @description A raw interactive shell proxied into a topic, a third
 * `AgentAdapter` sibling to Claude / OpenCode. The bot types the user's text in
 * as keystrokes (`send-keys`) and streams the scraped pane back as ONE rolling
 * message per command. NO AI logic, NO Claude-TUI scrape (question / survey /
 * sub-agent / tool-result / effort / MCP / resume-seeding) — just the generic
 * capture → line-set-diff → clean → emit subset.
 *
 * It does NOT extend `ClaudeCliAdapter` and leaves `outputsDeltas` falsy, so the
 * bot's Claude-specific liveness loop never fires for a terminal.
 */
export class TerminalAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'terminal';
  readonly label = 'Terminal';

  /** Serialised `ThreadKey` (`"<chatId>:<threadId>"`) → live session. */
  private sessions = new Map<string, TerminalSession>();

  private buildSessionName(key: ThreadKey): string {
    return buildTmuxSessionName(terminalTmuxPrefix, key);
  }

  private createSession(input: { key: ThreadKey; workDir: string; sessionName: string }): TerminalSession {
    return {
      key: input.key,
      workDir: input.workDir,
      sessionName: input.sessionName,
      queue: createSerialQueue(),
      pollTimer: null,
      isActive: true,
      lastContent: '',
      lastRawCapture: '',
      isPolling: false,
      currentPollDelayMs: basePollIntervalMs,
      unchangedPollStreak: 0,
      // A freshly-started shell's banner/prompt should open a new message.
      nextOutputFresh: true,
    };
  }

  private enqueueTmux<T>(session: TerminalSession, fn: () => Promise<T>): Promise<T> {
    return session.queue.run(fn);
  }

  private enqueueTmuxBestEffort(session: TerminalSession, fn: () => Promise<string>): void {
    void this.enqueueTmux(session, fn).catch((e) => {
      console.warn(`[Terminal] tmux operation failed:`, e instanceof Error ? e.message : e);
    });
  }

  // — Lifecycle —

  async startSession(key: ThreadKey, workDir: string, args?: string): Promise<void> {
    await this.stopSessionInternal(key);

    if (args && !checkArgsAreSafe(args)) {
      throw new Error('Args contain control characters');
    }

    const sessionName = this.buildSessionName(key);
    console.log(`[Terminal] Starting tmux session ${sessionName} in ${workDir}`);

    // Make sure no stale session with the same name lingers.
    await tmuxAsync('kill-session', '-t', sessionName);

    // tmux execs the trailing shell-command via `$SHELL -c`. Single-quote the
    // shell path (defence-in-depth — same idiom as the Claude command line)
    // even though `$SHELL` is operator-controlled, not user input.
    const shellCommand = shellSingleQuote(defaultShell);
    try {
      await tmuxOrThrowAsync(
        ...buildTerminalNewSessionArgs({
          sessionName,
          workDir,
          shellCommand,
          cols: terminalPaneCols,
          rows: terminalPaneRows,
        }),
      );
      console.log(`[Terminal] tmux session created`);
    } catch (e) {
      console.error(`[Terminal] Failed to create tmux session:`, e);
      await tmuxAsync('kill-session', '-t', sessionName);
      throw new Error(`Failed to start terminal session: ${e instanceof Error ? e.message : String(e)}`);
    }

    const session = this.createSession({ key, workDir, sessionName });
    this.sessions.set(keyToString(key), session);
    this.schedulePoll(key, session);
    this.emit('started', key);
  }

  stopSession(key: ThreadKey): void {
    void this.stopSessionInternal(key).catch((e) => {
      console.warn(`[Terminal] stopSession failed:`, e instanceof Error ? e.message : e);
    });
  }

  private async stopSessionInternal(key: ThreadKey): Promise<void> {
    const k = keyToString(key);
    const session = this.sessions.get(k);
    if (!session) return;

    console.log(`[Terminal] Stopping session for ${k}`);
    session.isActive = false;
    if (session.pollTimer) {
      clearTimeout(session.pollTimer);
      session.pollTimer = null;
    }
    const killPromise = this.enqueueTmux(session, () =>
      tmuxAsync('kill-session', '-t', session.sessionName),
    );
    this.sessions.delete(k);
    this.emit('stopped', key);
    await killPromise;
  }

  checkIsActive(key: ThreadKey): boolean {
    const session = this.sessions.get(keyToString(key));
    return session?.isActive ?? false;
  }

  // — Input —

  sendInput(key: ThreadKey, input: string, options?: SendInputOptions): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) {
      console.log(`[Terminal] sendInput: no active session for ${keyToString(key)}`);
      return;
    }

    const appendEnter = options?.appendEnter ?? true;
    console.log(`[Terminal] sendInput: "${input}"${appendEnter ? '' : ' (no Enter)'}`);
    this.resetPollCadence(key, session);
    // A submitted command opens a fresh rolling message for its output.
    session.nextOutputFresh = true;

    // `-l` delivers the text as LITERAL keys (so a typed "Enter" isn't rewritten
    // to a newline, and `$(...)` / backticks reach the shell's stdin verbatim
    // rather than being expanded by any intermediate shell — there is none, tmux
    // sends bytes straight to the pane). The submit Enter is a separate call.
    this.enqueueTmuxBestEffort(session, async () => {
      if (!session.isActive) return '';
      return tmuxAsync('send-keys', '-t', session.sessionName, '-l', input);
    });
    if (appendEnter) {
      this.enqueueTmuxBestEffort(session, async () => {
        if (!session.isActive) return '';
        return tmuxAsync('send-keys', '-t', session.sessionName, 'Enter');
      });
    }
  }

  sendSignal(key: ThreadKey, signal: string): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    this.resetPollCadence(key, session);
    if (signal === 'SIGINT') {
      this.enqueueTmuxBestEffort(session, async () => {
        if (!session.isActive) return '';
        return tmuxAsync('send-keys', '-t', session.sessionName, 'C-c');
      });
      console.log(`[Terminal] sent Ctrl+C`);
    }
  }

  // — Optional TUI controls (raw keys) —

  sendEnter(key: ThreadKey): void {
    this.sendRawKey(key, 'Enter', 'sendEnter');
  }

  sendArrow(key: ThreadKey, direction: 'Up' | 'Down'): void {
    this.sendRawKey(key, direction, `sendArrow: ${direction}`);
  }

  sendTab(key: ThreadKey): void {
    this.sendRawKey(key, 'Tab', 'sendTab');
  }

  private sendRawKey(key: ThreadKey, tmuxKey: string, logLabel: string): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;
    this.resetPollCadence(key, session);
    console.log(`[Terminal] ${logLabel}`);
    this.enqueueTmuxBestEffort(session, async () => {
      if (!session.isActive) return '';
      return tmuxAsync('send-keys', '-t', session.sessionName, tmuxKey);
    });
  }

  // — Session history (terminals aren't resumable) —

  async getSessions(_key: ThreadKey, _workDir: string): Promise<AgentSession[]> {
    return [];
  }

  async resumeSession(
    _key: ThreadKey,
    _workDir: string,
    _sessionId: string,
    _options?: ResumeSessionOptions,
  ): Promise<void> {
    // Never hit on the happy path: `getSessions` returns [] (no picker entries)
    // and the bot's reattach uses `adoptExistingTmuxSession`, not resume.
    throw new Error('Resume is not supported for a terminal session');
  }

  // — Poll loop (generic capture → diff → clean → emit subset) —

  /**
   * @description Snap the poll cadence back to base on every explicit write so a
   * just-submitted command's output isn't delayed by the idle backoff. Mirrors
   * the Claude adapter's `resetPollCadence`.
   */
  private resetPollCadence(key: ThreadKey, session: TerminalSession): void {
    session.currentPollDelayMs = basePollIntervalMs;
    session.unchangedPollStreak = 0;
    if (!session.isActive || session.isPolling) return;
    if (session.pollTimer) {
      clearTimeout(session.pollTimer);
      session.pollTimer = null;
      this.schedulePoll(key, session);
    }
  }

  private schedulePoll(key: ThreadKey, session: TerminalSession): void {
    if (!session.isActive) return;
    session.pollTimer = setTimeout(() => {
      void (async () => {
        if (!session.isActive) return;
        if (session.isPolling) {
          this.schedulePoll(key, session);
          return;
        }
        session.isPolling = true;
        try {
          await this.pollOutput(key);
        } finally {
          session.isPolling = false;
          this.schedulePoll(key, session);
        }
      })();
    }, session.currentPollDelayMs);
  }

  private async probeSessionAlive(session: TerminalSession): Promise<boolean> {
    const sessions = await this.enqueueTmux(session, () =>
      tmuxAsync('list-sessions', '-F', '#{session_name}'),
    );
    return sessions.split('\n').includes(session.sessionName);
  }

  private async pollOutput(key: ThreadKey): Promise<void> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    const raw = await this.enqueueTmux(session, () =>
      tmuxAsync('capture-pane', '-t', session.sessionName, '-p', '-e', '-S', '-2000'),
    );
    if (!session.isActive) return;

    if (!raw) {
      // An empty capture can mean the pane died — confirm before tearing down.
      const alive = await this.probeSessionAlive(session);
      if (!session.isActive) return;
      if (!alive) {
        console.log(`[Terminal] Session died, cleaning up`);
        await this.stopSessionInternal(key);
        this.emit('closed', key);
      }
      return;
    }

    // Byte-identical capture → pane unchanged → cleaned content identical too,
    // so skip the `cleanOutput` pass and reuse the cached result.
    const isRawChanged = raw !== session.lastRawCapture;
    let content: string;
    if (isRawChanged) {
      session.lastRawCapture = raw;
      content = cleanOutput(raw);
    } else {
      content = session.lastContent;
    }

    const nextCadence = getNextPollDelay({
      isChanged: isRawChanged,
      currentDelayMs: session.currentPollDelayMs,
      unchangedStreak: session.unchangedPollStreak,
    });
    session.currentPollDelayMs = nextCadence.delayMs;
    session.unchangedPollStreak = nextCadence.unchangedStreak;

    if (content === session.lastContent) return;

    const diff = getNewPaneContent(session.lastContent, content);
    session.lastContent = content;
    const chunk = diff.text.trim();
    if (!chunk) return;

    const { isContinuation } = getTerminalEmitPlan(session.nextOutputFresh);
    session.nextOutputFresh = false;
    if (isContinuation) {
      this.emit('output', key, chunk, { isContinuation: true });
    } else {
      this.emit('output', key, chunk);
    }
  }

  // — Reattach surface (mirrors Claude; called by the bot's reattach loop) —

  /**
   * @description List live tmux sessions that match the terminal `term-` naming
   * convention, parsed back to their `ThreadKey`. The bot decides which to adopt
   * (must have a live binding) and which are orphans to kill. Does NOT adopt.
   */
  async listExistingTmuxSessions(): Promise<Array<{ key: ThreadKey; sessionName: string }>> {
    const raw = await tmuxAsync('list-sessions', '-F', '#{session_name}');
    if (!raw) return [];
    const names = raw.split('\n').map(s => s.trim()).filter(Boolean);
    const result: Array<{ key: ThreadKey; sessionName: string }> = [];
    for (const name of names) {
      const key = parseTmuxSessionName(terminalTmuxPrefix, name);
      if (key) result.push({ key, sessionName: name });
    }
    return result;
  }

  /**
   * @description Adopt a terminal tmux session that outlived the bot. Confirms
   * the session still exists, that its pane has a live child process (zombie
   * check), then seeds `lastContent` from the CURRENT pane so the first poll
   * doesn't dump the whole scrollback as "new" output. Returns `true` on adopt.
   */
  async adoptExistingTmuxSession(key: ThreadKey, sessionName: string, workDir: string): Promise<boolean> {
    const sessions = await tmuxAsync('list-sessions', '-F', '#{session_name}');
    if (!sessions.split('\n').includes(sessionName)) {
      console.log(`[Terminal] adopt: tmux session ${sessionName} no longer exists`);
      return false;
    }

    const panesRaw = await tmuxAsync('list-panes', '-t', sessionName, '-F', '#{pane_pid}');
    const pids = panesRaw.split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s));
    const anyAlive = pids.some(pidStr => {
      try { process.kill(Number(pidStr), 0); return true; }
      catch { return false; }
    });
    if (!anyAlive) {
      console.log(`[Terminal] adopt: ${sessionName} has no live child process, killing as zombie`);
      await tmuxAsync('kill-session', '-t', sessionName);
      return false;
    }

    const k = keyToString(key);
    if (this.sessions.has(k)) {
      console.log(`[Terminal] adopt: already tracking ${k}, skipping`);
      return true;
    }

    console.log(`[Terminal] adopt: re-attaching to ${sessionName} in ${workDir}`);
    const session = this.createSession({ key, workDir, sessionName });
    // Seed the baseline from the current pane so the diff against the first poll
    // is empty (no flood of stale scrollback). Same flags as `pollOutput`.
    const initialRaw = await this.enqueueTmux(session, () =>
      tmuxAsync('capture-pane', '-t', sessionName, '-p', '-e', '-S', '-2000'),
    );
    if (initialRaw) {
      session.lastContent = cleanOutput(initialRaw);
      session.lastRawCapture = initialRaw;
    }
    // The next real output is a fresh message (the current pane was swallowed).
    session.nextOutputFresh = true;

    this.sessions.set(k, session);
    this.schedulePoll(key, session);
    this.emit('started', key);
    return true;
  }

  /**
   * @description Kill a terminal tmux session by name without touching adapter
   * state — the bot's orphan garbage-collector for `term-…` sessions with no
   * live binding.
   */
  async killOrphanTmuxSession(sessionName: string): Promise<void> {
    console.log(`[Terminal] kill orphan tmux session: ${sessionName}`);
    await tmuxAsync('kill-session', '-t', sessionName);
  }
}
