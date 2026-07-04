import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sleep } from '../utils';
import type {
  AgentAdapter,
  AgentApiErrorClass,
  AgentSession,
  ClaudeSurveyOption,
  DisplayPrefsReader,
  DisplayVerbosityMode,
  OutputEventMeta,
  ReattachRecap,
  RecentTurn,
  ResolvedThreadDisplayPrefs,
  ResumeSessionOptions,
  SeenWatermark,
  SeenWatermarkWriter,
  SendInputOptions,
  ThreadKey,
} from '../types';
import { keyToString } from '../types';
import { classifyAgentApiError } from '../apiErrorRetry';
import { checkIsInstalled, installTool } from '../installManager';
import { prepareMcpFlags, cleanupMcpTempFiles } from '../mcpConfig';
import { resolveDataDir } from '../state';
import { threadContextPreambleHeader } from '../threadContextPreamble';
import { resolveClaudeBinary } from '../utils/resolveBinary';
import {
  SPINNER_TICK_RE,
  POST_THINKING_TRAILER_RE,
  THINKING_HEADER_RE,
  OUTPUT_TOOL_HEADER_RE,
  FILE_TOOL_HEADER_RE,
  TOOL_RESULT_MARKER_RE,
  CODE_FENCE_LINE_RE,
  PROGRESS_PASSTHROUGH_RE,
  COLLAPSE_MARKER_RE,
  COMPLETION_SUMMARY_RE,
  DIFF_CHANGE_GUTTER_RE,
  TRANSIENT_TICK_RE,
  checkIsClaudeChromeLine,
  checkIsBareSpinnerActivityLine,
  type ToolResultKind,
} from '../utils/claudeScrapeShapes';
import { checkIsProgressChunk } from '../progressLine';
import { createSerialQueue, type SerialQueue } from '../utils/serialQueue';
import { t } from '../i18n';
import { formatResumeContext, resumeContextTurnLimit } from '../resumeContext';
import { getClaudeAvailableLevels, checkIsClaudeEffortLevel, defaultEffortLevel } from '../effortLevels';
import { getNextPollDelay, basePollIntervalMs } from '../utils/pollBackoff';
import {
  tmuxAsync,
  tmuxOrThrowAsync,
  checkArgsAreSafe,
  shellSingleQuote,
} from '../utils/tmuxExec';
import { convertAnsiToMarkdown, cleanOutput } from '../utils/ansiClean';
import { getNewPaneContent, type NewPaneContent } from '../utils/paneDiff';
import { getPaneResizeGuardDecision, parsePaneSize } from '../utils/paneResizeGuard';
import {
  buildTmuxSessionName as buildTmuxSessionNameWithPrefix,
  parseTmuxSessionName as parseTmuxSessionNameWithPrefix,
} from '../utils/tmuxSessionName';
import { getEffortStartupKeystroke } from '../utils/effortStartupKeystroke';
import { defaultDisplayVerbosityMode } from '../utils/displayVerbosity';
import {
  checkIsSubagentTranscriptName,
  createSubagentTailState,
  extractAppendedSubagentTexts,
  getSubagentTailReads,
  type SubagentScanFile,
  type SubagentTailState,
} from '../utils/claudeSubagentTail';
import {
  createRecentRelayWindow,
  getRelayDedupedChunk,
  seedRelayWindowFromPane,
  type RecentRelayWindow,
} from '../utils/recentRelayWindow';
import {
  classifyClaudeChunk,
  createInitialChunkContext,
  type ClaudeChunkContext,
} from '../utils/claudeChunkClassifier';
import {
  checkIsClaudeRelayFastPath,
  routeClaudeChunkSegments,
} from '../utils/claudeRelayRouting';

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
  queue: SerialQueue;
  pollTimer: NodeJS.Timeout | null;
  lastContent: string;
  isActive: boolean;
  handledAutoEnter: boolean;
  handledAutoAccept: boolean;
  /**
   * One-shot guard for the auto-retry `apiError` emit. Armed when the terminal
   * `API Error:` line first classifies as retryable, reset by the same
   * `newPart.length > 50` rule as the sibling `handled*` flags — so a later,
   * distinct error in the same session re-arms, but a static error frame
   * doesn't re-emit on every poll.
   */
  handledApiError: boolean;
  /** Normalized text of last emitted status (for deduplication of spinner updates) */
  lastStatusText: string;
  /**
   * The last text the bot typed into this session via {@link ClaudeCliAdapter.sendInput}
   * (the preamble-glued prompt, a `/c continue` nudge, a buffered replay — every
   * typed path). Used by the CONTENT-based echo gate (S1): Claude echoes typed
   * input back in the pane, and when that echo carries no `❯` (a wrapped row, the
   * `[Telegram thread context]` preamble, a voice-transcript tail) the shape-only
   * {@link checkIsInputEchoFrame} misses it and it leaks into the topic. Empty
   * until the first send.
   */
  lastForwardedText: string;
  /**
   * Epoch ms of the last {@link lastForwardedText} capture. The content echo gate
   * only fires within a short window after a send (the echo appears right at
   * submit), so a much later real reply that coincidentally repeats prompt words
   * is never suppressed.
   */
  lastForwardedTextAt: number;
  /**
   * Signature of the last emitted interactive-question block (the option-label
   * set, ignoring which option is highlighted). Moving the `❯` cursor repaints
   * the whole box every keystroke; comparing signatures lets us deliver the
   * question once and suppress the cursor-move repaints. Cleared when real
   * prose follows (the question is over). See {@link extractClaudeQuestion}.
   */
  lastQuestionSignature: string;
  /**
   * Consecutive poll diffs (while a question is pending) in which
   * {@link extractClaudeQuestion} found NO selector on screen. The selector
   * repaints constantly, so a single scrape can momentarily fail to match while
   * it is still up; resolving the question (emit `questionGone`) on that lone
   * null both unpins prematurely AND re-emits a duplicate question + notification
   * the next poll (the signature was cleared). We only treat the question as gone
   * after it has been absent for {@link questionAbsentPollThreshold} consecutive
   * diffs. Reset to 0 on any detection.
   */
  questionAbsentPolls: number;
  /**
   * Signature of the last AUTO-DISMISSED Claude CLI bare-digit survey (header +
   * option digits/labels). Same de-dup mechanism as
   * {@link lastQuestionSignature}: the survey repaints every poll while on
   * screen, so comparing signatures sends the dismiss keystroke exactly once.
   * Cleared when the survey leaves the pane, so a genuinely new survey later is
   * re-dismissed. Drives {@link checkShouldDismissSurvey}. See
   * {@link extractClaudeSurvey}.
   */
  lastSurveySignature: string;
  /**
   * Handles for the auto-Enter / auto-Accept `setTimeout`s. Audit S9 / #10:
   * the callbacks used to fire 300–400 ms after detection regardless of
   * whether the session was still alive; on rapid stop/start the keystroke
   * would land in a different invocation (e.g. auto-accepting a permission
   * prompt belonging to a replacement session). Cleared on `stopSession`;
   * callbacks also re-check `session.isActive` before issuing tmux keys.
   */
  autoEnterTimer: NodeJS.Timeout | null;
  autoAcceptOuterTimer: NodeJS.Timeout | null;
  autoAcceptInnerTimer: NodeJS.Timeout | null;
  /**
   * Re-entrancy guard for `pollOutput`. Audit S9 / #37: a `tmux capture-pane`
   * under load can take longer than the 300 ms poll interval, and the next
   * `setInterval` tick would fire before the previous one finished, leading
   * to duplicate `output` emissions. With self-rescheduling `setTimeout`
   * and this flag we serialise polls; ticks that overlap with an in-flight
   * one are skipped silently.
   */
  isPolling: boolean;
  /**
   * Tool-result kind still open at the end of the last emitted poll, threaded
   * into the next poll so a slow command's orphan output (whose `● Bash(…)`
   * header was suppressed by the line-set diff) is still fenced (B2). See
   * {@link fenceToolResultBodies}.
   */
  openToolKind: ToolResultKind | null;
  /**
   * Resume flood-suppression mode. On `--resume`, Claude repaints the ENTIRE
   * restored transcript into the pane over several polls; relaying that diff
   * would dump hours of old conversation into the topic. While seeding we
   * advance the baseline (`lastContent`) every poll but emit NOTHING, so once
   * the pane stops growing the baseline equals the full restored transcript
   * and later diffs are genuine new output. The short last-3-turn context block
   * is posted separately (read from the `.jsonl`). The auto-Enter / auto-Accept
   * machinery KEEPS running during seeding — we suppress conversation text, not
   * lifecycle. See {@link getResumeSeedDecision}.
   */
  resumeSeeding: boolean;
  /** Polls elapsed in {@link resumeSeeding} mode — drives the stable/cap exit. */
  resumeSeedPolls: number;
  /** Pane content seen on the previous seeding poll, for the "unchanged across 2 polls" exit. */
  resumeSeedPrevContent: string;
  /**
   * Raw `capture-pane` text from the previous poll. When the new capture is
   * byte-identical we skip `cleanOutput` entirely (S1) — identical raw ⇒
   * identical cleaned content, so the ~15-regex parse is pure wasted work on
   * an idle pane. Reset wherever {@link lastContent} resets.
   */
  lastRawCapture: string;
  /**
   * Current poll delay in ms (S2 adaptive backoff). Starts at
   * {@link basePollIntervalMs}; {@link getNextPollDelay} grows it toward
   * {@link maxPollIntervalMs} while the pane stays unchanged and snaps it back
   * to base on any change or explicit write (see {@link resetPollCadence}).
   */
  currentPollDelayMs: number;
  /** Consecutive unchanged polls — drives {@link getNextPollDelay}'s backoff. */
  unchangedPollStreak: number;
  /**
   * Epoch ms of the last poll whose raw `capture-pane` DIFFERED from the
   * previous one (i.e. the TUI pane actually changed). Drives the bot's
   * pane-static idle net via {@link ClaudeCliAdapter.getMsSincePaneChange}: a
   * genuinely working agent repaints the pane every second (animated spinner +
   * the TUI's own elapsed timer), so a long gap since the last change means the
   * agent is idle even if the footer busy signal is stuck. Seeded to "now" at
   * session creation / adopt so a fresh session never reads as instantly stale.
   */
  lastContentChangeAt: number;
  /**
   * S7 one-shot: the stored `/effort` level to re-type ONCE the TUI input box
   * first appears, so a fresh spawn doesn't inherit claude's GLOBAL effort
   * state (possibly set in another topic). Set at spawn from the per-thread
   * pref ({@link applyStoredEffortOnSpawn}); `null` when no pref or already
   * applied. Consumed by the first poll that sees a ready prompt
   * ({@link checkIsClaudePromptReady}), BEFORE the bot replays buffered prompts
   * onto the same serial tmux queue. NOT set on adopt/reattach (that claude
   * process kept its in-TUI effort and may be mid-turn).
   */
  pendingEffortReapply: string | null;
  /**
   * Last transcript byte size persisted as the seen-{@link SeenWatermark} for
   * this session (in-memory monotonic high-water mark). The poll loop advances
   * the watermark to the current transcript EOF on EVERY idle+ready poll (not
   * just the single busy→ready edge), but writes only when EOF actually grew —
   * this field is the comparison anchor. `undefined` until the first advance,
   * treated as `-1` (the first idle poll always writes). Fresh per session object
   * (start / resume / adopt); correctness across a restart is protected by the
   * recap's PRE-adopt watermark snapshot, not by seeding this from disk. Lets a
   * bot restart count the assistant turns produced while it was down, and — vs
   * the old edge-only gate — corrects a premature mid-turn idle advance and
   * catches a final assistant line flushed just after the turn ends. See
   * {@link checkShouldAdvanceWatermark} / {@link ClaudeCliAdapter.advanceClaudeWatermarkIfGrown}.
   */
  lastWatermarkOffset?: number;
  /**
   * Long-horizon dedup of lines already RELAYED to this topic (incident
   * 2026-06-10: a TUI re-render of an hours-old ~1400-line diff re-relayed as
   * a ~12-message flood — {@link getNewPaneContent} only knows the previous
   * capture, so a redraw of old scrollback looks "new" to it). The poll loop
   * filters every diff chunk through this window before emitting and records
   * a chunk ONLY when it was emitted as permanent output (status frames roll
   * in place; questions/surveys carry their own signature de-dup). Fresh per
   * session object (start / resume / adopt), dies with the session on stop,
   * and reset again when resume seeding ends — the window must start empty
   * AFTER the restored transcript was swallowed. See
   * `utils/recentRelayWindow.ts` for the locked drop-over-resend tradeoff.
   */
  recentRelayWindow: RecentRelayWindow;
  /**
   * Sub-agent transcript tail state (`/subagent full` on Claude, plan
   * 2026-06-11 S3). The poll loop scans
   * `<projectsRoot>/<slug>/<claudeSessionId>/subagents/` every tick and feeds
   * file sizes / appended bytes into the pure `claudeSubagentTail` helpers;
   * this holds the per-file byte offsets + partial-line carries. Fresh per
   * session object (start / resume / adopt all flow through `createSession`),
   * so the helper's first-scan EOF seeding kills backlog replay on
   * resume/adopt — see {@link ClaudeCliAdapter.scanSubagentTranscripts}.
   */
  subagentTail: SubagentTailState;
  /**
   * Cross-poll classifier context for the verbosity relay (S4). A tool body /
   * thinking block / sub-agent panel can span the boundary between two scraped
   * chunks (Claude redraws the whole pane each poll; the diff emits only NEW
   * lines, so a slow command's body arrives in a later poll without its
   * header). {@link classifyClaudeChunk} threads this so the later chunk still
   * tags those orphan lines correctly. Fresh per session object (start /
   * resume / adopt all flow through `createSession`).
   */
  chunkContext: ClaudeChunkContext;
  /**
   * Last known pane size (`<width>x<height>`, e.g. `300x50`) from the per-poll
   * `#{pane_width}x#{pane_height}` query; `null` until the first successful
   * read. A CHANGE means tmux re-wrapped the whole scrollback (an interactive
   * `tmux attach`/detach resizes the window — live incident 2026-07-02, topic
   * 39933) and the poll's giant line-SET diff is repaint, not output. See
   * {@link getPaneResizeGuardDecision}.
   */
  lastPaneSize: string | null;
  /**
   * Whether the session is swallowing a resize repaint: baseline advances
   * every poll but NOTHING is emitted, until a poll sees the capture unchanged
   * (or the settle cap fires). Same suppress-and-advance shape as
   * {@link resumeSeeding}, but for pane-size changes.
   */
  isResizeSettling: boolean;
  /** Consecutive suppressed polls spent in {@link isResizeSettling} — drives the cap. */
  resizeSettlePolls: number;
  /**
   * Streaming-table stabilizer state (live incident 2026-06-11, plan
   * `2026-06-11-claude-wide-table-content-loss`). A wide markdown table re-flows
   * its column widths as longer cells stream in; the line-SET diff treats each
   * intermediate layout as "new" and would ship the table once per layout (empty
   * skeleton → 1 row → full), with the final full frame often dropped under the
   * coalescer's debounce / a 429. We hold the table back until it settles, then
   * emit the complete version once. `null` = no table currently held. Reset at
   * the same lifecycle points as {@link recentRelayWindow} (fresh per session
   * object via `createSession`, and on the resume-seed exit). See
   * {@link getTableStabilizationDecision}.
   */
  streamingTable: StreamingTableState | null;
}

/**
 * @description Hard cap on resume flood-suppression polls. The normal exit is
 * "pane non-empty and unchanged across 2 consecutive polls" (the restored
 * transcript finished painting), but if the paint stutters indefinitely we
 * force-exit after this many polls (≈ {@link basePollIntervalMs} × this) so seeding
 * can never wedge a session into permanent silence. See {@link getResumeSeedDecision}.
 */
const resumeSeedMaxPolls = 40;

const claudePath = resolveClaudeBinary();

/**
 * @description Permission flags for EVERY bot-launched Claude session (start
 * AND resume), forcing allow-all so the user never gets permission prompts.
 *
 * `--dangerously-skip-permissions` only sets bypass as the INITIAL mode and
 * suppresses the "enter bypass?" confirm — it is NOT a runtime lock (shift+tab
 * cycles bypass → auto → default). A live session ended up in a prompting,
 * non-bypass mode despite the flag (thread 15812, 2026-06-12); the bot never
 * sends shift+tab itself, so the drift comes from Claude's own mode state, not
 * the bot. `--permission-mode bypassPermissions` is the documented per-session
 * override (verified present in v2.1.175 `--help`); passing it on every launch
 * re-asserts bypass on each fresh start and resume — verified to land in
 * "bypass permissions on" for both. Residual circuit-breakers (claude always
 * asks for `rm -rf /` or `rm -rf ~`) are intentional and out of scope.
 */
const claudePermissionArgs = [
  '--dangerously-skip-permissions',
  '--permission-mode',
  'bypassPermissions',
];

/**
 * @description When set (`CLAUDE_SCRAPE_DEBUG=1`), the poll loop logs the FULL
 * RAW and FILTERED chunk bodies — a forensic dump useful when debugging the
 * scrape pipeline. Default OFF: those two sync stdout writes per changed poll
 * (up to ~600KB each under load) were starving the event loop in prod, so we
 * log only one-line size summaries instead. Read once at module init like the
 * other env flags in the codebase (see `outputTrace.ts`).
 */
const isClaudeScrapeDebugEnabled = process.env.CLAUDE_SCRAPE_DEBUG === '1';

/**
 * @description Max number of `.jsonl` transcripts to parse per folder.
 *
 * Parsing each transcript is the expensive step (stream the whole file to
 * collect title/cwd/timestamp). We bound it to the most-recent N by mtime
 * — the bot only ever shows the top {@link sessionsDisplayLimit}, so 30 is
 * plenty of headroom even after the `recordedCwd === workDir` filter drops
 * some entries.
 */
const sessionsParseLimit = 30;

/** Cap on a session title's length so the list stays readable in Telegram. */
const sessionTitleMaxLength = 60;

/**
 * @description Per-thread Claude `/effort` choice (plan 2026-05-30-effort-command, D6).
 *
 * Claude itself persists `effortLevel` GLOBALLY in its own `settings.json`,
 * so two threads driven by the same Linux user would otherwise overwrite
 * each other's choice across sessions. We mirror the per-thread model-prefs
 * pattern (see `openCodeAdapter.ts:modelStateFile`) — a tiny JSON map
 * `{ "<chatId>:<threadId>": "<level>" }` under DATA_DIR, used for the
 * banner / picker UI **only**. Live apply still goes through the TUI
 * keystroke path, and claude clamps unsupported levels for the current
 * model (plan D2).
 *
 * The file is best-effort: a corrupt copy is archived and reset (same
 * scheme as `loadStoredSessions`), and write failures only log — they
 * never block the user-facing `/effort` reply.
 */
const effortPrefsFile = path.join(resolveDataDir(), '.claude-effort-prefs.json');

function loadEffortPrefs(): Record<string, string> {
  try {
    if (!fs.existsSync(effortPrefsFile)) return {};
    const raw = fs.readFileSync(effortPrefsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch (e) {
    console.error(`[Claude] loadEffortPrefs failed:`, e instanceof Error ? e.message : e);
    if (fs.existsSync(effortPrefsFile)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.renameSync(effortPrefsFile, `${effortPrefsFile}.corrupted-${ts}`); }
      catch (re) { console.warn(`[Claude] archive of corrupt effort prefs failed:`, re); }
    }
    return {};
  }
}

function saveEffortPref(key: ThreadKey, level: string): void {
  try {
    const data = loadEffortPrefs();
    data[keyToString(key)] = level;
    fs.writeFileSync(effortPrefsFile, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[Claude] saveEffortPref failed:`, e instanceof Error ? e.message : e);
  }
}

/**
 * @description Tmux session-name prefix that namespaces Claude's sessions on
 * the tmux server. The careful build/parse (negative chatId, strict per-half
 * regex) is shared with other tmux-driven backends in `utils/tmuxSessionName`;
 * these thin wrappers just bind the `'claude'` prefix.
 */
const claudeTmuxPrefix = 'claude';

/**
 * @description Tmux session name for a `ThreadKey`.
 *
 * Format: `claude-<chatId>-<threadId>`. Negative chat ids (forum supergroups
 * are negative) keep their minus sign — tmux session names accept it. The
 * format is `parse`-able back to `ThreadKey` via {@link parseTmuxSessionName}.
 */
function buildTmuxSessionName(key: ThreadKey): string {
  return buildTmuxSessionNameWithPrefix(claudeTmuxPrefix, key);
}

/**
 * @description Inverse of {@link buildTmuxSessionName}. Returns `null` for
 * names that don't match our format (e.g. unrelated tmux sessions a user
 * started by hand).
 *
 * Carefully handles negative chat ids: `claude--1001234-42` is `chatId=-1001234, threadId=42`.
 */
function parseTmuxSessionName(name: string): ThreadKey | null {
  return parseTmuxSessionNameWithPrefix(claudeTmuxPrefix, name);
}

/**
 * @description Validate a UUID-shaped session id before it ever reaches a
 * tmux command line. Defence-in-depth (audit S1): even though we now route
 * every tmux call through argv (no shell interpolation), the UUID is later
 * concatenated into the `shell-command` we hand to `tmux new-session`,
 * which tmux execs via `$SHELL -c`. If a non-UUID value ever sneaks in
 * (corrupted state.json, future user-facing `/resume <id>`), it would land
 * in that shell. Rejecting up front keeps the surface tight.
 */
function checkIsValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * @description Pure parser — pulls a `--session-id <uuid>` value out of a
 * claude command line. Lives outside the adapter class so it can be
 * unit-tested without booting tmux. Quoting in the input is flexible
 * because `pane_start_command` can come back as `--session-id 'uuid'`,
 * `--session-id "uuid"`, `--session-id=uuid`, or just `--session-id uuid`,
 * depending on how the original shell-command was assembled. Returns the
 * lowercase UUID, or `null` if no valid UUID is found.
 */
export function parseClaudeSessionIdFromCommand(cmd: string): string | null {
  if (!cmd) return null;
  // Lookahead refuses to truncate a 37+ char "UUID-like" garbage tail to
  // the first 36 chars: trailing hex must be followed by end-of-string,
  // whitespace, or a quote. Production input comes from our own
  // `pane_start_command`, but the anchor closes a defence-in-depth gap
  // against future call sites that may pass weirder strings.
  const match = cmd.match(/--session-id[\s'"=]+([0-9a-fA-F-]{36})(?=$|[\s'"])/);
  if (!match) return null;
  const uuid = match[1].toLowerCase();
  return checkIsValidUuid(uuid) ? uuid : null;
}

// The generic tmux primitives (`tmuxAsync`, `tmuxOrThrowAsync`,
// `checkArgsAreSafe`, `shellSingleQuote`, `execFilePromise`) now live in
// `utils/tmuxExec` (shared with the terminal backend). `tmuxAsync` is the only
// previously-exported one — re-exported below so its existing importers/tests
// keep resolving unchanged.
export { tmuxAsync };

// `convertAnsiToMarkdown`, `cleanOutput` (and the private `joinBrokenUrls`)
// moved to `utils/ansiClean` (shared with the terminal backend). Re-exported
// so the previously-exported names keep resolving for existing importers/tests.
export { convertAnsiToMarkdown, cleanOutput };

function normalizeToolCallLine(line: string): string {
  const trimmed = line.trim();
  const toolPattern = /^(Bash|Read|Write|Edit|Glob|Grep|Task|TodoWrite|WebFetch|WebSearch)\s*\(/i;
  const bulletToolPattern = /^([●○⏺])\s*(Bash|Read|Write|Edit|Glob|Grep|Task|TodoWrite|WebFetch|WebSearch)\s*\(/i;

  const bulletMatch = trimmed.match(bulletToolPattern);
  if (bulletMatch) {
    const bullet = bulletMatch[1];
    const rest = trimmed.slice(bulletMatch[1].length).trimStart();
    const icon = bullet === '●' || bullet === '⏺' ? '⏳' : '✓';
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
export function checkIsStatusOutput(text: string): boolean {
  // The thinking-`short` collapse line the router emits ("💭 thought for {N}s" /
  // "💭 думал {N} с", S5) is a DELIBERATE permanent artifact. Its short,
  // glyph-led, sentence-less shape otherwise trips the heuristics below (and the
  // EN form the `thought for \d` rule), so a standalone collapse chunk would be
  // folded into the ephemeral status frame and lost. The 💭 marker is the bot's
  // own collapse glyph — treat it as real permanent content.
  if (text.trimStart().startsWith('💭')) return false;

  // A lone file-diff `NN +` change gutter (`40 +`, `3 +delta`) is PERMANENT
  // output, not a transient spinner — its short, glyph-less shape otherwise
  // trips the heuristics below and folds it into the ephemeral status frame, so
  // it is never RECORDED into the relay window and its later re-render leaks
  // unguarded (live diff-line leak 2026-06-24). Treating it as real output sends
  // it down the `record` path so the re-render dedup (recentRelayWindow's
  // `NN +`-gutter bypass) can suppress the repaint. Anchored to the gutter shape
  // — `+1 done`, `3 lines changed`, `done` all stay status-eligible.
  const gutterLines = text.split('\n').filter(line => line.trim() !== '');
  if (gutterLines.length > 0 && gutterLines.every(line => DIFF_CHANGE_GUTTER_RE.test(line))) {
    return false;
  }

  // Real content is always substantial
  if (text.length > 200) return false;

  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return false;
  // Many non-empty lines = real content
  if (lines.length > 3) return false;

  return lines.every(line => {
    const trimmed = line.trim();
    // The ANSWER bullet `●`/`⏺` followed by text is real OUTPUT, never a spinner —
    // it is Claude's assistant-output marker, NOT a liveness glyph (the liveness
    // set is `✻✽✶✢·*○`). Lumping it in with the spinner glyphs made a fully short
    // answer like `● DONE` read as a glyph-led status frame and vanish entirely
    // (live bug 2026-06-24). A bare bullet with no text stays status-eligible.
    if (/^[●⏺]\s+\S/.test(trimmed)) return false;
    // Tree structure / subagent progress lines (├─, └─, │, ─)
    if (/^[├└│─]/.test(trimmed)) return true;
    // Contains unicode ellipsis — universal spinner/progress indicator ("Nesting…", "Reading…", "Simmering…")
    if (/…/.test(trimmed)) return true;
    // Contains progress stats: time patterns (3m 36s), token counts (↓ 12.2k tokens), thought duration
    if (/\d+[smh]\b.*[·↓]|↓\s*[\d.]+k?\s*tokens|thought for \d/i.test(trimmed)) return true;
    // A short answer fragment that ends a sentence ("Done.", "OK.", "Found 3
    // bugs.") is real content, not a spinner — spinners always carry a `…`, a
    // glyph, or token stats (caught above). Don't swallow it into a status.
    const isShortSentence = /[а-яёa-z]{2,}/i.test(trimmed) && /[.!?]$/.test(trimmed);
    if (isShortSentence) return false;
    // Two or more significant words (3+ letters each) ANYWHERE = real prose, not a
    // spinner icon. The words need NOT be adjacent — a short filler word / digits /
    // punctuation between them (e.g. «Итог ПО миксу», "Решение ЗА тобой") must not
    // defeat the count (live bug 2026-06-24: the old adjacency requirement read a
    // real 3-word heading as word-less → status → swallowed). The glyph/`…`/stats/
    // tree STATUS checks above run FIRST, so a genuine `✻ Compacting conversation…`
    // (2 real words but `…`-bearing AND glyph-led) still reads as status.
    const significantWordCount = (trimmed.match(/[а-яёa-z]{3,}/gi) ?? []).length;
    if (significantWordCount >= 2) return false;
    // A short line with no sentence-like structure and < 2 real words — a lone
    // spinner/icon/stat fragment.
    if (trimmed.length < 40) return true;
    return false;
  });
}

/**
 * @description A single interactive question Claude scraped from the pane,
 * rendered for durable delivery.
 */
export interface ClaudeQuestion {
  /**
   * Header + every numbered option (highlighted one kept), each followed by
   * its indented description sub-line(s) when the TUI shows any, ready to send.
   */
  text: string;
  /**
   * Stable across cursor moves — the option-label set, ignoring which option
   * is currently highlighted. Two `❯`-cursor positions over the same options
   * yield the same signature, so the bot delivers the question once.
   */
  signature: string;
}

/** One option scraped from the pane, with its attached description sub-lines. */
interface ScrapedQuestionOption {
  highlighted: boolean;
  number: string;
  label: string;
  descriptionLines: string[];
}

/** Box-drawing chars Claude's TUI wraps option/question lines in. */
const QUESTION_BORDER_REGEX = /^[│┃]\s?|\s*[│┃]\s*$/g;
/** Numbered option line, optionally cursor-highlighted, optionally boxed. */
const QUESTION_OPTION_REGEX = /^(❯\s*)?(\d{1,2})[.)]\s+(\S.*?)\s*$/;
/** Lines that are pure chrome (borders / blanks / nav hints), never prose. */
const QUESTION_CHROME_REGEX =
  /^[╭╮╰╯┌┐└┘├┤┬┴┼─━│┃\s]*$|Enter to select|esc to|↑↓|↑\/↓|to cycle|shift\+tab|to confirm|to submit|use arrow/i;
/**
 * The "Notes: press n to add notes" affordance the side-by-side
 * AskUserQuestion layout renders under the preview pane. Terminal-only (a
 * Telegram user cannot press `n`), so it is question chrome on the scrape
 * side AND dropped on the output side. ANCHORED whole-line (live leak msg
 * 23990, 2026-06-10: it reached Telegram as naked text when the selector
 * frame fell through to the plain-output path) — prose merely mentioning the
 * phrase mid-sentence must survive.
 */
const QUESTION_NOTES_HINT_REGEX = /^\s*Notes: press n to add notes\s*$/i;
/**
 * The UNNUMBERED "Chat about this" meta-row of the side-by-side
 * AskUserQuestion layout (the single-column variant numbers it as a real
 * option, e.g. `5. Chat about this`, which this regex deliberately does NOT
 * match). A Telegram user gets the same affordance by simply typing free text
 * (which breaks out of the selector as a fresh turn), so the row is chrome,
 * not an option. ANCHORED whole-line, optional `❯` cursor — a prose sentence
 * containing the phrase must survive.
 */
const QUESTION_CHAT_ABOUT_REGEX = /^\s*(?:❯\s*)?Chat about this\s*$/i;
/** A positive "this is an interactive prompt" signal near the option group. */
const QUESTION_SELECT_HINT_REGEX = /Enter to select|to select|↑↓|↑\/↓|use arrow|esc to/i;
const QUESTION_MIN_OPTIONS = 2;
/**
 * Consecutive poll diffs with NO selector detected before a pending question is
 * treated as resolved (`questionGone`). 2 = ignore a single transient scrape
 * miss while the selector is still repainting; a genuine resolve stays absent
 * across successive diffs. See {@link ClaudeSession.questionAbsentPolls}.
 */
const questionAbsentPollThreshold = 2;
/** How far below the last option to look for the "Enter to select" hint. */
const QUESTION_HINT_LOOKAHEAD = 4;
/**
 * How far above a non-option line to look for another option when deciding
 * whether the option group is still open. Real prompts interleave options
 * with indented description sub-lines and full-width `────` separators (e.g.
 * AskUserQuestion: option → description → option, or option → separator →
 * option); a small look-back spans those gaps without merging an unrelated
 * numbered list that sits further up the pane.
 */
const QUESTION_OPTION_LOOKBACK = 4;
/**
 * Box corner chars. The upward option-group walk stops at a box edge so a
 * numbered list in prose sitting just above the box can't merge into the
 * options — the box top border separates the prompt from preceding prose.
 */
const QUESTION_BOX_EDGE_REGEX = /[╭╮╰╯]/;

/**
 * Every box-drawing glyph a right-hand preview pane can put ON an option line
 * in the side-by-side AskUserQuestion layout (options column left, per-option
 * `preview` snippet boxed right):
 *
 *   ❯ 1. winston   ┌────────────────────────────┐
 *     2. pino      │ import winston from '…';   │
 *     3. console   │                            │
 *                  └────────────────────────────┘
 *
 * An option line is CUT at the first of these glyphs and only the left part
 * is parsed — covers sharp AND rounded corner families plus double-line
 * variants defensively (live bug #9, msg 23990 2026-06-10: unparsed preview
 * fragments polluted the labels / broke extraction and the question reached
 * Telegram with ZERO options). Single-column frames carry none of these
 * glyphs on option lines after {@link stripQuestionBoxBorder}, so the cut is
 * a no-op there.
 */
const PREVIEW_BOX_GLYPH_CLASS = '┌┐└┘├┤┬┴┼─━│┃╭╮╰╯╔╗╚╝║═';
const PREVIEW_BOX_GLYPH_REGEX = new RegExp(`[${PREVIEW_BOX_GLYPH_CLASS}]`);
/** A line whose first non-space char is a box glyph = right-column preview content, never an option/description. */
const PREVIEW_PANE_FRAGMENT_REGEX = new RegExp(`^[${PREVIEW_BOX_GLYPH_CLASS}]`);

/**
 * The ANSI-bold artifact `cleanOutput` leaves on the ❯-highlighted option of
 * the side-by-side layout: the TUI bolds ` winston` (space included), and the
 * bold→`*…*` conversion trims the span, yielding `❯ 1.*winston*` — no space
 * after the dot, so {@link QUESTION_OPTION_REGEX} missed the line, the cursor
 * was "gone", and the whole frame fell through to the plain-output path (the
 * live zero-options leak, msg 23990 2026-06-10). Normalised back to
 * `❯ 1. winston`. ANCHORED start-to-end: the whole remainder after `N.` must
 * be ONE `*…*` span, so prose like `1.5 *important* note` can never match.
 */
const HIGHLIGHTED_OPTION_BOLD_ARTIFACT_REGEX = /^(❯\s*)?(\d{1,2})([.)])\s*\*([^*]+)\*$/;

/**
 * How far below the last option to look for the strong `Enter to select`
 * footer when the layout is POSITIVELY identified as side-by-side (an option
 * line carried a preview-box fragment). The preview pane + the "Notes:" line
 * + separator + "Chat about this" sit between the options and the footer, so
 * the normal {@link QUESTION_HINT_LOOKAHEAD} cannot reach it. Only applied to
 * side-by-side frames and only with the strong phrase — a prose numbered list
 * has no box fragments on its lines, so this never widens the prose gate.
 */
const SIDE_BY_SIDE_FOOTER_LOOKAHEAD = 20;
/** The strong footer anchor required within the extended side-by-side window. */
const QUESTION_FOOTER_STRONG_REGEX = /Enter to select/i;

/** Minimum leading-space width for a sub-line to count as an option's description. */
const QUESTION_DESCRIPTION_MIN_INDENT = 4;
/** How far below the LAST option to collect its trailing description sub-lines. */
const QUESTION_DESCRIPTION_TRAILING_LOOKAHEAD = 3;

/**
 * Header walk caps. A permission prompt's action box (`Bash command` + the
 * command + a one-line description, or `Edit file …` + a diff) sits above the
 * question line; the header walk now climbs through it (spanning blank lines)
 * up to the box boundary. SCAN_LIMIT bounds the upward climb itself (runaway
 * guard on a malformed pane); MAX_LINES/MAX_CHARS bound the RELAYED text — over
 * the cap, {@link truncateQuestionHeader} keeps the identifying TOP and the
 * question line at the BOTTOM and drops the middle. A Bash command is well
 * under the cap → never truncated.
 */
const QUESTION_HEADER_SCAN_LIMIT = 200;
const QUESTION_HEADER_MAX_LINES = 26;
const QUESTION_HEADER_MAX_CHARS = 2000;
const QUESTION_HEADER_HEAD_LINES = 16;
const QUESTION_HEADER_TAIL_LINES = 6;
const QUESTION_HEADER_TRUNCATION_MARKER = '… (truncated — see terminal)';
/**
 * AskUserQuestion category tab marker (`☐ Foo` / `☑ Bar`) — chrome that sits
 * above the question line; a boundary for the header walk so it is never
 * relayed (the side-by-side `☐` no-leak test). Anchored at line start.
 */
const QUESTION_TAB_MARKER_REGEX = /^[☐☑]/;

function stripQuestionBoxBorder(line: string): string {
  return line.replace(QUESTION_BORDER_REGEX, '');
}

/**
 * Bound an over-long captured header (an oversized Edit/Write diff box): keep
 * the head (title + first lines — the most identifying part) and the tail (the
 * question line sits at the bottom of the header), drop the middle behind one
 * marker. A within-budget header passes through unchanged.
 */
function truncateQuestionHeader(headerLines: string[]): string[] {
  const totalChars = headerLines.reduce((sum, line) => sum + line.length + 1, 0);
  if (headerLines.length <= QUESTION_HEADER_MAX_LINES && totalChars <= QUESTION_HEADER_MAX_CHARS) {
    return headerLines;
  }
  return [
    ...headerLines.slice(0, QUESTION_HEADER_HEAD_LINES),
    QUESTION_HEADER_TRUNCATION_MARKER,
    ...headerLines.slice(-QUESTION_HEADER_TAIL_LINES),
  ];
}

/**
 * The left-column part of a side-by-side line: everything before the first
 * preview-box glyph, trailing padding dropped. A line without box glyphs
 * (single-column layout) passes through unchanged.
 */
function getPreviewPaneCutLeftPart(line: string): string {
  const cutIndex = line.search(PREVIEW_BOX_GLYPH_REGEX);
  return (cutIndex === -1 ? line : line.slice(0, cutIndex)).trimEnd();
}

/**
 * Normalise a line for option matching: cut the right-hand preview-box
 * fragment (side-by-side layout), then undo the highlighted-label bold
 * artifact. A single-column line passes through unchanged.
 */
function getOptionLineCandidate(line: string): string {
  return getPreviewPaneCutLeftPart(line).replace(
    HIGHLIGHTED_OPTION_BOLD_ARTIFACT_REGEX,
    '$1$2$3 $4',
  );
}

function checkIsOptionLine(line: string): boolean {
  return QUESTION_OPTION_REGEX.test(getOptionLineCandidate(line));
}

function getLineIndentWidth(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Whether a (border-stripped, untrimmed) line is an option's indented
 * description sub-line. Conservative on purpose: must be non-blank, not
 * question chrome, not right-column preview content, not itself an option,
 * and indented at least {@link QUESTION_DESCRIPTION_MIN_INDENT} — the TUI
 * indents descriptions under their option label.
 */
function checkIsOptionDescriptionLine(borderStrippedLine: string): boolean {
  const trimmed = borderStrippedLine.trim();
  if (trimmed === '') return false;
  if (checkIsQuestionChrome(trimmed)) return false;
  if (PREVIEW_PANE_FRAGMENT_REGEX.test(trimmed)) return false;
  if (checkIsOptionLine(trimmed)) return false;
  return getLineIndentWidth(borderStrippedLine) >= QUESTION_DESCRIPTION_MIN_INDENT;
}

/** Whether another option line sits within {@link QUESTION_OPTION_LOOKBACK} lines above `index`. */
function checkHasOptionAbove(lines: string[], index: number): boolean {
  const top = Math.max(0, index - QUESTION_OPTION_LOOKBACK);
  for (let i = index - 1; i >= top; i--) {
    if (checkIsOptionLine(lines[i])) return true;
  }
  return false;
}

function checkIsQuestionChrome(line: string): boolean {
  return (
    QUESTION_CHROME_REGEX.test(line) ||
    QUESTION_NOTES_HINT_REGEX.test(line) ||
    QUESTION_CHAT_ABOUT_REGEX.test(line)
  );
}

/**
 * @description Detect + extract the active interactive question/choice block
 * from the FULL Claude pane, returning a durable rendering and a
 * cursor-invariant signature, or `null` when the pane isn't confidently
 * showing a question.
 *
 * Operates on the whole pane (not a poll diff) on purpose: moving the `❯`
 * cursor repaints only the two changed option lines, so a signature taken
 * from the diff would be a partial option set and wouldn't match the full
 * box — the de-dup would fail and every keystroke would re-spam the thread.
 * Reading the full option group makes the signature stable across cursor
 * moves. We take the LAST option group (the active prompt sits at the bottom
 * of the pane) and the header line(s) just above it.
 *
 * Conservative (plan §2026-05-30 / S2): requires a `❯` cursor on an option
 * OR an "Enter to select"-style hint right below the group — a plain numbered
 * list in prose has neither, so it returns `null` and falls through to the
 * normal output path. The `❯`-highlighted option text is preserved (the old
 * `stripTuiElements` path discarded every `^❯` line, losing the selection).
 *
 * Two layouts (plan §2026-06-09 question-ux / S4):
 *  - single-column — options with optional indented description sub-lines,
 *    which are ATTACHED to their option in the rendering (S1: previously
 *    discarded);
 *  - side-by-side (options WITH `preview` content) — each option line carries
 *    a right-hand preview-box fragment that is CUT off; the preview body is
 *    deliberately NOT relayed (Telegram gets labels + descriptions, the
 *    preview is a TUI-only nicety). See {@link PREVIEW_BOX_GLYPH_CLASS} and
 *    {@link HIGHLIGHTED_OPTION_BOLD_ARTIFACT_REGEX} for the live bug both
 *    rules close.
 */
export function extractClaudeQuestion(text: string): ClaudeQuestion | null {
  const borderStrippedLines = text.split('\n').map(line => stripQuestionBoxBorder(line));
  const lines = borderStrippedLines.map(line => line.trim());

  // Bottom-most option line anchors the active prompt (it sits at the pane
  // bottom). The option run is NOT contiguous — descriptions / separators sit
  // between options — so walk up spanning any non-option line while another
  // option is still within reach above; stop once it isn't (that's the header).
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (checkIsOptionLine(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    if (checkIsOptionLine(lines[i])) {
      start = i;
      continue;
    }
    if (QUESTION_BOX_EDGE_REGEX.test(lines[i])) break;
    if (!checkHasOptionAbove(lines, i)) break;
  }

  // Collect options AND their indented description sub-lines (S1: the old
  // flat `.filter(checkIsOptionLine)` discarded descriptions). A description
  // attaches only while DIRECTLY under its option (or a previous description
  // line of the same option) — chrome / separators / preview fragments end
  // the run, so an indented stray further down can never mis-attach.
  const options: ScrapedQuestionOption[] = [];
  let isSideBySideLayout = false;
  let isDirectlyUnderOption = false;
  for (let i = start; i <= end; i++) {
    const match = getOptionLineCandidate(lines[i]).match(QUESTION_OPTION_REGEX);
    if (match) {
      isSideBySideLayout = isSideBySideLayout || PREVIEW_BOX_GLYPH_REGEX.test(lines[i]);
      options.push({
        highlighted: Boolean(match[1]),
        number: match[2],
        label: match[3].trim(),
        descriptionLines: [],
      });
      isDirectlyUnderOption = true;
      continue;
    }
    if (isDirectlyUnderOption && checkIsOptionDescriptionLine(borderStrippedLines[i])) {
      // The cut keeps a description clean if a right-column preview fragment
      // rides the same row (side-by-side); single-column lines are unchanged.
      options[options.length - 1].descriptionLines.push(getPreviewPaneCutLeftPart(lines[i]));
      continue;
    }
    isDirectlyUnderOption = false;
  }
  if (options.length < QUESTION_MIN_OPTIONS) return null;

  // The LAST option's description sub-line(s) sit BELOW `end`; collect the
  // directly-adjacent qualifying run (bounded, stops at the first blank /
  // chrome / preview-fragment line).
  const trailingLimit = Math.min(lines.length - 1, end + QUESTION_DESCRIPTION_TRAILING_LOOKAHEAD);
  for (let i = end + 1; i <= trailingLimit; i++) {
    if (!checkIsOptionDescriptionLine(borderStrippedLines[i])) break;
    options[options.length - 1].descriptionLines.push(getPreviewPaneCutLeftPart(lines[i]));
  }

  // Positive interactive signal, or it's not a real choice prompt.
  const hasCursor = options.some(option => option.highlighted);
  if (!hasCursor) {
    const tail = lines.slice(end + 1, end + 1 + QUESTION_HINT_LOOKAHEAD).join('\n');
    if (!QUESTION_SELECT_HINT_REGEX.test(tail)) {
      // Side-by-side only: the preview pane pushes the footer beyond the
      // normal lookahead (e.g. the cursor sits on the unnumbered "Chat about
      // this" meta-row, so no option is highlighted). Demand the STRONG
      // footer phrase within the extended window; never applied to frames
      // without preview fragments, so the prose gate stays as tight as before.
      if (!isSideBySideLayout) return null;
      const extendedTail = lines
        .slice(end + 1, end + 1 + SIDE_BY_SIDE_FOOTER_LOOKAHEAD)
        .join('\n');
      if (!QUESTION_FOOTER_STRONG_REGEX.test(extendedTail)) return null;
    }
  }

  // Header: skip the blank gap directly above the options, then climb to the
  // box boundary collecting every prose line. A permission prompt's action box
  // (`Bash command` + the command + a one-line description) sits ABOVE a blank
  // line that separates it from `Do you want to proceed?`, so the walk must
  // SPAN whitespace-only chrome (kept as a blank separator) and stop only at
  // NON-blank chrome — the full-width `────` divider (current layout) or a
  // `╭│` box border (Edit/older layout) — which bounds the box and keeps the
  // transcript prose above it out (regression-guarded by the `codebase` /
  // `alpha.ts` no-leak tests). Bounded by QUESTION_HEADER_MAX_LINES so a
  // malformed pane can't climb the whole scrollback.
  let h = start - 1;
  while (h >= 0 && checkIsQuestionChrome(lines[h])) h--;
  const headerLines: string[] = [];
  while (h >= 0 && !checkIsOptionLine(lines[h]) && headerLines.length < QUESTION_HEADER_SCAN_LIMIT) {
    const line = lines[h];
    // AskUserQuestion category tab (`☐ Foo`) is chrome above the question — a
    // boundary, never relayed.
    if (QUESTION_TAB_MARKER_REGEX.test(line)) break;
    if (checkIsQuestionChrome(line)) {
      // Non-blank chrome (divider / box border / nav hint) is the box edge.
      if (line !== '') break;
      // Blank line inside the box — keep it as a separator and keep climbing.
      headerLines.unshift(line);
      h--;
      continue;
    }
    headerLines.unshift(line);
    h--;
  }

  const header = truncateQuestionHeader(headerLines).join('\n').trim();
  // Descriptions render indented under their option label, mirroring the
  // OpenCode question body (`buildQuestionBodyLines`).
  const renderedOptions = options
    .map(option => {
      const optionLine = `${option.highlighted ? '❯' : ' '} ${option.number}. ${option.label}`;
      const descriptionLines = option.descriptionLines.map(line => `   ${line}`);
      return [optionLine, ...descriptionLines].join('\n');
    })
    .join('\n');
  // Labels only — descriptions and the cursor stay out so the signature is
  // stable across cursor moves and description repaints (de-dup holds).
  const signature = options.map(option => `${option.number}.${option.label}`).join('|');

  return {
    text: header ? `${header}\n\n${renderedOptions}` : renderedOptions,
    signature,
  };
}

/** Whether `text` is confidently showing an interactive question/choice block. */
export function checkIsClaudeQuestionBlock(text: string): boolean {
  return extractClaudeQuestion(text) !== null;
}

/**
 * @description Classify a user reply sent WHILE a selector is on screen. A
 * "control" reply is meant to drive the selector in place — a bare option
 * number (1–2 digits) or a single `y`/`n` — so it must be typed straight into
 * the TUI with no Escape. Anything else (a sentence, a new instruction) is a
 * free-form message: the bot first sends Escape to cancel the selector, then
 * forwards it as a fresh turn. Kept pure + exported so the routing decision is
 * unit-testable without a live tmux session.
 */
export function checkIsSelectorControlReply(text: string): boolean {
  const trimmed = text.trim();
  return /^\d{1,2}$/.test(trimmed) || /^[yYnN]$/.test(trimmed);
}

/**
 * @description A Claude CLI bare-digit survey scraped from the pane, ready for
 * answerable delivery. Distinct from {@link ClaudeQuestion} (a real
 * AskUserQuestion box): a survey is a fixed-shape one-keystroke prompt.
 */
export interface ClaudeSurvey {
  /** Header line, e.g. `How is Claude doing this session?`. */
  header: string;
  /** Options parsed from the inline `N: Label` row, in display order. */
  options: ClaudeSurveyOption[];
  /**
   * Stable signature derived ONLY from header + option digits/labels — NOTHING
   * volatile (no spinner glyph, no elapsed time, no surrounding pane). So the
   * same survey across polls yields an identical signature → the bot emits it
   * exactly once (mirrors {@link ClaudeQuestion.signature}).
   */
  signature: string;
}

/**
 * @description The KNOWN survey header texts — a CLOSED alternation (a future
 * rewording becomes variant #3 here), matched ANCHORED start-to-end of a line
 * (after an optional leading `●`/`⏺` assistant bullet, before an optional
 * trailing ` (optional)`), NEVER as a substring. The matched header text is
 * captured (group 1) and feeds the survey's `header` + `signature`, so two
 * variants never share a signature.
 *
 * WHY anchored, not substring: an earlier substring matcher false-fired on a
 * user message that merely QUOTED the survey text in prose — it spammed the
 * live topic with bogus surveys + duplicates. The header MUST be the WHOLE
 * line, so a header embedded mid-sentence can never match. Do NOT loosen this
 * to an open-ended `How .* Claude` prose pattern.
 *
 * WHY an alternation: Claude Code ≥2.1.19x reworded the survey ("How well is
 * Claude following the instructions…") — the old exact-header match never
 * fired, the undetected survey sat on the pane and SWALLOWED the Enter of the
 * next forwarded prompt: the text stranded unsubmitted in the TUI input box
 * and the topic looked hung for hours (live 2026-07-02, topic 39933).
 */
const CLAUDE_SURVEY_HEADER_REGEX =
  /^\s*[●⏺]?\s*(How is Claude doing this session\?|How well is Claude following the instructions you gave earlier in this conversation\?)(\s*\(optional\))?\s*$/;
/**
 * The inline option row: `N: Label  N: Label …` — every token is
 * `digit: word`, ≥2 of them, and the WHOLE line is option tokens (anchored),
 * so a prose line that merely contains `1: foo` can't pass.
 */
const CLAUDE_SURVEY_OPTION_ROW_REGEX = /^\s*(\d+:\s*[A-Za-z]+\s*)+$/;
/** Pulls each `digit: label` pair out of a validated option row. */
const CLAUDE_SURVEY_OPTION_TOKEN_REGEX = /(\d+):\s*([A-Za-z]+)/g;
const CLAUDE_SURVEY_MIN_OPTIONS = 2;

/**
 * @description AIRTIGHT detector for the Claude CLI bare-digit survey. Returns
 * a survey ONLY when BOTH hold:
 *
 *   1. Some line, after stripping an optional leading `● ` bullet, matches
 *      {@link CLAUDE_SURVEY_HEADER_REGEX} ANCHORED start-to-end (the WHOLE
 *      line) — so a header quoted mid-sentence is rejected.
 *   2. The IMMEDIATELY-FOLLOWING non-empty line is an inline option row
 *      ({@link CLAUDE_SURVEY_OPTION_ROW_REGEX}) parsing to ≥2 options.
 *
 * Kept fully SEPARATE from {@link extractClaudeQuestion} (the per-line
 * AskUserQuestion selector): this is a lighter fixed-shape prompt. The
 * signature is header + the option digits/labels only (no volatile chrome), so
 * the same survey across polls de-dups to a single emit.
 */
export function extractClaudeSurvey(text: string): ClaudeSurvey | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const headerMatch = CLAUDE_SURVEY_HEADER_REGEX.exec(lines[i]);
    if (!headerMatch) continue;

    // The option row is the IMMEDIATELY-following non-empty line — skip only
    // blank lines, never prose. If the next content line isn't an option row,
    // this is not a survey (the header was probably quoted in prose).
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j >= lines.length) return null;
    if (!CLAUDE_SURVEY_OPTION_ROW_REGEX.test(lines[j])) return null;

    const options: ClaudeSurveyOption[] = [];
    for (const match of lines[j].matchAll(CLAUDE_SURVEY_OPTION_TOKEN_REGEX)) {
      options.push({ digit: match[1], label: match[2] });
    }
    if (options.length < CLAUDE_SURVEY_MIN_OPTIONS) return null;

    const header = headerMatch[1];
    const signature = `${header}::${options
      .map(option => `${option.digit}:${option.label}`)
      .join('|')}`;
    return { header, options, signature };
  }
  return null;
}

/** Whether `text` is confidently showing a Claude CLI bare-digit survey. */
export function checkIsClaudeSurvey(text: string): boolean {
  return extractClaudeSurvey(text) !== null;
}

/**
 * @description Whether the poll loop should AUTO-DISMISS the survey on screen
 * this poll (S4). True only when a survey is present AND its signature differs
 * from the one we last dismissed — the survey repaints every poll, so the
 * signature dedup makes us send the dismiss keystroke exactly ONCE per
 * appearance, and re-dismiss a genuinely new survey later (the caller clears the
 * stored signature when the survey leaves the pane). Pure + exported so the
 * once-per-appearance rule is unit-testable without a live session.
 */
export function checkShouldDismissSurvey(
  surveySignature: string | null,
  lastDismissedSignature: string,
): boolean {
  return surveySignature !== null && surveySignature !== lastDismissedSignature;
}

/**
 * @description Drop the survey's header + option-row lines from a relay chunk
 * (S4) so the auto-dismissed survey's chrome never leaks into the topic — those
 * lines match no tool/spinner/chrome rule and would otherwise classify as prose
 * and post as a stray message. The CALLER gates this on a survey actually being
 * detected on the pane this poll, so a legitimate "1: Yes  2: No" list in normal
 * agent output is never stripped. Pure + exported for unit testing.
 */
export function stripSurveyChromeLines(text: string): string {
  return text
    .split('\n')
    .filter(
      (line) =>
        !CLAUDE_SURVEY_HEADER_REGEX.test(line) && !CLAUDE_SURVEY_OPTION_ROW_REGEX.test(line),
    )
    .join('\n');
}

/**
 * @description One ordered tmux send-keys step the adapter will enqueue for a
 * {@link ClaudeCliAdapter.sendInput} call. Extracted as a pure plan so the
 * "no Enter" decision is unit-testable WITHOUT a live tmux session.
 *
 *  - `literal`       — `send-keys -l <input>` (the typed text, literal bytes);
 *  - `instantEnter`  — `send-keys Enter` immediately (short control reply);
 *  - `slashEnter`    — `send-keys Enter` deferred so the slash-popup settles;
 *  - `verifiedEnter` — `send-keys Enter` deferred past the paste-aggregation
 *    window, plus a post-Enter unsubmitted re-check (a plain prompt).
 */
export type ClaudeSendKeyStep = 'literal' | 'instantEnter' | 'slashEnter' | 'verifiedEnter';

/**
 * @description Pure plan of the tmux send-keys steps for one `sendInput` call.
 *
 * Mirrors the three historical Enter branches (bare slash command → deferred
 * Enter; short control reply → instant Enter; plain prompt → paste-race
 * deferred Enter + verification). When `appendEnter === false` ONLY the literal
 * keystrokes are sent — every Enter branch is skipped (for a keystroke that
 * auto-submits on its own). `appendEnter` defaults to `true`, so every existing
 * caller's plan is byte-for-byte unchanged.
 */
export function getClaudeSendKeysPlan(
  input: string,
  appendEnter: boolean,
): ClaudeSendKeyStep[] {
  const steps: ClaudeSendKeyStep[] = ['literal'];
  if (!appendEnter) return steps;

  if (checkIsBareSlashCommand(input)) {
    steps.push('slashEnter');
  } else if (input.length < CLAUDE_PASTE_RACE_MIN_LENGTH) {
    steps.push('instantEnter');
  } else {
    steps.push('verifiedEnter');
  }
  return steps;
}

/** Where a Claude text reply should be routed while a prompt may be on screen. */
export type ClaudeReplyRoute = 'selector' | 'loginPaste' | 'prompt';

/**
 * @description Decide how to route a user TEXT reply for a Claude thread,
 * given which interactive prompts are currently pending. Pure so the
 * precedence is unit-testable.
 *
 * Precedence (a real AskUserQuestion always wins):
 *   1. A selector (AskUserQuestion) pending + a bare control reply
 *      (digit / y / n) → `'selector'` (drive the menu in place).
 *   2. Else the `/login` "Paste code here" box is on screen → `'loginPaste'`:
 *      the OAuth code is a long free-form string, so route it VERBATIM into
 *      the box (see {@link checkIsClaudeLoginPaste}). Without this it falls to
 *      `'prompt'`, whose Escape cancels the login flow and whose preamble
 *      corrupts the code (live bug: "login can't be done via the bot").
 *   3. Else → `'prompt'` (a fresh turn; free-form prose breaks out of any
 *      pending prompt, mirroring the existing selector break-out behavior).
 *
 * Claude's native session SURVEY is NOT routed here: the adapter auto-dismisses
 * it (Escape) and never surfaces it to the user, so a bare digit typed during a
 * survey window falls through to `'prompt'` (or `'selector'` when a real
 * question is also up) — never silently dropped.
 */
export function getClaudeReplyRoute(input: {
  isQuestionPending: boolean;
  isLoginPastePending: boolean;
  text: string;
}): ClaudeReplyRoute {
  const isControlReply = checkIsSelectorControlReply(input.text);
  if (input.isQuestionPending && isControlReply) return 'selector';
  if (input.isLoginPastePending) return 'loginPaste';
  return 'prompt';
}

/**
 * @description Whether the captured pane shows Claude's `/login` OAuth
 * "paste the code" step. After the user picks a login method Claude prints a
 * sign-in URL and the input row `Paste code here if prompted >` (a plain `>`
 * box, NOT the `❯` prompt or a numbered selector), then waits for the pasted
 * `code#state` value. The marker string is stable (verified in the claude.exe
 * string table, 2026-06-13). Used by {@link ClaudeCliAdapter.isLoginPastePending}
 * so the bot routes the pasted code verbatim instead of as a fresh prompt.
 */
const CLAUDE_LOGIN_PASTE_RE = /Paste code here if prompted/;
/**
 * Lines from the pane BOTTOM that count as the live input region. The real
 * `/login` "paste code" prompt is the active bottom input row; matching the
 * marker anywhere in the full pane false-fired whenever this repo's OWN source
 * or docs (which quote the marker) rendered in a Claude TUI working on
 * telegramCode — the bot then ate the user's next message as a one-time login
 * code (live 2026-06-25, topic 434). Anchoring to the tail excludes scrollback
 * mentions while still catching a genuine login row.
 */
const loginPasteTailLineCount = 10;
export function checkIsClaudeLoginPaste(paneText: string): boolean {
  const tail = paneText.split('\n').slice(-loginPasteTailLineCount).join('\n');
  return CLAUDE_LOGIN_PASTE_RE.test(tail);
}

/**
 * A line-numbered diff row (`   88 + code`, `   90  context`, bare `   89`),
 * recognisable WITHOUT its tool header — the fallback for a diff that arrived
 * split from its header across two polls. Diff rows never occur in agent prose.
 */
const DIFF_ROW_RE = /^\s+\d+(?:\s|$)/;
/** Min consecutive diff rows for the header-less fallback to fence them. */
const DIFF_FALLBACK_MIN_ROWS = 2;

/**
 * @description Recognise the four line shapes of a markdown table that Claude's
 * TUI renders as a SHARP-corner box-drawing frame.
 *
 * WHY a dedicated detector: Claude's own UI **chrome** panels use ROUNDED
 * corners (`╭ ╮ ╰ ╯`) — exactly what the chrome-drop filters in
 * {@link stripTuiElementsWithContext} target by dropping any `│`/`─` line wider
 * than 50 chars. A rendered markdown **table** uses SHARP corners
 * (`┌ ┬ ┐ ├ ┼ ┤ └ ┴ ┘`), so a WIDE table body row (a long `│ … │`) was caught
 * by that same width filter and dropped — the "header survives, body rows lost"
 * bug (#10). Detecting sharp corners targets tables specifically and lets the
 * table-collecting branch run BEFORE the chrome filters, so table rows can
 * never be dropped while chrome (rounded) handling stays untouched.
 *
 * An optional leading `●/⏺ ` assistant bullet + indent is tolerated on the TOP
 * border (Claude prints the bullet on the table's first line).
 */
const SHARP_TABLE_TOP_RE = /^\s*[●⏺]?\s*┌[─┬]+┐\s*$/;
const SHARP_TABLE_BOTTOM_RE = /^\s*└[─┴]+┘\s*$/;
const SHARP_TABLE_SEPARATOR_RE = /^\s*├[─┼]+┤\s*$/;
const SHARP_TABLE_CONTENT_RE = /^\s*│.*│\s*$/;
/** Strip a leading `●/⏺ ` assistant bullet so the collected box indent is uniform. */
const ASSISTANT_BULLET_PREFIX_RE = /^(\s*)[●⏺]\s/;

/** True iff `line` is the TOP border of a sharp-corner (markdown) table. */
function checkIsSharpTableTop(line: string): boolean {
  return SHARP_TABLE_TOP_RE.test(line);
}

/** True iff `line` is the BOTTOM border of a sharp-corner (markdown) table. */
function checkIsSharpTableBottom(line: string): boolean {
  return SHARP_TABLE_BOTTOM_RE.test(line);
}

/**
 * True iff `line` is any line of a sharp-corner (markdown) table — top/bottom
 * border, a `├─┼─┤` separator, or a `│ … │` content row.
 */
function checkIsSharpTableLine(line: string): boolean {
  return (
    checkIsSharpTableTop(line) ||
    checkIsSharpTableBottom(line) ||
    SHARP_TABLE_SEPARATOR_RE.test(line) ||
    SHARP_TABLE_CONTENT_RE.test(line)
  );
}

function getLeadingSpaceCount(line: string): number {
  return line.match(/^(\s*)/)![1].length;
}

/** Strip the largest leading-whitespace prefix common to all non-blank lines. */
function getDedented(lines: string[]): string[] {
  const indents = lines.filter(line => line.trim()).map(getLeadingSpaceCount);
  if (indents.length === 0) return lines;
  const min = Math.min(...indents);
  return lines.map(line => line.slice(min));
}

/**
 * @description Wrap body lines in a ```` ``` ```` fence for `renderAgentHtml`
 * to turn into `<pre><code>`. Any run of 3+ backticks inside the body (e.g. a
 * diff of a markdown file with its own fences) is broken up with zero-width
 * spaces so it can't prematurely close our fence — the body is for reading,
 * not byte-exact copy.
 */
function getFenced(bodyLines: string[]): string[] {
  const safe = bodyLines.map(line =>
    line.replace(/`{3,}/g, run => run.split('').join('​')),
  );
  return ['```', ...safe, '```'];
}

/**
 * @description Per-session state for the streaming-table stabilizer (live
 * incident 2026-06-11, plan `2026-06-11-claude-wide-table-content-loss`): the
 * sharp-corner table block currently being held back, and how many polls it has
 * been held. Held back because a wide markdown table RE-FLOWS its column widths
 * as longer cells stream in, so every border/row line is byte-distinct between
 * layouts → {@link getNewPaneContent} (line-SET diff) classifies the whole table
 * "new" each poll and it would otherwise ship once per intermediate layout
 * (empty skeleton → 1 row → full). We withhold the table until it settles, then
 * emit the complete version exactly once.
 */
interface StreamingTableState {
  /** The full last-contiguous sharp-table block text seen on the previous poll. */
  block: string;
  /** Consecutive polls this table has been held without settling — runaway guard. */
  heldPolls: number;
}

/**
 * @description Hard cap on streaming-table hold polls. The normal exit is a
 * done-signal — real prose now follows the table, or the turn went idle (see
 * {@link getTableStabilizationDecision}); if a pane is stuck mid-paint and the
 * turn never resolves, force-emit the latest version after this many CONSECUTIVE
 * unchanged-block polls so the table can never be swallowed forever. At
 * {@link basePollIntervalMs} (300ms) this is ≈9s of an unchanging held block
 * before the safety fires — far longer than a real table takes to settle.
 */
const maxTableHoldPolls = 30;

/**
 * @description The action {@link getTableStabilizationDecision} tells the poll
 * loop to take for a re-flowing sharp-corner table.
 *
 * - `none`  — no table in flux; emit the poll's delta as usual.
 * - `hold`  — the table is still laying out; mask its lines out of this poll's
 *             delta ({@link maskSharpTableLines}) so no intermediate frame ships,
 *             and carry `nextStreamingTable` forward.
 * - `emit`  — the table is DONE (prose follows it / the turn went idle / the
 *             safety cap fired); emit `block` once via the normal fence path and
 *             clear the held state.
 */
interface TableStabilizationDecision {
  kind: 'none' | 'hold' | 'emit';
  /** The complete table block to emit, set only for `kind: 'emit'`. */
  block: string | null;
  /** Held state to store back on the session (null clears it). */
  nextStreamingTable: StreamingTableState | null;
}

/**
 * @description Locate the LAST contiguous sharp-corner (markdown) table block in
 * a pre-split pane snapshot: the block text plus the index of its LAST line, or
 * `null` when none is present. Mirrors the collection loop in
 * {@link stripTuiElementsWithContext} (a TOP border, then contiguous table lines
 * until the first non-table line, a BOTTOM border ending it inclusively). The
 * LAST block is taken because a streaming table sits at the bottom of the pane;
 * an already-finished earlier table was emitted on a prior poll. The end index
 * lets {@link checkHasContentAfterLastSharpTable} look at what follows the table
 * without re-scanning. Internal helper for the two callers below.
 */
function getLastSharpTableRange(lines: string[]): { block: string; endIndex: number } | null {
  let range: { block: string; endIndex: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!checkIsSharpTableTop(lines[i])) continue;
    const tableLines: string[] = [lines[i]];
    let endIndex = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (!checkIsSharpTableLine(lines[j])) break;
      tableLines.push(lines[j]);
      endIndex = j;
      if (checkIsSharpTableBottom(lines[j])) break;
    }
    range = { block: tableLines.join('\n'), endIndex };
    // Keep scanning: a later top border means a more recent table further down.
    i = endIndex;
  }
  return range;
}

/**
 * @description Find the LAST contiguous sharp-corner (markdown) table block in a
 * full pane snapshot, or `null` when none is present. Returns the raw block text
 * so the stabilizer can compare it across polls. Pure + exported for unit tests.
 */
export function getLastSharpTableBlock(content: string): string | null {
  return getLastSharpTableRange(content.split('\n'))?.block ?? null;
}

/**
 * @description Whether any REAL prose line follows the last sharp-corner table in
 * the pane — the "the table is done, content moved past it" signal the stabilizer
 * uses to emit the held table BEFORE that trailing prose (preserving order).
 *
 * Deliberately CONSERVATIVE (errs toward `false`): a line after the table counts
 * as content only when it is none of the recognised non-content shapes —
 * blank/whitespace, another sharp-table line, TUI chrome
 * ({@link checkIsClaudeChromeLine} — covers the `❯ …` input box and its `───`
 * rules, box-drawing borders, the `⏵⏵ bypass permissions…` footer, nav hints),
 * any progress/spinner/sub-agent frame ({@link checkIsProgressChunk} per line),
 * a live spinner tick ({@link SPINNER_TICK_RE}), a `✻ … for Ns` post-thinking
 * trailer ({@link POST_THINKING_TRAILER_RE}), or a `Thinking for Ns…` header
 * ({@link THINKING_HEADER_RE}). Reuses the SAME predicates the relay already
 * trusts as chrome — it never invents a looser matcher — so it cannot
 * false-positive on the input box / spinner / trailers (the failure mode that
 * would emit a table prematurely). The turn-idle signal and the hold safety cap
 * are the backstops when this stays `false`. Pure + exported for unit tests.
 */
export function checkHasContentAfterLastSharpTable(content: string): boolean {
  const lines = content.split('\n');
  const range = getLastSharpTableRange(lines);
  if (range === null) return false;
  for (let i = range.endIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (checkIsSharpTableLine(line)) continue;
    if (checkIsClaudeChromeLine(line)) continue;
    if (checkIsProgressChunk(line)) continue;
    if (SPINNER_TICK_RE.test(line)) continue;
    if (POST_THINKING_TRAILER_RE.test(line.trim())) continue;
    if (THINKING_HEADER_RE.test(line)) continue;
    // Survived every chrome predicate → a genuine prose line follows the table.
    return true;
  }
  return false;
}

/**
 * @description Drop every sharp-corner table line from a poll's delta text so a
 * mid-layout table frame never ships while the stabilizer is holding the table.
 * Only table-shaped lines are removed — surrounding prose streams as usual.
 * Pure + exported for unit tests.
 */
export function maskSharpTableLines(deltaText: string): string {
  return deltaText
    .split('\n')
    .filter(line => !checkIsSharpTableLine(line))
    .join('\n')
    .trim();
}

/**
 * @description Decide what the poll loop does with a re-flowing sharp-corner
 * table. A held table is emitted ONLY when the turn is genuinely DONE — never on
 * a mere "byte-stable for one poll", because Claude streams a table in stages and
 * briefly PAUSES at an intermediate row count (e.g. 4 rows), which is byte-stable
 * across a poll yet not the final table. The old "stable one poll → emit" rule
 * shipped that 4-row intermediate, then the table grew to 6 rows and shipped
 * again → the topic got two tables (live incident 2026-06-15). Pure + exported
 * for unit tests. Rules, in order:
 *
 *  1. no table in the pane: flush whatever was held, once (table scrolled away /
 *     message moved on); else no-op.
 *  2. real PROSE now follows the table (`hasContentAfterTable`) → the table is
 *     done; emit it BEFORE that trailing prose (the poll loop withholds the prose
 *     this tick), so ordering is table-then-prose.
 *  3. the turn is IDLE (`isTurnIdle`) → emit promptly (covers a table-only
 *     answer, which never gets trailing prose).
 *  4. otherwise HOLD — update the held block and advance `heldPolls` only while
 *     the block is unchanged (a changed/new block resets the counter); past
 *     {@link maxTableHoldPolls} force-emit so a never-settling pane can't swallow
 *     the table forever. A still-busy table is held even when byte-identical
 *     across polls — that is exactly the mid-stream pause.
 */
export function getTableStabilizationDecision(input: {
  currentTable: string | null;
  streamingTable: StreamingTableState | null;
  hasContentAfterTable: boolean;
  isTurnIdle: boolean;
}): TableStabilizationDecision {
  const { currentTable, streamingTable, hasContentAfterTable, isTurnIdle } = input;

  if (currentTable === null) {
    // RULE 1: the table left the pane — flush whatever was held, once.
    if (streamingTable) {
      return { kind: 'emit', block: streamingTable.block, nextStreamingTable: null };
    }
    return { kind: 'none', block: null, nextStreamingTable: null };
  }

  // RULE 2: real content follows the table → it is done; emit it BEFORE that
  // prose (the caller masks the prose out of this tick to keep ordering).
  if (hasContentAfterTable) {
    return { kind: 'emit', block: currentTable, nextStreamingTable: null };
  }

  // RULE 3: the turn finished → emit promptly (a table-only answer never gets
  // trailing prose, so this is its done-signal).
  if (isTurnIdle) {
    return { kind: 'emit', block: currentTable, nextStreamingTable: null };
  }

  // RULE 4: still mid-turn (incl. a byte-stable mid-stream pause) → HOLD. Advance
  // the runaway guard only while the block is unchanged; a changed block restarts
  // the count (it is actively re-flowing, give it the full budget).
  const sameBlock = streamingTable !== null && currentTable === streamingTable.block;
  const heldPolls = (sameBlock ? streamingTable.heldPolls : 0) + 1;
  if (heldPolls > maxTableHoldPolls) {
    // SAFETY: a pane stuck mid-paint must never swallow the table — ship the
    // latest version we have and clear, rather than holding indefinitely.
    return { kind: 'emit', block: currentTable, nextStreamingTable: null };
  }
  return { kind: 'hold', block: null, nextStreamingTable: { block: currentTable, heldPolls } };
}

/**
 * @description A status / summary line the TUI paints inside a tool-result
 * body that is chrome, not command output, and so must NEVER be fenced.
 * Narrowly anchored to the three confirmed literal shapes — extending this to
 * an arbitrary `…`-ending line would swallow real one-line stdout.
 */
function checkIsClaudeBodyStatusLine(line: string): boolean {
  return (
    TRANSIENT_TICK_RE.test(line) ||
    COLLAPSE_MARKER_RE.test(line) ||
    COMPLETION_SUMMARY_RE.test(line)
  );
}

/**
 * @description Split a tool-result body into the lines that should be fenced
 * (genuine stdout / diff / file content) and the status/summary lines that
 * must stay PLAIN. A {@link TRANSIENT_TICK_RE} tick (`Running…`/`Waiting…`)
 * followed by ANY real output line in the SAME body is stale — superseded by
 * the output the bot captured one frame later (the msg-20718 case) — so it is
 * DROPPED, not even kept plain. Other status/summary lines are kept and
 * returned in `plain` (emitted after the fence). Genuine content goes to
 * `fenced` untouched.
 */
function splitStatusLinesFromBody(bodyLines: string[]): {
  fenced: string[];
  plain: string[];
} {
  const hasRealOutput = bodyLines.some(line => !checkIsClaudeBodyStatusLine(line));
  const fenced: string[] = [];
  const plain: string[] = [];
  for (const line of bodyLines) {
    if (!checkIsClaudeBodyStatusLine(line)) {
      fenced.push(line);
      continue;
    }
    // Stale transient tick superseded by real output → drop it entirely.
    if (TRANSIENT_TICK_RE.test(line) && hasRealOutput) continue;
    plain.push(line);
  }
  return { fenced, plain };
}

/**
 * @description Fence a tool-result body while keeping its status/summary lines
 * (`Running…`, `… +N lines`, `Done (… tokens …)`) OUT of the fence as plain
 * text — see {@link splitStatusLinesFromBody}. Genuine content is dedented and
 * fenced; an empty-after-filtering body emits NO ```` ``` ```` fence. The
 * caller passes the already-dedented-and-prefixed body for the `output` kind
 * (the `⎿` line rides with it) so dedent is applied here over the full set.
 */
function getFencedBodyWithStatus(bodyLines: string[]): string[] {
  const { fenced, plain } = splitStatusLinesFromBody(bodyLines);
  const result: string[] = [];
  if (fenced.length > 0) result.push(...getFenced(getDedented(fenced)));
  result.push(...plain.map(line => line.trim()));
  return result;
}

/**
 * @description Wrap each code-producing tool's `⎿` result body in a code fence
 * (B2). Operates on the already echo-suppressed / chrome-filtered line array.
 * See {@link OUTPUT_TOOL_HEADER_RE} for the header→body classification.
 *
 * Stateful across the chunk AND across polls: a tool header sets the active
 * kind; a `⎿` result or its orphan indented continuation is fenced for that
 * kind; a solid non-tool line (prose, a `Thinking…` header) clears the kind so
 * thinking prose is never fenced. The kind is threaded across polls by the
 * caller — Claude's TUI redraws the whole pane each poll and the line-set diff
 * ({@link getNewPaneContent}) emits only NEW lines, so a slow command's output
 * (`yarn test`, a build) arrives in a later poll WITHOUT its `● Bash(…)` header
 * (suppressed as a duplicate). `incomingKind` carries the header poll's kind
 * forward; the returned `outgoingKind` is fed back next poll. This is tracked
 * via the clean emitted deltas, NOT by scanning the racy live pane (the spinner
 * repaints every tick, so a pane scan flickers between frames).
 *
 * An agent-authored ```` ``` ```` block is passed through untouched (and
 * suppresses the diff-row fallback inside it) so a real code block is never
 * double-wrapped.
 */
function fenceToolResultBodies(
  lines: string[],
  incomingKind: ToolResultKind | null = null,
): { out: string[]; outgoingKind: ToolResultKind | null } {
  const out: string[] = [];
  let inAgentFence = false;
  let currentKind: ToolResultKind | null = incomingKind;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (CODE_FENCE_LINE_RE.test(line)) {
      inAgentFence = !inAgentFence;
      out.push(line);
      i++;
      continue;
    }
    if (inAgentFence) {
      out.push(line);
      i++;
      continue;
    }

    if (OUTPUT_TOOL_HEADER_RE.test(line)) {
      currentKind = 'output';
      out.push(line);
      i++;
      continue;
    }
    if (FILE_TOOL_HEADER_RE.test(line)) {
      currentKind = 'file';
      out.push(line);
      i++;
      continue;
    }

    // Sub-agent task / compaction-bar progress lines: the bot collapses these,
    // so they must pass through un-fenced and they end any open tool body.
    if (PROGRESS_PASSTHROUGH_RE.test(line)) {
      currentKind = null;
      out.push(line);
      i++;
      continue;
    }

    const markerMatch = line.match(TOOL_RESULT_MARKER_RE);
    if (markerMatch) {
      if (currentKind === null) {
        // Unknown owner (e.g. a thinking `⎿` body) — leave it as prose.
        out.push(line);
        i++;
        continue;
      }
      const markerIndent = markerMatch[1].length;
      const body: string[] = [];
      let j = i + 1;
      while (
        j < lines.length &&
        lines[j].trim() !== '' &&
        getLeadingSpaceCount(lines[j]) > markerIndent
      ) {
        body.push(lines[j]);
        j++;
      }
      if (currentKind === 'output') {
        // `⎿`-content is stdout → drop the marker glyph (keep alignment), fence
        // it with the body, but keep any status/summary line plain (never fenced).
        out.push(...getFencedBodyWithStatus([line.replace('⎿', ' '), ...body]));
      } else {
        out.push(line); // summary line stays prose
        if (body.length > 0) out.push(...getFencedBodyWithStatus(body));
      }
      i = j;
      continue;
    }

    // Orphan indented continuation of a known tool body (header was in a prior
    // poll, or the `⎿` summary already streamed): fence the indented run.
    if (currentKind !== null && /^\s/.test(line) && line.trim() !== '') {
      const block: string[] = [];
      let j = i;
      while (
        j < lines.length &&
        lines[j].trim() !== '' &&
        /^\s/.test(lines[j]) &&
        !TOOL_RESULT_MARKER_RE.test(lines[j]) &&
        !CODE_FENCE_LINE_RE.test(lines[j])
      ) {
        block.push(lines[j]);
        j++;
      }
      out.push(...getFencedBodyWithStatus(block));
      i = j;
      continue;
    }

    // Header-less diff-row run (cross-poll split with no known kind): fence on shape.
    if (currentKind === null && DIFF_ROW_RE.test(line)) {
      const block: string[] = [];
      let j = i;
      while (j < lines.length && DIFF_ROW_RE.test(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      if (block.length >= DIFF_FALLBACK_MIN_ROWS) {
        out.push(...getFenced(getDedented(block)));
      } else {
        out.push(...block);
      }
      i = j;
      continue;
    }

    // Any solid prose line ends the tool context (blanks leave it intact).
    if (line.trim() !== '') currentKind = null;
    out.push(line);
    i++;
  }

  return { out, outgoingKind: currentKind };
}

/** The language tag of a fence-OPEN line (`` ```ts `` → `ts`, bare `` ``` `` → ''). */
function getFenceLanguage(fenceLine: string): string {
  return fenceLine.replace(/^\s*```/, '').trim();
}

/**
 * @description Merge two same-language fenced blocks separated by NOTHING but
 * blank line(s) into one continuous fence (#14). One logical tool output that
 * {@link fenceToolResultBodies} split into multiple `getFenced` runs renders as
 * two adjacent `<pre>` ({@link FENCE_REGEX} makes one per fence) — visually two
 * boxes for one output. A NON-blank line between the fences (a `● Bash(…)`
 * header, prose) BLOCKS the merge, so DIFFERENT tool calls stay separate; only
 * blank-separated same-language fences are joined, keeping one blank inside.
 * Languages must match (or both be empty) so a plain output block and a `ts`
 * block are never fused.
 */
export function mergeAdjacentFences(lines: string[]): string[] {
  const out: string[] = [...lines];
  let i = 0;
  while (i < out.length) {
    if (!CODE_FENCE_LINE_RE.test(out[i])) {
      i++;
      continue;
    }
    // `out[i]` opens a fence; find its closing delimiter.
    const closeIndex = findFenceClose(out, i);
    if (closeIndex === -1) break; // unbalanced — leave the tail untouched
    const nextOpenIndex = getNextOpenAfterBlanks(out, closeIndex + 1);
    if (
      nextOpenIndex !== -1 &&
      getFenceLanguage(out[nextOpenIndex]) === getFenceLanguage(out[i])
    ) {
      // Drop the close + the re-open, keep a single blank line between bodies.
      out.splice(closeIndex, nextOpenIndex - closeIndex + 1, '');
      continue; // re-test from the SAME open fence (a third block may follow)
    }
    i = closeIndex + 1;
  }
  return out;
}

/** Index of the fence-CLOSE delimiter that matches the OPEN at `openIndex`. */
function findFenceClose(lines: string[], openIndex: number): number {
  for (let j = openIndex + 1; j < lines.length; j++) {
    if (CODE_FENCE_LINE_RE.test(lines[j])) return j;
  }
  return -1;
}

/**
 * Index of the next fence-OPEN delimiter reachable from `fromIndex` across ONLY
 * blank lines, or -1 if a non-blank line (a header / prose) intervenes first.
 */
function getNextOpenAfterBlanks(lines: string[], fromIndex: number): number {
  for (let j = fromIndex; j < lines.length; j++) {
    if (lines[j].trim() === '') continue;
    return CODE_FENCE_LINE_RE.test(lines[j]) ? j : -1;
  }
  return -1;
}

/**
 * @description Strip Claude TUI chrome from a pane diff and fence tool-result
 * bodies, returning the cleaned text AND the tool-result kind still open at the
 * end of the chunk. The caller (`pollOutput`) threads `toolKind` back in as the
 * next poll's `incomingKind` so a slow command's orphan output is fenced (B2).
 */
export function stripTuiElementsWithContext(
  text: string,
  incomingKind: ToolResultKind | null = null,
): { text: string; toolKind: ToolResultKind | null } {
  const lines = text.split('\n');
  const filtered: string[] = [];
  // A submitted multi-line prompt renders as a `❯ <first line>` user-turn
  // block followed by space-indented continuation lines. We only dropped the
  // `❯` line, so the continuation (incl. literal ``` fences) leaked out as a
  // phantom "agent message" duplicating the user's own prompt. Skip the whole
  // echo block: continuation lines stay suppressed until a non-indented line
  // (the spinner, a blank, or the agent's own `●` output) ends it.
  let inUserTurnEcho = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // B3: the `(ctrl+o …)` affordance is terminal-only — Telegram can't send
    // ctrl+o — so drop the parenthetical while keeping the rest of the line
    // (`… +2 lines`, `Thought for 4s`, `Read 50 lines`). Trailing-anchored, so
    // it never disturbs the leading-anchored echo / chrome detection below.
    line = line.replace(/\s*\(ctrl\+o[^)]*\)/gi, '');

    if (inUserTurnEcho) {
      if (/^\s+\S/.test(line)) continue;
      inUserTurnEcho = false;
    }
    if (/^❯\s+\S/.test(line)) {
      inUserTurnEcho = true;
      continue;
    }

    // Markdown table (sharp-corner box). Collect the whole frame and emit it
    // FENCED before the chrome-drop filters below — those filters delete any
    // `│`/`─` line wider than 50 chars, which used to wipe a wide table's body
    // rows (bug #10). Chrome uses ROUNDED corners and is left to those filters;
    // only the sharp-corner shape is intercepted here. A table split across
    // scrape chunks (no bottom border yet) still keeps every row it has so far.
    if (checkIsSharpTableTop(line)) {
      const tableBlock: string[] = [line];
      let endIndex = i;
      // Collect contiguous table lines; a bottom border ends the block
      // (inclusive), as does the first non-table line (a table still painting
      // across scrape chunks keeps every row it has so far).
      for (let j = i + 1; j < lines.length; j++) {
        if (!checkIsSharpTableLine(lines[j])) break;
        tableBlock.push(lines[j]);
        endIndex = j;
        if (checkIsSharpTableBottom(lines[j])) break;
      }
      const unbulleted = tableBlock.map(tableLine =>
        tableLine.replace(ASSISTANT_BULLET_PREFIX_RE, '$1  '),
      );
      filtered.push(...getFenced(getDedented(unbulleted)));
      i = endIndex;
      continue;
    }

    if (/^[─━]+$/.test(line.trim())) continue;
    if (/⏵⏵\s*(bypass permissions|accept edits)\s*(on|off)/i.test(line)) continue;
    if (/^❯/.test(line)) continue;
    // Ephemeral UI hint Claude prints under a turn ("⎿  Tip: Use Plan Mode…").
    // Require the `⎿` marker so plain prose starting with "Tip:" is NOT eaten.
    if (/^\s*⎿\s*Tip:\s/i.test(line)) continue;
    // Transient frame the TUI repaints right after an Escape interrupt
    // ("  ⎿  Interrupted · What should Claude do instead?"). The pane-diff
    // pipeline relayed it as a scary "agent is waiting" message even though
    // the next prompt is already being typed. Anchored to the exact TUI shape
    // (line-start, optional ⎿/whitespace, the literal phrase to line-end) so
    // prose merely mentioning the word "Interrupted" is NOT stripped.
    if (/^\s*(?:⎿\s*)?Interrupted · What should Claude do instead\?\s*$/.test(line)) continue;
    if (/\(shift\+tab to cycle\)/i.test(line)) continue;
    if (/^[\s·✽✢✶✻⏵❯─━↵]+$/.test(line)) continue;

    // S3 (N1.a) / S4 (N1.b): per-line strip of mid-chunk spinner ticks
    // and post-thinking trailers. These shapes used to slip through
    // `checkIsStatusOutput` (adapter side) and `checkIsProgressChunk`
    // (bot side) when they appeared mixed with real output in a single
    // poll diff (msg 1853, 1855, 1863 in the debug session).
    if (SPINNER_TICK_RE.test(line)) continue;
    if (POST_THINKING_TRAILER_RE.test(line.trim())) continue;
    // S2 (render-flood 2026-07-04): a leading star-burst activity title with NO
    // stats anchor (`✻ Herding cats`) is transient spinner chrome the
    // stats-requiring SPINNER_TICK_RE above misses — drop it so it never ships
    // as answer content. Both relay paths (fast + verbosity-routed) funnel
    // through here, so this one drop covers them.
    if (checkIsBareSpinnerActivityLine(line)) continue;

    const trimmedLine = line.trim();
    const isToolCall = /^[●○⏺]?\s*(Bash|Read|Write|Edit|Glob|Grep|Task|TodoWrite|WebFetch|WebSearch)\s*\(/i.test(trimmedLine);

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
    // Interactive question UI: side-by-side AskUserQuestion chrome — the
    // "Notes: press n…" affordance and the unnumbered "Chat about this"
    // meta-row leaked as naked text when a selector frame fell through to
    // this path (live msg 23990, 2026-06-10). Both regexes are anchored
    // whole-line, so prose containing the phrases survives.
    if (QUESTION_NOTES_HINT_REGEX.test(line)) continue;
    if (QUESTION_CHAT_ABOUT_REGEX.test(line)) continue;
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

  const { out, outgoingKind } = fenceToolResultBodies(filtered, incomingKind);
  const merged = mergeAdjacentFences(out);
  let result = merged.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return { text: result.trim(), toolKind: outgoingKind };
}

/**
 * @description Strip Claude TUI chrome and fence tool-result bodies (B2),
 * returning just the cleaned text. Thin wrapper over
 * {@link stripTuiElementsWithContext} for call sites (and tests) that don't
 * thread the cross-poll tool kind.
 */
export function stripTuiElements(
  text: string,
  incomingKind: ToolResultKind | null = null,
): string {
  return stripTuiElementsWithContext(text, incomingKind).text;
}

/**
 * @description Turn an absolute workDir into Claude's transcript-folder slug.
 *
 * Claude stores per-project transcripts under
 * `~/.claude/projects/<slug>/<sessionUuid>.jsonl`, where the slug is the
 * absolute path with every non-alphanumeric character replaced by `-`
 * (e.g. `/home/user/src/telegramCode` → `-home-user-src-telegramCode`).
 *
 * The slug encoding is undocumented and could drift across Claude versions,
 * so it is used only to *locate* the candidate folder — the authoritative
 * correctness gate is the `recordedCwd === workDir` filter in
 * {@link listClaudeSessionsForWorkDir}.
 */
function getClaudeProjectSlug(workDir: string): string {
  return workDir.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * @description Root of Claude's on-disk transcript store
 * (`~/.claude/projects`). Single source for every path built from it —
 * session listing, resume-context reads, and the sub-agent transcript scan.
 */
function getClaudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * @description Read the byte range `[startOffset..endOffset)` of a file as
 * UTF-8. The sub-agent transcript tail uses it to fetch only the bytes
 * appended since the previous poll instead of re-reading whole files. A short
 * read (file truncated between stat and read) returns just the bytes
 * available — the JSONL line parser skips any torn tail.
 */
async function readFileSlice(filePath: string, startOffset: number, endOffset: number): Promise<string> {
  const fileHandle = await fs.promises.open(filePath, 'r');
  try {
    const length = endOffset - startOffset;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, startOffset);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await fileHandle.close();
  }
}

/**
 * @description Is this fs error a plain "path does not exist" (`ENOENT`)?
 * Cast-free narrowing via the same record guard the JSONL parsers use.
 */
function checkIsMissingPathError(error: unknown): boolean {
  return checkIsRecord(error) && error.code === 'ENOENT';
}

/**
 * @description One transcript's distilled metadata, collected by streaming
 * its `.jsonl` lines. All fields optional — a partially-written or
 * unexpected transcript still yields whatever was found.
 */
interface ParsedTranscript {
  recordedCwd: string | null;
  /** Model-written conversation title (from the matching `summary` entry). */
  summaryTitle: string | null;
  /** First user prompt — final fallback title. */
  firstUser: string | null;
  /** Last user prompt — preferred over `firstUser` when no summary matches. */
  lastPrompt: string | null;
  firstTimestamp: string | null;
}

/**
 * @description Narrow an untyped `JSON.parse` result to a plain object so its
 * fields can be read with `typeof` guards instead of casts (parse-boundary
 * pattern for untrusted on-disk data; mirrors `isRecord` in `state.ts`).
 */
function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @description Stream-parse a single Claude `.jsonl` transcript, pulling out
 * just the fields we need to render and gate a resumable session. Reads the
 * whole file synchronously (the caller already bounded the count to
 * {@link sessionsParseLimit}) and tolerates malformed lines.
 *
 * A `.jsonl` can carry many `summary` entries (one per branch ever summarised
 * in this project file). The one describing THIS conversation is the summary
 * whose `leafUuid` points at a message `uuid` that lives in this file, so we
 * collect message uuids + all (leafUuid → summary) pairs, then match.
 */
function parseClaudeTranscript(filePath: string): ParsedTranscript {
  const result: ParsedTranscript = {
    recordedCwd: null,
    summaryTitle: null,
    firstUser: null,
    lastPrompt: null,
    firstTimestamp: null,
  };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.warn(`[Claude] failed to read transcript ${filePath}:`, e instanceof Error ? e.message : e);
    return result;
  }

  const messageUuids = new Set<string>();
  const summaryByLeaf = new Map<string, string>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // tolerate a half-written trailing line
    }
    if (!checkIsRecord(entry)) continue;

    if (typeof entry.uuid === 'string') messageUuids.add(entry.uuid);

    if (entry.type === 'summary' && typeof entry.summary === 'string' && typeof entry.leafUuid === 'string') {
      summaryByLeaf.set(entry.leafUuid, entry.summary);
    }
    if (result.recordedCwd === null && typeof entry.cwd === 'string') {
      result.recordedCwd = entry.cwd;
    }
    if (result.firstTimestamp === null && typeof entry.timestamp === 'string') {
      result.firstTimestamp = entry.timestamp;
    }
    if (entry.type === 'user') {
      const userText = extractUserText(entry.message);
      if (userText) {
        if (result.firstUser === null) result.firstUser = userText;
        result.lastPrompt = userText; // keep the LAST user prompt
      }
    }
  }

  for (const [leafUuid, summary] of summaryByLeaf) {
    if (messageUuids.has(leafUuid)) {
      result.summaryTitle = summary;
      break;
    }
  }
  return result;
}

/**
 * @description Best-effort extraction of plain text from a transcript's
 * `user` message. Claude writes the message either as a bare string or as
 * an array of content blocks (`{ type: 'text', text }`). Returns the first
 * non-empty text found, or `null`.
 */
function extractUserText(message: unknown): string | null {
  if (typeof message === 'string') return message.trim() || null;
  if (!checkIsRecord(message)) return null;
  const content = message.content;
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (checkIsRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return block.text.trim();
      }
    }
  }
  return null;
}

/**
 * @description Best-effort extraction of plain text from a transcript's
 * `assistant` message. Unlike a user message, an assistant `message.content`
 * is always the block array; we concatenate every `{ type: 'text' }` block
 * (one assistant turn can interleave several) and IGNORE `tool_use` /
 * `thinking` / other block kinds so the resume context shows prose, not a
 * tool-call dump. Returns the joined text, or `null` if no renderable text.
 */
function extractAssistantText(message: unknown): string | null {
  if (!checkIsRecord(message)) return null;
  const content = message.content;
  // Some assistant entries store a bare string (rare); accept it too.
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const textBlocks: string[] = [];
  for (const block of content) {
    if (checkIsRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      textBlocks.push(block.text.trim());
    }
  }
  if (textBlocks.length === 0) return null;
  return textBlocks.join('\n\n');
}

/**
 * @description Parse ONE Claude `.jsonl` transcript line into a renderable
 * conversational turn, or `null` for a meta / tool-only / empty / malformed
 * line. Shared by {@link readRecentClaudeTurns} (the resume-context / recap turn
 * body) and {@link readClaudeReattachTranscript} (the missed-message count) so
 * both apply the EXACT same renderability rule: a `type:'user'` /
 * `type:'assistant'` entry whose message yields non-empty text (via
 * {@link extractUserText} / {@link extractAssistantText}); `summary` and other
 * meta lines, and assistant entries that are tool_use-only, yield `null`. Never
 * throws — a torn / half-written line (offset landing mid-record) fails
 * `JSON.parse` and yields `null`.
 */
function parseClaudeTurnLine(line: string): RecentTurn | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null; // tolerate a half-written / torn line
  }
  if (!checkIsRecord(entry)) return null;
  if (entry.type === 'user') {
    const text = extractUserText(entry.message);
    return text ? { role: 'user', text } : null;
  }
  if (entry.type === 'assistant') {
    const text = extractAssistantText(entry.message);
    return text ? { role: 'assistant', text } : null;
  }
  return null;
}

/**
 * @description Read the last `limit` conversational turns (user/assistant
 * messages with renderable text, oldest→newest) from a Claude `.jsonl`
 * transcript, for the resume context block.
 *
 * Exported and pure (filesystem-only) so it is unit-testable against a temp
 * `.jsonl`. Streams the whole file via {@link parseClaudeTurnLine}, keeping only
 * the last `limit` in a rolling window so a huge transcript stays cheap.
 * Tolerates a half-written trailing line; a missing/unreadable file → `[]`.
 */
export function readRecentClaudeTurns(filePath: string, limit: number): RecentTurn[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return []; // transcript not on disk (unknown UUID / pruned) → no context
  }

  const turns: RecentTurn[] = [];
  for (const line of raw.split('\n')) {
    const turn = parseClaudeTurnLine(line);
    if (turn) turns.push(turn);
    // Bound the window: drop the oldest once we exceed `limit` so a long
    // transcript never accumulates more than `limit` turns in memory.
    if (turns.length > limit) turns.shift();
  }
  return turns;
}

/**
 * @description Combined transcript read for the silent-reattach recap: ONE
 * `fs.readFileSync` yields BOTH the missed-message count and the recap turn
 * body, so the transcript is not read twice.
 *
 * - `missedCount` — renderable `type:'assistant'` turns appended AFTER byte
 *   `offset` (the seen-watermark = transcript size at the last turn end), counted
 *   over the `[offset, EOF)` byte tail. A torn leading line (offset mid-record)
 *   fails to parse and is skipped. `offset >= size` → `0` (nothing appended /
 *   transcript truncated or rewritten smaller).
 * - `turns` — the last `limit` renderable turns of the WHOLE session (NOT just
 *   the missed region), identical to {@link readRecentClaudeTurns}.
 * - `headOffset` — the transcript's CURRENT byte size (`buffer.length`), i.e.
 *   the watermark value meaning "everything currently on disk is accounted for".
 *   The reattach recap advances the persisted watermark to it for idempotency.
 *   Absent on an unreadable file (head unknown → the caller omits the watermark).
 *
 * Exported and pure (filesystem-only) so it is unit-testable. `fs.readFileSync`
 * reads the whole file in one call (it handles short reads internally), so a
 * large `[offset, EOF)` tail never loses its last lines to a partial `read` —
 * the silent undercount a manual `Buffer.alloc` + `fs.readSync` would hit on
 * exactly the long-downtime case this feature targets. A missing/unreadable
 * file → `{ missedCount: 0, turns: [] }` (no `headOffset`).
 */
export function readClaudeReattachTranscript(
  filePath: string,
  offset: number,
  limit: number,
): { missedCount: number; turns: RecentTurn[]; headOffset?: number } {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return { missedCount: 0, turns: [] }; // transcript not on disk → nothing to recap
  }

  // Recap body: last `limit` renderable turns of the WHOLE session.
  const turns: RecentTurn[] = [];
  for (const line of buffer.toString('utf-8').split('\n')) {
    const turn = parseClaudeTurnLine(line);
    if (turn) turns.push(turn);
    if (turns.length > limit) turns.shift();
  }

  // Missed count: renderable assistant turns in the [offset, EOF) byte tail.
  const start = Math.min(Math.max(0, offset), buffer.length);
  let missedCount = 0;
  for (const line of buffer.subarray(start).toString('utf-8').split('\n')) {
    const turn = parseClaudeTurnLine(line);
    if (turn?.role === 'assistant') missedCount += 1;
  }
  return { missedCount, turns, headOffset: buffer.length };
}

/**
 * @description List resumable Claude sessions for a workDir by reading the
 * real `~/.claude/projects/<slug>/*.jsonl` transcripts.
 *
 * Exported and pure (filesystem-only, no tmux/adapter boot) so it can be
 * unit-tested against a temp `projectsRoot`. Steps:
 *
 *   1. Resolve `<projectsRoot>/<slug>`; if missing → `[]`.
 *   2. Take the {@link sessionsParseLimit} most-recently-modified `.jsonl`.
 *   3. Parse each; KEEP only files whose recorded cwd === `workDir`
 *      (the load-bearing correctness gate — slug collisions / version drift).
 *   4. id = filename stem, MUST pass {@link checkIsValidUuid} (else skip).
 *   5. title = summaryTitle ?? lastPrompt ?? firstUser ?? id (trimmed, capped).
 *      updatedAt = file mtime; createdAt = first timestamp ?? mtime.
 *
 * Result is newest-first by mtime.
 */
export function listClaudeSessionsForWorkDir(projectsRoot: string, workDir: string): AgentSession[] {
  const slugDir = path.join(projectsRoot, getClaudeProjectSlug(workDir));
  let entries: string[];
  try {
    entries = fs.readdirSync(slugDir);
  } catch {
    return []; // folder doesn't exist yet → no Claude session ran here
  }

  const candidates = entries
    .filter(name => name.endsWith('.jsonl'))
    .map(name => {
      const fullPath = path.join(slugDir, name);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { name, fullPath, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, sessionsParseLimit);

  const sessions: AgentSession[] = [];
  for (const candidate of candidates) {
    const id = candidate.name.slice(0, -'.jsonl'.length);
    if (!checkIsValidUuid(id)) continue;
    const parsed = parseClaudeTranscript(candidate.fullPath);
    if (parsed.recordedCwd !== workDir) continue;
    const rawTitle = parsed.summaryTitle ?? parsed.lastPrompt ?? parsed.firstUser ?? id;
    const title = rawTitle.trim().slice(0, sessionTitleMaxLength) || id;
    const updatedAt = new Date(candidate.mtimeMs);
    const createdAt = parsed.firstTimestamp ? new Date(parsed.firstTimestamp) : updatedAt;
    sessions.push({ id, title, createdAt, updatedAt });
  }
  return sessions;
}

// `shellSingleQuote` moved to `utils/tmuxExec` (shared with the terminal
// backend); it was private here and is imported above.

/**
 * @description A bare slash command (e.g. `/compact`, `/clear`, `/context`) —
 * a `/` followed only by letters/hyphens with NO argument. Typing one opens
 * Claude's command-autocomplete popup; an argument (a space) closes it. We
 * use this to decide whether the trailing `Enter` needs to wait for the popup
 * to settle (see {@link CLAUDE_SLASH_ENTER_DELAY_MS}).
 */
const BARE_SLASH_COMMAND_RE = /^\/[a-zA-Z][a-zA-Z-]*$/;

/**
 * @description Whether `input` is a bare slash command (matches
 * {@link BARE_SLASH_COMMAND_RE} after trimming). Exported so the
 * popup-settle decision is unit-testable without a live tmux session.
 */
export function checkIsBareSlashCommand(input: string): boolean {
  return BARE_SLASH_COMMAND_RE.test(input.trim());
}

/**
 * @description Delay between typing a bare slash command and pressing Enter.
 *
 * Claude's TUI opens an autocomplete popup the instant `/` is typed. Sending
 * Enter the same tick the popup is still rendering accepts the highlighted
 * suggestion instead of RUNNING the command, so e.g. `/compact` silently
 * no-ops. Letting the popup settle first makes Enter execute the command.
 * Commands with arguments (`/model sonnet`) don't need this — the space
 * already dismissed the popup.
 */
const CLAUDE_SLASH_ENTER_DELAY_MS = 250;

/**
 * @description Delay between the literal-text burst and the Enter that submits
 * a plain (non-slash) prompt.
 *
 * Claude's TUI aggregates a fast burst of input as a paste; an Enter that lands
 * inside that aggregation window (observed: tens of ms after a 100+ char burst)
 * is absorbed as a paste newline instead of submitting, leaving the prompt
 * typed-but-unsubmitted in the input box (B5, live-reproduced ~1 in 4). Sending
 * the text and the Enter back-to-back on the serial queue is exactly that race.
 * Deferring the Enter past the window makes it register as a submit. Kept small
 * so the prompt still feels instant; the slash-command delay is larger because
 * it solves a different problem (popup settle), not this one.
 */
const CLAUDE_TEXT_ENTER_DELAY_MS = 80;

/**
 * @description Inputs shorter than this skip the deferred Enter + verification
 * entirely: a few characters (`y`, `n`, an option digit) cannot trigger the
 * TUI's paste aggregation, and these control replies were instant before B5 —
 * keep them instant.
 */
const CLAUDE_PASTE_RACE_MIN_LENGTH = 8;

/**
 * @description How long to wait after the submit-Enter before capturing the
 * pane to verify the prompt actually submitted (B5 post-Enter verification).
 * Must outlast the TUI repaint that follows a real submit (the input box clears
 * and Claude either goes busy or echoes the user turn). One capture only; if it
 * still looks unsubmitted we re-send Enter exactly once (no infinite retries).
 */
const CLAUDE_ENTER_VERIFY_DELAY_MS = 600;

/**
 * @description How many trailing pane lines form Claude's live footer/status
 * region. The `esc to interrupt` busy hint renders ONLY here — on the
 * `⏵⏵ bypass permissions…` footer line, or the spinner status line a row or two
 * above the input box. `checkIsClaudeBusy` reads `session.lastContent`, which is
 * the FULL `capture-pane -S -2000` scrollback; bounding the busy match to this
 * tail stops a transcript that merely TALKS about "esc to interrupt" from
 * pinning the session busy forever. Live 2026-06-29: the bot's own dev topic
 * (its conversation is full of the phrase) froze a "🔧 working" status frame
 * because the regex matched scrollback prose, not the live footer — the genuine
 * footer sat on the bottom line while the nearest prose hit was 17 lines above.
 */
const CLAUDE_BUSY_FOOTER_TAIL_LINES = 8;

/**
 * @description The busy hint as Claude's footer/spinner CHROME renders it:
 * bracketed by the `·` hint separator (`… · esc to interrupt · ← for agents`)
 * or the spinner-stats parens (`(12s · ↓ tokens · esc to interrupt)` /
 * `(esc to interrupt)`), never as bare prose. Requiring that bracketing keeps a
 * transcript line like `const RE = /esc to interrupt/i` or "the footer shows esc
 * to interrupt" — which can land in the inspected tail of an idle dev topic —
 * from reading as busy. Matched against CLEANED pane text (ANSI stripped) so the
 * marker is never split mid-word.
 */
const CLAUDE_BUSY_FOOTER_RE = /[·(]\s*esc to interrupt|esc to interrupt\s*[·)]/i;

/**
 * @description Whether Claude is mid-turn, judged from a captured pane. A
 * selector/permission prompt shows `Esc to cancel`, NOT `esc to interrupt`, so
 * it reads as idle here (correct — we only wait out a running turn). Only the
 * footer tail is inspected ({@link CLAUDE_BUSY_FOOTER_TAIL_LINES}) and the hint
 * must carry footer chrome ({@link CLAUDE_BUSY_FOOTER_RE}), so scrollback prose
 * mentioning the phrase can't false-positive. Exported so the busy detection is
 * unit-testable without a live tmux session.
 */
export function checkIsClaudeBusy(paneText: string): boolean {
  const footer = paneText.replace(/\s+$/, '').split('\n').slice(-CLAUDE_BUSY_FOOTER_TAIL_LINES);
  return footer.some((line) => CLAUDE_BUSY_FOOTER_RE.test(line));
}

/**
 * @description Sync, in-memory "is this session mid-turn?" decision for the
 * scheduler's wait-for-idle loop ({@link AgentAdapter.checkIsBusy}). Reuses the
 * SAME pane predicate {@link interruptAndWaitIdle} polls
 * ({@link checkIsClaudeBusy} on the `esc to interrupt` footer), evaluated
 * against the session's last CLEANED pane content instead of a fresh `tmux`
 * call — so it stays synchronous and adds no tmux load. The cleaned text is
 * load-bearing: the raw `-e` capture carries ANSI/SGR runs that can split the
 * footer marker mid-word and make the regex miss (the predicate's other
 * callers read plain no-`-e` captures for the same reason). A dead/missing
 * session is never busy. Exported pure so the gate is unit-testable without a
 * live session.
 */
export function checkIsClaudeSessionBusy(args: { isActive: boolean; lastContent: string }): boolean {
  return args.isActive && checkIsClaudeBusy(args.lastContent);
}

/**
 * @description Markers that a frame carries real agent content (a tool header
 * `●`/`⏺`, a tool-result `⎿`, or a ``` ``` ``` code fence). Their presence vetoes
 * the input-echo classification in {@link checkIsInputEchoFrame}.
 */
const CONTENT_MARKER_RE = /^(?:[●⏺]|⎿|```)/;

/**
 * @description Whether a cleaned output frame is nothing but the TUI input box
 * echoing typed text (`❯ <draft>`). The poll can catch the input row between
 * the literal-text keystrokes and the deferred submit Enter (B5 window), and
 * that draft echo is pure noise in Telegram — the user already sees their own
 * message (B7).
 *
 * A frame is an echo when its FIRST non-empty line starts with `❯` AND no line
 * carries a content marker (`●`, `⎿`, or a ``` ``` ``` fence). The old
 * predicate required EVERY line to start with `❯`, but a long draft wraps in
 * the input box so only the first row carries `❯` and the continuation rows are
 * plain — those frames leaked into the topic (B7b). Anchoring on the first line
 * + a content-marker veto keeps a `❯` inside real tool output (e.g. a pane
 * capture printed by a Bash command) classified as content, not an echo.
 *
 * MAINTENANCE — Claude Code's TUI rendering drifts between versions, back and
 * forth (the prompt glyph, the echo indentation, the content markers — e.g. the
 * `●`→`⏺` bullet change noted in `utils/claudeScrapeShapes.ts`). This detector
 * must tolerate ALL known formatting variants, not assume the current one: when
 * an echo starts leaking into the topic, WIDEN the predicate to also cover the
 * new shape (keep the old variants), don't swap one shape for another.
 */
export function checkIsInputEchoFrame(frameText: string): boolean {
  const contentLines = frameText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (contentLines.length === 0) return false;
  if (!contentLines[0].startsWith('❯')) return false;
  return !contentLines.some((line) => CONTENT_MARKER_RE.test(line));
}

/**
 * @description Min normalized chars a frame must share with the last forwarded
 * text before the content gate calls it an echo. Keeps a short reply that merely
 * coincides with a word of the prompt from being eaten — only a real echo of the
 * substance is suppressed. Below it, only the deterministic preamble signature
 * (which the agent never produces itself) can suppress.
 */
const claudeEchoMinMatchChars = 16;

/**
 * @description How long after a {@link ClaudeCliAdapter.sendInput} the content
 * echo gate stays armed. Claude echoes the typed text right at submit, so a short
 * window catches every echo variant while bounding false positives: a much later
 * real reply that happens to repeat prompt text is outside the window and kept.
 */
const claudeInputEchoContentWindowMs = 30_000;

/**
 * @description Collapse a frame / forwarded prompt to a whitespace-insensitive,
 * case-folded form for echo comparison. The TUI wraps a long input across rows
 * and pads differently between redraws, so runs of whitespace (incl. newlines)
 * flatten to a single space — the words survive, the layout noise does not.
 */
function normalizeEchoText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * @description CONTENT-based echo gate (S1), complementing the shape-only
 * {@link checkIsInputEchoFrame}. The bot types the user's prompt into the Claude
 * TUI and Claude echoes it back in the pane; when that echo carries NO `❯`
 * (a wrapped continuation row, the `[Telegram thread context]` preamble, or the
 * tail of a long voice transcript) the shape gate misses it and it leaks into
 * the topic as a ghost "bot message" (live 2026-06-28, topic 39933).
 *
 * A cleaned frame is the user's own echo when EITHER:
 *  - it carries the deterministic thread-context preamble signature (the
 *    `[Telegram thread context]` header — the agent never emits that itself), OR
 *  - its normalized text is a contiguous slice of the normalized forwarded text
 *    (a prefix, suffix, or interior run) of at least
 *    {@link claudeEchoMinMatchChars} — i.e. the whole frame is nothing but a
 *    chunk of what we just typed.
 *
 * The containment DIRECTION is load-bearing: the FRAME must be contained in the
 * forwarded text, never the reverse — so a genuine reply that QUOTES part of the
 * prompt and then adds an answer is NOT a substring of the prompt and is kept.
 * The caller additionally gates this on a short post-forward time window.
 *
 * Pure + exported so every observed echo variant is unit-testable. MAINTENANCE:
 * like {@link checkIsInputEchoFrame}, WIDEN (never swap) when a new echo shape
 * leaks — keep the old variants.
 */
export function checkIsForwardedEcho(frameText: string, forwardedText: string): boolean {
  const frame = normalizeEchoText(frameText);
  if (!frame) return false;
  if (frame.includes(normalizeEchoText(threadContextPreambleHeader))) return true;
  const forwarded = normalizeEchoText(forwardedText);
  if (!forwarded || frame.length < claudeEchoMinMatchChars) return false;
  return forwarded.includes(frame);
}

/**
 * @description Min chars of the typed prompt that must still sit in the live
 * input box for {@link checkLooksUnsubmitted} to call it unsubmitted. A short
 * prefix (vs the whole prompt) is enough — the input box shows only the first
 * wrapped line of a long prompt — while guarding against a one-glyph false
 * match. Below this length we compare the full trimmed text.
 */
const CLAUDE_INPUT_MATCH_PREFIX_LEN = 12;

/**
 * @description Whether a captured pane looks like the typed prompt is still
 * sitting UNSUBMITTED in Claude's live input box (the B5 paste-race symptom).
 *
 * Submission predicate (the load-bearing "did it submit?" check): a prompt has
 * submitted iff EITHER Claude went busy (`esc to interrupt` in the footer — the
 * turn started) OR the live input box at the bottom is empty (`❯ ` with no
 * text — Claude consumed the input and is idle again, e.g. a fast/no-op turn).
 * It looks UNSUBMITTED only when Claude is idle AND the last `❯`-led input row
 * still carries the typed text. We deliberately key on the LAST `❯` line: a
 * SUBMITTED prompt echoes as a `❯ <text>` user-turn block in scrollback, but
 * the live input box below it is the final `❯` line and is empty — so matching
 * the last one ignores the harmless scrollback echo.
 *
 * Tradeoff (locked in plan B5): if a single verification capture is ambiguous
 * we err toward reporting unsubmitted and let the caller retry Enter once — a
 * duplicate Enter on an already-submitted prompt is a harmless no-op in the
 * Claude TUI (submits an empty input = ignored), whereas a missed submit silently
 * loses the user's message.
 *
 * Exported so the predicate is unit-testable without a live tmux session.
 */
export function checkLooksUnsubmitted(paneText: string, typedText: string): boolean {
  if (checkIsClaudeBusy(paneText)) return false;

  const typed = typedText.trim();
  if (!typed) return false;
  // The input box renders the first visual line of the prompt; compare against
  // the prompt's first line so a multi-line paste doesn't fail to match.
  const firstLine = typed.split('\n', 1)[0].trim();
  if (!firstLine) return false;

  const lines = paneText.split('\n');
  let lastInputRow: string | null = null;
  for (const line of lines) {
    const match = line.match(/^\s*❯\s?(.*)$/);
    if (match) lastInputRow = match[1].trim();
  }
  // No input box at all (e.g. a selector/question is on screen) → not our case.
  if (lastInputRow === null) return false;
  if (lastInputRow === '') return false;

  const needle =
    firstLine.length <= CLAUDE_INPUT_MATCH_PREFIX_LEN
      ? firstLine
      : firstLine.slice(0, CLAUDE_INPUT_MATCH_PREFIX_LEN);
  return lastInputRow.startsWith(needle);
}

/**
 * @description Boot-time lifecycle gates Claude can paint before the real input
 * box is usable: the "Press Enter to continue" / login-success gate, and the
 * bypass-permissions warning. `handleAutoLifecycle` dismisses both; the S7
 * readiness predicate treats them as "not ready yet". Module-level so both the
 * auto-lifecycle handlers and {@link checkIsClaudePromptReady} share one source
 * of truth (no duplicated regexes).
 */
const CLAUDE_AUTO_ENTER_PATTERNS = [
  /Press Enter to continue/i,
  /Login successful\. Press Enter/i,
];
const CLAUDE_BYPASS_WARNING_RE = /WARNING.*Bypass|Bypass.*Permissions/i;
const CLAUDE_BYPASS_ACCEPT_RE = /Yes,?\s*I\s*accept/i;

/** The `API Error:`-at-line-start error row shape (detector case (a)). */
const CLAUDE_API_ERROR_START_RE = /^\s*API Error:/;
/** The `API Error:` substring, for a `⎿` result row that carries it (case (b)). */
const CLAUDE_API_ERROR_SUBSTR_RE = /API Error:/;
/**
 * @description A `⎿` result row whose content LEADS with an auth phrase — Claude's
 * canonical logged-out render (`⎿  Not logged in · Please run /login`,
 * `⎿  Please run /login · API Error: 401 …`). The phrase is anchored right after
 * the `⎿` marker (case (c)) — see the false-positive note on
 * {@link getClaudeAgentErrorLine}.
 */
const CLAUDE_AUTH_ROW_RE =
  /^\s*⎿\s*(?:not logged in|please run \/login|invalid authentication credentials)\b/i;

/**
 * @description Find the ONE line in a scraped pane that is a terminal
 * provider / auth error, or `null` if none. `content` is `cleanOutput(raw)`,
 * which RETAINS the `⎿` result marker. Three accepted shapes:
 *   a) `API Error: …` at line start — the classic provider row
 *      (`API Error: … (not your usage limit) · Rate limited`).
 *   b) a `⎿` result row that also contains `API Error:`
 *      (`⎿  overloaded · API Error: 429` — the render the old start-anchored gate
 *      MISSED, which is why a `⎿`-prefixed rate-limit never auto-retried).
 *   c) a `⎿` result row whose content LEADS with an auth phrase
 *      (`⎿  Not logged in · Please run /login` — the logged-out render).
 * FALSE-POSITIVE GUARD: prose never starts a line with the `⎿` glyph nor with
 * `API Error:`. But TOOL results (Bash/Read/Grep output) ARE rendered by the TUI
 * under a `⎿` marker, so a result row that QUOTES an auth phrase deeper in the
 * line (the agent grepping the bot's own logs/source, or a `gh`/`npm` "not
 * logged in" line) would fire case (c) if we matched the phrase anywhere. So (c)
 * anchors the phrase to the row START — a real logged-out row leads with it; a
 * quote embeds it after other text (live 2026-07-03, topic 434). The returned
 * line is fed VERBATIM to {@link classifyAgentApiError}. Exported for unit
 * testing without a live tmux pane.
 */
export function getClaudeAgentErrorLine(content: string): string | null {
  for (const line of content.split('\n')) {
    if (CLAUDE_API_ERROR_START_RE.test(line)) return line;
    if (CLAUDE_AUTH_ROW_RE.test(line)) return line;
    if (TOOL_RESULT_MARKER_RE.test(line) && CLAUDE_API_ERROR_SUBSTR_RE.test(line)) return line;
  }
  return null;
}

/**
 * @description Matches the TUI's live input box prompt row (`❯` led, optional
 * draft text after it). Its presence in a captured pane is our signal that the
 * Claude TUI has finished booting its banner and is ready to receive typed
 * input — before that, the pane shows only the boot banner with no `❯` row.
 */
const CLAUDE_INPUT_BOX_RE = /^\s*❯/m;

/**
 * @description Whether a captured pane shows the Claude TUI has finished
 * booting and is ready to accept a typed slash command (S7 readiness signal).
 *
 * Ready means: the live input box `❯` is on screen AND no boot-time lifecycle
 * gate is still up — neither the "Press Enter to continue" / login gate nor the
 * bypass-permissions warning, both of which `handleAutoLifecycle` dismisses
 * over the next polls. We do NOT require idle: a fresh spawn is idle, and
 * gating on "not busy" would only delay the re-apply past the box first
 * appearing. Keeping the predicate to "input box up, no lifecycle gate" matches
 * the single observable moment the box first accepts keys. Exported for unit
 * testing without a live tmux pane.
 */
export function checkIsClaudePromptReady(paneText: string): boolean {
  if (!CLAUDE_INPUT_BOX_RE.test(paneText)) return false;
  if (CLAUDE_AUTO_ENTER_PATTERNS.some((pattern) => pattern.test(paneText))) return false;
  const hasBypassWarning = CLAUDE_BYPASS_WARNING_RE.test(paneText);
  const hasBypassAccept = CLAUDE_BYPASS_ACCEPT_RE.test(paneText);
  if (hasBypassWarning && hasBypassAccept) return false;
  return true;
}

/**
 * @description Pure decision for the S3 idle-poll seen-watermark advance: persist
 * the transcript's current EOF as "shown live up to here" only when the session
 * is idle AND its input box is ready AND the file grew past the last persisted
 * offset. Idle+ready is the load-bearing pair — a live Claude adapter relays the
 * pane, so an idle+ready moment genuinely means "everything on disk is shown",
 * and gating on growth (`eof > lastOffset`) avoids a write per idle metadata
 * rewrite. Exported so the truth table is unit-testable without a live tmux;
 * {@link ClaudeCliAdapter.advanceClaudeWatermarkIfGrown} is the thin fs+writer
 * wrapper. Callers pass `lastOffset = session.lastWatermarkOffset ?? -1` so a
 * never-advanced session writes on its first idle poll.
 */
export function checkShouldAdvanceWatermark(args: {
  isBusy: boolean;
  isReady: boolean;
  eof: number;
  lastOffset: number;
}): boolean {
  return !args.isBusy && args.isReady && args.eof > args.lastOffset;
}

/**
 * @description Markers of a live sub-agent (Task tool) on the pane. While a
 * sub-agent runs the TUI shows a task line led by `◯` (U+25EF LARGE CIRCLE —
 * NOT the spinner glyph `○` U+25CB used elsewhere in this file), e.g.
 * `◯ general-purpose  <task>  7s`, and the footer gains a `↓ to manage` hint.
 * Either is enough.
 */
const CLAUDE_SUBAGENT_TASK_RE = /^\s*◯\s+\S/m;
const CLAUDE_SUBAGENT_MANAGE_RE = /↓ to manage/;

/**
 * @description Phrase the TUI shows while compacting context (manual `/compact`
 * or auto), e.g. `✶ Compacting conversation… (57s · ↑ 3.1k tokens)`. A bare
 * substring match on the phrase is enough here: this only gates the
 * interrupt decision (don't Escape during compaction), so it deliberately
 * stays looser than the anchored {@link COMPACT_LINE_RE} in `progressLine.ts`
 * (which must be line-exact to safely collapse a redraw burst).
 */
const CLAUDE_COMPACTING_RE = /Compacting conversation/i;

/**
 * @description Whether Claude is doing work that must NOT be interrupted: a
 * running sub-agent (Escape would kill the child) or an in-flight compaction
 * (Escape would abort it and lose the summary). In these states the caller
 * forwards the prompt without Escape so it queues behind the current turn and
 * runs once the work finishes. Exported for unit testing without a live tmux.
 */
export function checkIsClaudeUninterruptible(paneText: string): boolean {
  return (
    CLAUDE_COMPACTING_RE.test(paneText) ||
    CLAUDE_SUBAGENT_TASK_RE.test(paneText) ||
    CLAUDE_SUBAGENT_MANAGE_RE.test(paneText)
  );
}

/**
 * @description Poll cadence while waiting for an interrupt to land. Each tick
 * is a cheap read-only `tmux capture-pane`.
 */
const CLAUDE_INTERRUPT_POLL_MS = 100;

/**
 * @description Upper bound on how long we wait for Claude to leave the busy
 * state after Escape before forwarding the prompt anyway. Escape reliably
 * interrupts a *thinking* turn within well under a second (observed
 * ~200 ms–1 s, vs the old 120 ms fixed guess that raced and let the prompt
 * queue). It does NOT interrupt an in-flight tool/subprocess — those run to
 * this timeout and then forward (the message queues behind the tool, which is
 * unavoidable, but is never dropped). So the bound is sized to cover
 * thinking-interrupt latency, not to wait out a running tool.
 */
const CLAUDE_INTERRUPT_TIMEOUT_MS = 3000;

// `getNewPaneContent` + the `NewPaneContent` interface moved to `utils/paneDiff`
// (shared with the terminal backend); it imports `normalizeForComparison` from
// `utils/recentRelayWindow` so the per-poll set diff and the long-horizon relay
// window keep one normalization domain. Both names are re-exported so existing
// importers/tests keep resolving unchanged.
export { getNewPaneContent, type NewPaneContent };

/**
 * @description Input snapshot of one resume-seeding poll, fed to
 * {@link getResumeSeedDecision}.
 */
export interface ResumeSeedState {
  /** Cleaned pane content captured on THIS poll. */
  content: string;
  /** Cleaned pane content captured on the PREVIOUS poll (empty before the first). */
  prevContent: string;
  /** Number of polls already spent in seeding mode (0 on the first seeding poll). */
  polls: number;
}

/**
 * @description Decide whether to stay in resume flood-suppression mode or exit.
 *
 * While `keepSeeding` is true, `pollOutput` advances the baseline but emits no
 * conversation text, so the entire restored transcript Claude repaints on
 * `--resume` is swallowed instead of dumped into the topic. We exit (and let
 * the NEXT poll's diff be genuine new output) when either:
 *
 *   - the pane is non-empty AND unchanged across two consecutive polls (the
 *     restored transcript finished painting — the common case), or
 *   - the hard cap {@link resumeSeedMaxPolls} is hit (paint stuttered forever;
 *     force-exit so a session can never be wedged into permanent silence).
 *
 * Pure + exported so the swallow → exit-on-stable → emit-new transition is
 * unit-testable without a live tmux pane.
 */
export function getResumeSeedDecision(state: ResumeSeedState): { keepSeeding: boolean } {
  const reachedCap = state.polls + 1 >= resumeSeedMaxPolls;
  const stableNonEmpty = state.content !== '' && state.content === state.prevContent;
  return { keepSeeding: !reachedCap && !stableNonEmpty };
}

export class ClaudeCliAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'claude';
  readonly label = 'Claude Code';
  readonly outputsDeltas = true;
  // The TUI prints its own banner to the topic — the bot suppresses `agent.ready`
  // and keeps the typing loader up until that first output (see AgentAdapter).
  readonly selfGreetsOnStart = true;

  /**
   * Map of serialised `ThreadKey` (`"<chatId>:<threadId>"`) → live session.
   * Keyed by string rather than `ThreadKey` object so map lookups work — JS
   * Map compares object identity, not structural equality.
   */
  private sessions: Map<string, ClaudeSession> = new Map();

  /**
   * Per-thread display-prefs reader, injected by the bot at boot via
   * `createAdapter.registerDisplayPrefsReader` (S4; same idiom as the OpenCode
   * adapter). Consulted on the poll hot path: the relay branches each chunk's
   * tool / panel segments on `toolResults` (S4), and the transcript scan
   * fast-forwards (non-`full` `subagent`) or streams (`full`). `null` until
   * wired → reads fall back to all-fields-`minimal`.
   */
  private displayPrefsReader: DisplayPrefsReader | null = null;

  /** @description Inject the per-thread display-prefs reader (see the field's JSDoc). */
  setDisplayPrefsReader(reader: DisplayPrefsReader): void {
    this.displayPrefsReader = reader;
  }

  /**
   * Per-thread seen-watermark writer, injected by the bot at boot via
   * `createAdapter.registerSeenWatermarkWriter`. Called on every idle+ready poll
   * whose transcript EOF grew past the last persisted offset (via
   * {@link ClaudeCliAdapter.advanceClaudeWatermarkIfGrown}) to persist the new
   * EOF. `null` until wired → {@link advanceSeenWatermark} is a no-op.
   */
  private seenWatermarkWriter: SeenWatermarkWriter | null = null;

  /** @description Inject the per-thread seen-watermark writer (see the field's JSDoc). */
  setSeenWatermarkWriter(writer: SeenWatermarkWriter): void {
    this.seenWatermarkWriter = writer;
  }

  /** @description Advance the persisted seen-watermark for `key` (no-op until the
   * writer is wired). */
  private advanceSeenWatermark(key: ThreadKey, watermark: SeenWatermark): void {
    this.seenWatermarkWriter?.(key, watermark);
  }

  /**
   * @description Advance the seen-watermark to the transcript's current EOF when
   * the session is idle+ready and the file grew since the last write (S3) — the
   * fs+writer wrapper around {@link checkShouldAdvanceWatermark}. Called every
   * non-seeding poll with the poll's `isBusy` / `isReady`; it early-returns on a
   * busy / not-ready poll BEFORE the `fs.stat` (the stat only makes sense at an
   * idle+ready moment), then writes only when EOF actually grew — so idle
   * metadata churn (Claude rewrites `last-prompt`/`mode`/… for hours) costs no
   * more than one bounded write per real growth, and a smaller rewrite never
   * rewinds the in-memory anchor (monotonic). Best-effort — a transcript not yet
   * on disk (UUID just born) leaves the watermark where it was, the next idle
   * poll re-tries. The path resolves the same way {@link getRecentTurns} /
   * {@link getReattachRecap} do.
   */
  private advanceClaudeWatermarkIfGrown(
    key: ThreadKey,
    session: ClaudeSession,
    isBusy: boolean,
    isReady: boolean,
  ): void {
    if (isBusy || !isReady) return; // skip the fs stat on a busy / not-ready poll
    const transcriptPath = path.join(
      getClaudeProjectsRoot(),
      getClaudeProjectSlug(session.workDir),
      `${session.claudeSessionId}.jsonl`,
    );
    let eof: number;
    try {
      eof = fs.statSync(transcriptPath).size;
    } catch {
      return;
    }
    const shouldAdvance = checkShouldAdvanceWatermark({
      isBusy,
      isReady,
      eof,
      lastOffset: session.lastWatermarkOffset ?? -1,
    });
    if (!shouldAdvance) return;
    this.advanceSeenWatermark(key, { sessionId: session.claudeSessionId, claudeTranscriptOffset: eof });
    session.lastWatermarkOffset = eof;
  }

  /** @description Resolve the thread's full display prefs, defaulting every
   * field to `minimal` for any read before the bot wires the reader at boot. */
  private getDisplayPrefs(key: ThreadKey): ResolvedThreadDisplayPrefs {
    return (
      this.displayPrefsReader?.(key) ?? {
        thinking: defaultDisplayVerbosityMode,
        toolResults: defaultDisplayVerbosityMode,
        subagent: defaultDisplayVerbosityMode,
      }
    );
  }

  /** @description Resolve the thread's `/subagent` mode (consulted by the
   * transcript-tail scan), via the full prefs reader. */
  private getSubagentMode(key: ThreadKey): DisplayVerbosityMode {
    return this.getDisplayPrefs(key).subagent;
  }

  private createSession(
    params: Omit<
      ClaudeSession,
      | 'queue'
      | 'pollTimer'
      | 'lastContent'
      | 'handledApiError'
      | 'lastStatusText'
      | 'lastForwardedText'
      | 'lastForwardedTextAt'
      | 'lastQuestionSignature'
      | 'questionAbsentPolls'
      | 'lastSurveySignature'
      | 'autoEnterTimer'
      | 'autoAcceptOuterTimer'
      | 'autoAcceptInnerTimer'
      | 'isPolling'
      | 'openToolKind'
      | 'resumeSeeding'
      | 'resumeSeedPolls'
      | 'resumeSeedPrevContent'
      | 'lastRawCapture'
      | 'currentPollDelayMs'
      | 'unchangedPollStreak'
      | 'lastContentChangeAt'
      | 'pendingEffortReapply'
      | 'lastWatermarkOffset'
      | 'recentRelayWindow'
      | 'subagentTail'
      | 'chunkContext'
      | 'lastPaneSize'
      | 'isResizeSettling'
      | 'resizeSettlePolls'
      | 'streamingTable'
    >,
  ): ClaudeSession {
    return {
      ...params,
      queue: createSerialQueue(),
      pollTimer: null,
      lastContent: '',
      // One-shot auto-retry guard — every fresh session (start / resume /
      // adopt) begins un-armed; armed on the first retryable `API Error:` line.
      handledApiError: false,
      lastStatusText: '',
      lastForwardedText: '',
      lastForwardedTextAt: 0,
      lastQuestionSignature: '',
      questionAbsentPolls: 0,
      lastSurveySignature: '',
      autoEnterTimer: null,
      autoAcceptOuterTimer: null,
      autoAcceptInnerTimer: null,
      isPolling: false,
      openToolKind: null,
      // Seeding is armed explicitly by `resumeSession` after createSession;
      // a fresh `startSession` / reattach never floods, so it stays off here.
      resumeSeeding: false,
      resumeSeedPolls: 0,
      resumeSeedPrevContent: '',
      lastRawCapture: '',
      // S2: every fresh session (start / resume / adopt all flow through here)
      // begins at base cadence — this IS the "reset on session start/resume".
      // No timer is armed yet, so an explicit resetPollCadence would be a no-op.
      currentPollDelayMs: basePollIntervalMs,
      unchangedPollStreak: 0,
      // Seed the pane-change clock to "now" so a freshly-created/adopted session
      // (its first poll hasn't run yet) never reads as 30s-static immediately.
      lastContentChangeAt: Date.now(),
      // S7: armed explicitly by `applyStoredEffortOnSpawn` after a fresh
      // start/resume spawn; adopt/reattach leaves it null (no re-apply).
      pendingEffortReapply: null,
      // S3 seen-watermark anchor: no advance yet → the first idle+ready poll
      // writes the current transcript EOF. Fresh per session object; cross-restart
      // correctness is protected by the recap's PRE-adopt snapshot, not by seeding.
      lastWatermarkOffset: undefined,
      // Every fresh session object (start / resume / adopt all flow through
      // here) begins with an EMPTY relay window — this IS the "reset on
      // session start"; stop deletes the session and the window with it.
      recentRelayWindow: createRecentRelayWindow(),
      // S3: fresh tail state per session — its first scan seeds offsets to
      // EOF, so resume/adopt never replays an old sub-agent's transcript.
      subagentTail: createSubagentTailState(),
      // S4: fresh cross-poll classifier context per session — the all-closed
      // start, so a fresh session never inherits a prior session's open block.
      chunkContext: createInitialChunkContext(),
      // Resize guard: the first successful size query of this session records
      // the baseline; only a CHANGE after that suppresses (never the first read).
      lastPaneSize: null,
      isResizeSettling: false,
      resizeSettlePolls: 0,
      // No table held at session start (start / resume / adopt all flow through
      // here) — this IS the "reset on session start"; stop deletes it with the
      // session. The resume-seed exit clears it again (see `pollOutput`).
      streamingTable: null,
    };
  }

  private enqueueTmux<T>(session: ClaudeSession, fn: () => Promise<T>): Promise<T> {
    return session.queue.run(fn);
  }

  private enqueueTmuxBestEffort(session: ClaudeSession, fn: () => Promise<string>): void {
    void this.enqueueTmux(session, fn).catch((e) => {
      console.warn(`[Claude] tmux operation failed:`, e instanceof Error ? e.message : e);
    });
  }

  private async stopSessionInternal(key: ThreadKey): Promise<void> {
    const k = keyToString(key);
    const session = this.sessions.get(k);
    if (!session) return;

    console.log(`[Claude] Stopping session for ${k}`);

    session.isActive = false;
    // pollTimer is now a `setTimeout` handle (not interval), but
    // clearTimeout safely handles either type.
    if (session.pollTimer) {
      clearTimeout(session.pollTimer);
      session.pollTimer = null;
    }
    // Audit S9 / #10: cancel pending auto-Enter / auto-Accept callbacks
    // so they don't land in a replacement session.
    if (session.autoEnterTimer) {
      clearTimeout(session.autoEnterTimer);
      session.autoEnterTimer = null;
    }
    if (session.autoAcceptOuterTimer) {
      clearTimeout(session.autoAcceptOuterTimer);
      session.autoAcceptOuterTimer = null;
    }
    if (session.autoAcceptInnerTimer) {
      clearTimeout(session.autoAcceptInnerTimer);
      session.autoAcceptInnerTimer = null;
    }

    const killPromise = this.enqueueTmux(session, () => tmuxAsync('kill-session', '-t', session.sessionName));
    // Remove the tmp MCP files we wrote on startSession — claude inlines
    // their content into the session at boot, so once tmux is killed they
    // serve no purpose and would just leak secrets on disk (plan §13.18).
    cleanupMcpTempFiles({ key, dataDir: resolveDataDir() });
    this.sessions.delete(k);
    this.emit('stopped', key);
    await killPromise;
  }

  /**
   * @description Schedule the next `pollOutput` for a session. Audit S9 /
   * #37: replaces `setInterval` so a slow `tmux capture-pane` cannot
   * cause overlapping invocations. The handle is stored back on
   * `session.pollTimer` so `stopSession` can cancel the next tick.
   */
  private schedulePoll(key: ThreadKey, session: ClaudeSession): void {
    if (!session.isActive) return;
    session.pollTimer = setTimeout(() => {
      void (async () => {
        if (!session.isActive) return;
        if (session.isPolling) {
          // Previous poll still in-flight; skip this tick and reschedule.
          this.schedulePoll(key, session);
          return;
        }
        session.isPolling = true;
        try {
          await this.pollOutput(key);
          // S3: tail the session's on-disk sub-agent transcripts on the same
          // tick cadence. Self-guarding (catches everything internally), so a
          // scan problem can never break the pane polling.
          await this.scanSubagentTranscripts(key, session);
        } finally {
          session.isPolling = false;
          this.schedulePoll(key, session);
        }
      })();
    }, session.currentPollDelayMs);
  }

  /**
   * @description Per-poll-tick scan of the session's on-disk sub-agent
   * transcripts (`/subagent` on Claude, plan 2026-06-11 S3). Claude writes
   * each Task-tool child transcript to
   * `<projectsRoot>/<slug>/<claudeSessionId>/subagents/agent-<agentId>.jsonl`;
   * the pure `claudeSubagentTail` helpers own all decisions — first-scan EOF
   * seeding (no backlog replay on resume/adopt), compact-mode fast-forward
   * without reading, and assistant-text-block extraction (child thinking /
   * tool_use never rendered). In `full` mode every appended text block is
   * emitted as a marked output (`meta.isSubagent`) which the bot renders as a
   * standalone "🤖 ⤷" message outside the parent's continuation chain.
   *
   * A missing dir (`ENOENT` — no sub-agent yet, or an older claude version)
   * short-circuits cheaply but still runs the empty scan, so the first-scan
   * flag flips and a transcript created later streams from byte 0. Any other
   * error is logged and swallowed here — this method must never reject, or
   * the rejection would escape `schedulePoll`'s void'd poll chain.
   */
  private async scanSubagentTranscripts(key: ThreadKey, session: ClaudeSession): Promise<void> {
    try {
      const subagentsDir = path.join(
        getClaudeProjectsRoot(),
        getClaudeProjectSlug(session.workDir),
        session.claudeSessionId,
        'subagents',
      );
      let entries: string[] = [];
      try {
        entries = await fs.promises.readdir(subagentsDir);
      } catch (e) {
        if (!checkIsMissingPathError(e)) throw e;
      }
      const scannedFiles: SubagentScanFile[] = [];
      for (const fileName of entries.filter(checkIsSubagentTranscriptName).sort()) {
        try {
          const stats = await fs.promises.stat(path.join(subagentsDir, fileName));
          scannedFiles.push({ fileName, sizeBytes: stats.size });
        } catch {
          // File vanished between readdir and stat — picked up next tick.
        }
      }
      const reads = getSubagentTailReads(session.subagentTail, scannedFiles, this.getSubagentMode(key));
      for (const read of reads) {
        if (!session.isActive) return;
        // Per-read guard: one file's failed read (vanished mid-read) loses only
        // ITS already-advanced range (drop-over-resend), not the sibling files'
        // ranges the outer catch would otherwise abort with it.
        try {
          const appendedText = await readFileSlice(
            path.join(subagentsDir, read.fileName),
            read.startOffset,
            read.endOffset,
          );
          for (const text of extractAppendedSubagentTexts(session.subagentTail, read.fileName, appendedText)) {
            const meta: OutputEventMeta = { isSubagent: true };
            this.emit('output', key, text, meta);
          }
        } catch (e) {
          console.warn(
            `[Claude] sub-agent transcript read failed (${read.fileName}):`,
            e instanceof Error ? e.message : e,
          );
        }
      }
    } catch (e) {
      console.warn(`[Claude] sub-agent transcript scan failed:`, e instanceof Error ? e.message : e);
    }
  }

  /**
   * @description Snap a session's poll cadence back to base (S2). Called on
   * every explicit write (keystroke / signal) and on session start/resume so a
   * fresh prompt never waits up to {@link maxPollIntervalMs} for the next
   * capture — user-visible latency after a write must stay at base cadence.
   *
   * If a poll timer is already pending we re-arm it at the base delay so the
   * backed-off idle timer can't keep the next capture far in the future. The
   * existing {@link ClaudeSession.isPolling} guard is respected: a poll already
   * in flight will reschedule itself from the (now reset) delay, so we never
   * double-poll.
   */
  private resetPollCadence(key: ThreadKey, session: ClaudeSession): void {
    session.currentPollDelayMs = basePollIntervalMs;
    session.unchangedPollStreak = 0;
    if (!session.isActive || session.isPolling) return;
    if (session.pollTimer) {
      clearTimeout(session.pollTimer);
      session.pollTimer = null;
      this.schedulePoll(key, session);
    }
  }

  async startSession(
    key: ThreadKey,
    workDir: string,
    args?: string,
    sessionId?: string,
  ): Promise<void> {
    await this.stopSessionInternal(key);

    if (!checkIsInstalled('claude')) {
      this.emit('output', key, 'Installing Claude Code...');
      await installTool('claude');
    }

    const sessionName = buildTmuxSessionName(key);
    // If the bot didn't provide a UUID, mint one ourselves. The plan owns
    // generation in bot.ts so it can be persisted in state.json (D14), but
    // until §11 Этап 3 wires that up we mint here as a safe default.
    const claudeSessionId = sessionId || randomUUID();
    if (!checkIsValidUuid(claudeSessionId)) {
      // Caller-supplied UUID — refuse anything that doesn't look like one.
      // See `checkIsValidUuid` for the reasoning (audit S1).
      // Audit S10 / #16: throw instead of emit+return so callers can
      // distinguish "did not start" from "started, will fail async".
      throw new Error(`Invalid sessionId: ${claudeSessionId}`);
    }
    if (args && !checkArgsAreSafe(args)) {
      throw new Error('Args contain control characters');
    }
    console.log(
      `[Claude] Starting tmux session ${sessionName} in ${workDir} ` +
      `(sessionId=${claudeSessionId})${args ? ` with args: ${args}` : ''}`,
    );

    // Make sure no stale session with the same name is lingering.
    await tmuxAsync('kill-session', '-t', sessionName);

    // Build the claude command line as an argv list, then assemble the final
    // shell-command for tmux by single-quoting every element. tmux execs the
    // trailing `shell-command` argument via `$SHELL -c` (audit S1 / #1, #2):
    // there is no argv-only path for `new-session`, so the only defence is
    // to ensure no user-controlled string can break out of single quotes.
    // `shellSingleQuote` handles embedded single quotes via the standard
    // `'\\''` close-reopen idiom.
    //
    // --session-id <uuid> assigns the UUID to the NEW session so we can later
    // resume by UUID (plan §13.1). --dangerously-skip-permissions stays
    // hardcoded by D44 (symmetry with opencode auto-approve).
    //
    // MCP servers come from up to four sources (user/group/project/thread,
    // plan §19); user + project are auto-loaded by Claude from cwd, the
    // other two reach Claude through repeated `--mcp-config` flags. The flag
    // values point at tmp files because the bot expands `${VAR}` env-var
    // placeholders itself before handing the config off (plan §13.18, T2).
    const mcpFlagsArr = await prepareMcpFlags({ key, dataDir: resolveDataDir() });
    const claudeArgv: string[] = [
      claudePath,
      ...claudePermissionArgs,
      '--session-id', claudeSessionId,
      ...mcpFlagsArr,
      ...(args ? [args] : []),
    ];
    const claudeShellCmd = claudeArgv.map(shellSingleQuote).join(' ');
    try {
      // `-c <workDir>` sets the new session's start directory, avoiding a
      // preceding `cd && …` chain (which would have to be shell-quoted too).
      await tmuxOrThrowAsync(
        'new-session',
        '-d',
        '-s', sessionName,
        '-x', '300',
        '-y', '50',
        '-c', workDir,
        claudeShellCmd,
      );
      console.log(`[Claude] tmux session created`);
    } catch (e) {
      console.error(`[Claude] Failed to create tmux session:`, e);
      // Audit S9 / #14: even when the spawn fails, tmux can leave a
      // half-built session and we wrote MCP tmp files we don't want to
      // leak. Best-effort cleanup before bubbling up the error.
      await tmuxAsync('kill-session', '-t', sessionName);
      cleanupMcpTempFiles({ key, dataDir: resolveDataDir() });
      // Audit S10 / #16: throw so the caller's `await startSession()`
      // sees the failure and skips registering the binding.
      throw new Error(`Failed to start Claude session: ${e instanceof Error ? e.message : String(e)}`);
    }

    const session = this.createSession({
      key,
      workDir,
      sessionName,
      claudeSessionId,
      isActive: true,
      handledAutoEnter: false,
      handledAutoAccept: false,
    });

    this.sessions.set(keyToString(key), session);
    this.schedulePoll(key, session);
    // S7: ARM the thread's stored /effort for re-apply once the TUI input box
    // is actually ready (consumed in the poll loop) — NOT typed now, while the
    // pane is still painting its boot banner. Fresh spawn only — see
    // applyStoredEffortOnSpawn.
    this.applyStoredEffortOnSpawn(key);
    this.emit('started', key);
  }

  stopSession(key: ThreadKey): void {
    void this.stopSessionInternal(key).catch((e) => {
      console.warn(`[Claude] stopSession failed:`, e instanceof Error ? e.message : e);
    });
  }

  checkIsActive(key: ThreadKey): boolean {
    const session = this.sessions.get(keyToString(key));
    return session?.isActive ?? false;
  }

  checkIsBusy(key: ThreadKey): boolean {
    const session = this.sessions.get(keyToString(key));
    if (!session) return false;
    return checkIsClaudeSessionBusy({ isActive: session.isActive, lastContent: session.lastContent });
  }

  /**
   * @description Ms since the TUI pane last actually changed (raw `capture-pane`
   * differed), or `null` when there is no live session for this thread. Feeds
   * the bot's S2 pane-static idle net: a genuinely working agent repaints the
   * pane every second, so a large value means the agent is idle even if the
   * footer busy signal is stuck. `null` is never treated as idle.
   */
  getMsSincePaneChange(key: ThreadKey): number | null {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return null;
    return Date.now() - session.lastContentChangeAt;
  }

  sendInput(key: ThreadKey, input: string, options?: SendInputOptions): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) {
      console.log(`[Claude] sendInput: no active session for ${keyToString(key)}`);
      return;
    }

    const appendEnter = options?.appendEnter ?? true;
    console.log(`[Claude] sendInput: "${input}"${appendEnter ? '' : ' (no Enter)'}`);
    // S1: remember what we just typed (every path — forward, `/c continue`,
    // buffered replay, control replies) so the content-based echo gate can
    // recognise Claude's pane echo of it, even when the echo carries no `❯`.
    session.lastForwardedText = input;
    session.lastForwardedTextAt = Date.now();
    this.resetPollCadence(key, session);

    // The ordered keystroke plan is pure (getClaudeSendKeysPlan) so the "no
    // Enter" decision is unit-testable; here we just execute each step.
    const steps = getClaudeSendKeysPlan(input, appendEnter);
    for (const step of steps) {
      if (step === 'literal') {
        // Argv-based send-keys: tmux never invokes a shell here, so user-typed
        // `$(...)` / backticks are delivered to claude's stdin as literal
        // bytes. The previous implementation used `execSync` with a shell
        // template; `JSON.stringify(input)` wraps the text in double quotes,
        // and `/bin/sh` happily expands `$(...)` inside double quotes BEFORE
        // tmux ever sees the keys — that was the RCE flagged by audit S1 / #1.
        //
        // `-l` tells tmux to treat the next argument as literal keys, not as
        // tmux special-key names (so the user typing the word "Enter" wouldn't
        // be rewritten to a newline). A separate call adds the actual Enter.
        this.enqueueTmuxBestEffort(session, async () => {
          if (!session.isActive) return '';
          return tmuxAsync('send-keys', '-t', session.sessionName, '-l', input);
        });
      } else if (step === 'slashEnter') {
        // Bare slash commands (`/compact`, `/clear`, …) open Claude's command
        // autocomplete popup; an Enter fired the same instant accepts the popup
        // highlight instead of running the command (so it silently no-ops). Defer
        // the Enter so the popup settles first. Re-check the session is still
        // alive when the timer fires — it may have been stopped meanwhile.
        const sessionName = session.sessionName;
        setTimeout(() => {
          const current = this.sessions.get(keyToString(key));
          if (!current?.isActive || current.sessionName !== sessionName) return;
          this.enqueueTmuxBestEffort(current, async () => {
            if (!current.isActive) return '';
            return tmuxAsync('send-keys', '-t', sessionName, 'Enter');
          });
        }, CLAUDE_SLASH_ENTER_DELAY_MS);
      } else if (step === 'verifiedEnter') {
        // Plain prompt: defer the Enter past the TUI's paste-aggregation window
        // (see CLAUDE_TEXT_ENTER_DELAY_MS) so it submits instead of being absorbed
        // as a paste newline. The delay runs INSIDE the queued fn (not a bare
        // setTimeout): the per-session queue is the ordering guarantee, so any op
        // enqueued later — the next prompt's text, an interrupt Escape from
        // startup-prompt replay — physically cannot land between this text and
        // its submit Enter. An 80ms hold of THIS session's queue is harmless
        // (polls run every 300ms); other sessions' queues are independent.
        this.enqueueTmuxBestEffort(session, async () => {
          if (!session.isActive) return '';
          await sleep(CLAUDE_TEXT_ENTER_DELAY_MS);
          if (!session.isActive) return '';
          return tmuxAsync('send-keys', '-t', session.sessionName, 'Enter');
        });
        this.scheduleEnterVerification(key, session.sessionName, input);
      } else {
        // Short control replies (y/n/option digits) can't trigger paste
        // aggregation — submit instantly, no verification capture.
        this.enqueueTmuxBestEffort(session, async () => {
          if (!session.isActive) return '';
          return tmuxAsync('send-keys', '-t', session.sessionName, 'Enter');
        });
      }
    }
  }

  /**
   * @description Post-Enter verification for a plain prompt (B5). After a short
   * settle, capture the pane through the session queue and — if the prompt still
   * looks unsubmitted (see {@link checkLooksUnsubmitted}) — re-send Enter exactly
   * ONCE. No further retries: a duplicate Enter on an already-submitted prompt is
   * a harmless no-op, but an unbounded retry loop on a genuinely-stuck pane would
   * spam keystrokes. Same staleness guards as the deferred Enter.
   */
  private scheduleEnterVerification(key: ThreadKey, sessionName: string, typedText: string): void {
    setTimeout(() => {
      const current = this.sessions.get(keyToString(key));
      if (!current?.isActive || current.sessionName !== sessionName) return;
      void this.enqueueTmux(current, () =>
        tmuxAsync('capture-pane', '-t', sessionName, '-p'),
      )
        .then((pane) => {
          const live = this.sessions.get(keyToString(key));
          if (!live?.isActive || live.sessionName !== sessionName) return;
          if (!checkLooksUnsubmitted(pane, typedText)) return;
          console.log(`[Claude] Enter retry (paste-race)`);
          this.enqueueTmuxBestEffort(live, async () => {
            if (!live.isActive) return '';
            return tmuxAsync('send-keys', '-t', sessionName, 'Enter');
          });
        })
        .catch(() => {
          /* capture failures are non-fatal: the next poll still drives the UI */
        });
    }, CLAUDE_ENTER_VERIFY_DELAY_MS);
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
      console.log(`[Claude] sent Ctrl+C`);
    }
  }

  sendEnter(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    this.resetPollCadence(key, session);
    console.log(`[Claude] sendEnter`);
    this.enqueueTmuxBestEffort(session, async () => {
      if (!session.isActive) return '';
      return tmuxAsync('send-keys', '-t', session.sessionName, 'Enter');
    });
  }

  sendArrow(key: ThreadKey, direction: 'Up' | 'Down'): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    this.resetPollCadence(key, session);
    console.log(`[Claude] sendArrow: ${direction}`);
    this.enqueueTmuxBestEffort(session, async () => {
      if (!session.isActive) return '';
      return tmuxAsync('send-keys', '-t', session.sessionName, direction);
    });
  }

  sendTab(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    this.resetPollCadence(key, session);
    console.log(`[Claude] sendTab`);
    this.enqueueTmuxBestEffort(session, async () => {
      if (!session.isActive) return '';
      return tmuxAsync('send-keys', '-t', session.sessionName, 'Tab');
    });
  }

  /**
   * @description S4: auto-dismiss the native Claude session-feedback survey by
   * sending a single Escape into the pane (Escape clears the survey overlay the
   * same way it dismisses a selector). Fire-and-forget through the session queue,
   * like {@link sendEscape}; the caller's {@link checkShouldDismissSurvey}
   * signature dedup guarantees it fires once per appearance. Never surfaced to
   * the topic — the survey must not occupy input / disrupt the scrape.
   */
  private dismissClaudeSurvey(session: ClaudeSession): void {
    console.log('[Claude] auto-dismissing session survey (Escape)');
    this.enqueueTmuxBestEffort(session, async () => {
      if (!session.isActive) return '';
      return tmuxAsync('send-keys', '-t', session.sessionName, 'Escape');
    });
  }

  // Fire-and-forget single Escape keystroke (interrupt the current turn /
  // dismiss a selector). Deliberately distinct from `interruptAndWaitIdle`:
  // this is a raw one-shot key, NOT a wait-for-idle interrupt.
  sendEscape(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    this.resetPollCadence(key, session);
    console.log(`[Claude] sendEscape`);
    this.enqueueTmuxBestEffort(session, async () => {
      if (!session.isActive) return '';
      return tmuxAsync('send-keys', '-t', session.sessionName, 'Escape');
    });
  }

  /**
   * @description Interrupt the current turn, then wait until Claude is
   * actually idle before resolving, so the caller can type a fresh prompt
   * without it being queued behind the running turn.
   *
   * Sends a single Escape — which both cancels an on-screen selector AND
   * breaks Claude out of the "busy" state — then polls the pane footer until
   * the `esc to interrupt` hint clears. A fixed post-Escape delay was
   * unreliable: heavy extended-thinking turns take longer than the old 120 ms
   * to tear down, so the prompt landed while Claude was still busy and got
   * queued (the "voice message arrives before the interrupt, then the agent
   * waits" bug). On timeout we forward anyway rather than drop the message.
   *
   * Exception: if Claude is running a sub-agent or compacting context, we do
   * NOT interrupt — Escape would kill the child / abort the compaction. We
   * return without Escape so the caller's prompt queues behind the current
   * turn and runs once that work finishes.
   */
  async interruptAndWaitIdle(key: ThreadKey): Promise<void> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    this.resetPollCadence(key, session);
    const paneBefore = await this.enqueueTmux(session, () => tmuxAsync('capture-pane', '-t', session.sessionName, '-p'));
    if (!session.isActive) return;
    if (checkIsClaudeUninterruptible(paneBefore)) {
      console.log(`[Claude] sub-agent/compaction in progress — queueing prompt, not interrupting`);
      return;
    }

    console.log(`[Claude] sendEscape (interrupt)`);
    await this.enqueueTmux(session, () => tmuxAsync('send-keys', '-t', session.sessionName, 'Escape'));
    if (!session.isActive) return;

    const deadline = Date.now() + CLAUDE_INTERRUPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CLAUDE_INTERRUPT_POLL_MS));
      const current = this.sessions.get(keyToString(key));
      if (!current?.isActive) return;
      const pane = await this.enqueueTmux(current, () => tmuxAsync('capture-pane', '-t', current.sessionName, '-p'));
      if (!current.isActive) return;
      if (!checkIsClaudeBusy(pane)) {
        console.log(`[Claude] interrupt landed — idle, forwarding prompt`);
        return;
      }
    }
    console.log(`[Claude] interrupt: still busy after ${CLAUDE_INTERRUPT_TIMEOUT_MS}ms, forwarding anyway`);
  }

  /**
   * @description Whether a selector is currently on screen. Backed by the same
   * `lastQuestionSignature` the output pump sets when it scrapes a question
   * block (see the `extractClaudeQuestion` call in the poll loop) — non-empty
   * means a question is being shown and awaiting an answer.
   */
  isQuestionPending(key: ThreadKey): boolean {
    const session = this.sessions.get(keyToString(key));
    return Boolean(session?.isActive && session.lastQuestionSignature);
  }

  /**
   * @description Whether Claude's `/login` OAuth "paste the code" box is on
   * screen right now, read live off the last captured pane ({@link checkIsClaudeLoginPaste}).
   * No signature/de-dup is needed — nothing is emitted; this only answers
   * "should the next text reply be typed verbatim into the paste box?" when a
   * message arrives, so the bot skips the prompt path (Escape + preamble) that
   * would otherwise cancel the login and corrupt the code.
   */
  isLoginPastePending(key: ThreadKey): boolean {
    const session = this.sessions.get(keyToString(key));
    return Boolean(session?.isActive && checkIsClaudeLoginPaste(session.lastContent));
  }

  /**
   * @description For Claude CLI, model switching is done via the /model slash command.
   * Sends "/model <modelId>" as input to the tmux session. Returns `null`
   * on success (best-effort: claude doesn't ack the change synchronously).
   * Audit S10 / #39: unified signature with OpenCode adapter.
   *
   * Unlike OpenCode, Claude has NO model-pref persistence — model switching is
   * a TUI keystroke with no on-disk pref to replay at next start. So with no
   * active session there is nothing to do but refuse, otherwise `sendInput`
   * silently no-ops and the caller would report a false "model set" success
   * (reachable today via the ungated numeric-pick path).
   */
  async setModel(key: ThreadKey, modelId: string): Promise<string | null> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return t('model.start_agent_first');
    this.sendInput(key, `/model ${modelId}`);
    // No explicit /effort pref → (re)apply the bot's default for the newly
    // picked model (claude self-clamps unsupported levels). An explicit pick
    // is left alone — claude carries it across the model switch.
    if (this.getEffort(key) === null) this.sendInput(key, `/effort ${defaultEffortLevel}`);
    return null;
  }

  getCurrentModel(_key: ThreadKey): string | null {
    return null;
  }

  /**
   * @description Set the reasoning effort for this thread by typing claude's
   * native `/effort <level>` slash command into the running TUI.
   *
   * Plan 2026-05-30-effort-command / S3, D2/D6:
   *
   * - **Validation** is against the canonical Claude set (`getClaudeAvailableLevels`),
   *   not per-model: the adapter can't read claude's live model after a
   *   `/model` switch (`getCurrentModel` returns `null`), so we trust claude
   *   to clamp an unsupported level for the actual model down to its nearest
   *   supported one. Caller already filtered against the same canonical list
   *   when building the picker.
   * - **Apply** is best-effort via {@link sendInput} (the keystroke path used
   *   by `setModel`). Returns `null` immediately — claude's TUI doesn't
   *   acknowledge the change synchronously and we don't poll-and-wait for it.
   * - **Persist** to the per-thread prefs file so the banner / `/effort`
   *   picker survives a bot restart (claude's own settings.json is global).
   *
   * Returns a short notice instead of `null` when the session isn't running
   * (we still persist the choice so the next /claude picks it up in the
   * banner; live apply happens once the agent actually exists).
   */
  async setEffort(key: ThreadKey, level: string): Promise<string | null> {
    if (!checkIsClaudeEffortLevel(level)) {
      return t('effort.invalid_level', {
        level,
        valid: getClaudeAvailableLevels().join(', '),
      });
    }
    // Persist first — the menu/banner must reflect the user's choice even
    // when there is no running session yet (D6).
    saveEffortPref(key, level);

    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) {
      // Soft notice: choice is recorded, but live apply is deferred until a
      // session exists. Bot surfaces this distinctly from a hard error so
      // the user knows to start an agent.
      return t('effort.start_agent_first');
    }
    this.sendInput(key, `/effort ${level}`);
    return null;
  }

  /**
   * @description Last bot-set effort for this thread, or `null` if none.
   *
   * Reads from the on-disk prefs file (not an in-memory cache): the file is
   * tiny and the read happens only on menu / banner refresh paths, so a
   * cache would just be drift surface. Whatever claude itself stores in
   * its global `settings.json` is invisible to us by design (D2).
   */
  getEffort(key: ThreadKey): string | null {
    const prefs = loadEffortPrefs();
    return prefs[keyToString(key)] ?? null;
  }

  /**
   * @description ARM the thread's stored `/effort` choice for re-apply on a
   * FRESH TUI spawn (S7) — deferred, not typed immediately. claude persists
   * effort GLOBALLY in its own settings.json, so a fresh `startSession` /
   * `resumeSession` would otherwise inherit the last globally-set level —
   * possibly chosen in another topic.
   *
   * Timing is the whole point: a fresh tmux session returns the instant
   * `new-session` succeeds, while the claude TUI is still painting its boot
   * banner — typing into it then interleaves keystrokes with the paint and the
   * command sits unsubmitted (live bug 2026-06-05). So we do NOT type here; we
   * stash the level on `session.pendingEffortReapply` and let the poll loop
   * consume it the FIRST time the pane shows a ready input box
   * ({@link checkIsClaudePromptReady}). That readiness moment is strictly after
   * the banner paints and strictly before the box can echo a buffered prompt,
   * giving the required ordering (effort BEFORE buffered prompts) via the same
   * serial tmux queue.
   *
   * Called at the END of `startSession` / `resumeSession`. NOT called from
   * `adoptExistingTmuxSession` — that claude process survived the restart with
   * its in-TUI effort intact and may be mid-turn, so re-applying would be both
   * unnecessary and risk interleaving with a running stream.
   *
   * No stored pref → the bot's default (`defaultEffortLevel` = xhigh) is armed
   * instead of claude's own default, so a no-pref spawn types `/effort xhigh`
   * (claude clamps per model — same as a manual `/effort` or an explicit pref).
   * An explicit per-thread pref still wins and is armed verbatim.
   */
  private applyStoredEffortOnSpawn(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session) return;
    const level = this.getEffort(key) ?? defaultEffortLevel;
    if (!getEffortStartupKeystroke(level)) return;
    session.pendingEffortReapply = level;
  }

  /**
   * @description S7 consumption point: once the poll loop sees the TUI input
   * box is up and no boot gate is left, type the armed `/effort <level>` ONCE
   * and clear the pending flag (one-shot, can't fire twice). Reuses the exact
   * keystroke path a manual `/effort` uses ({@link sendInput} with its
   * bare-slash deferred-Enter handling) so there is no duplicate keystroke
   * logic. Enqueuing onto the session's serial tmux queue at this ready moment
   * guarantees the keystroke lands in a usable input box (not the boot paint)
   * and ahead of any buffered prompt the bot replays onto the same queue.
   */
  private consumePendingEffortReapply(session: ClaudeSession): void {
    const keystroke = getEffortStartupKeystroke(session.pendingEffortReapply);
    if (!keystroke) return;
    session.pendingEffortReapply = null;
    this.sendInput(session.key, keystroke);
  }

  /**
   * @description Effort levels offered by the `/effort` picker for Claude.
   *
   * Returns the canonical set unconditionally (plan D2). The `key` argument
   * is accepted for interface symmetry with OpenCode (whose set depends on
   * the per-thread current model) but is intentionally unused here.
   */
  async getAvailableEffortLevels(_key: ThreadKey): Promise<string[]> {
    return getClaudeAvailableLevels();
  }

  getFullOutput(key: ThreadKey, lines: number = 500): string | null {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return null;

    return session.lastContent.split('\n').slice(-lines).join('\n') || null;
  }

  /**
   * @description Expose the Claude `--session-id` UUID for a live session.
   * The bot calls this right after `startSession()` so the UUID can be
   * persisted in state.json and reused on later resumes (plan §13.1, D14).
   */
  getClaudeSessionId(key: ThreadKey): string | null {
    return this.sessions.get(keyToString(key))?.claudeSessionId ?? null;
  }

  // Lists REAL resumable sessions from `~/.claude/projects/<cwd>/*.jsonl`,
  // not a bot-private registry. This makes a conversation started by hand
  // on the laptop in `workDir` resumable from the bound Telegram thread.
  // `key` is unused: Claude scopes transcripts by folder, not by thread.
  async getSessions(_key: ThreadKey, workDir: string): Promise<AgentSession[]> {
    return listClaudeSessionsForWorkDir(getClaudeProjectsRoot(), workDir);
  }

  /**
   * @description Read the last `limit` conversational turns of a resumable
   * Claude session for the resume context block. Resolves the same
   * `~/.claude/projects/<slug>/<sessionId>.jsonl` path the session listing uses
   * (`key` is unused — Claude scopes transcripts by folder, not by thread) and
   * delegates to the pure {@link readRecentClaudeTurns}. A missing transcript
   * (unknown / pruned UUID) yields `[]`, so the caller posts no context block.
   */
  async getRecentTurns(_key: ThreadKey, workDir: string, sessionId: string, limit: number): Promise<RecentTurn[]> {
    const filePath = path.join(getClaudeProjectsRoot(), getClaudeProjectSlug(workDir), `${sessionId}.jsonl`);
    return readRecentClaudeTurns(filePath, limit);
  }

  /**
   * @description Assemble the silent-reattach recap for Claude from the on-disk
   * transcript via ONE {@link readClaudeReattachTranscript} read: the
   * missed-message count is the assistant turns appended after the watermark
   * byte offset, the body is the last {@link resumeContextTurnLimit} turns, and
   * `isActive` is the best-effort in-memory busy flag (the just-adopted session
   * seeds `lastContent` from the current pane, so an `esc to interrupt` footer
   * reads as still-working). The offset is trusted only when the watermark's
   * `sessionId` matches the session being recapped — a stale watermark from a
   * different session (`/new`, `/sessions` resume keep the agent row) is treated
   * as unknown. A `null`/mismatched/offset-less watermark yields
   * `isWatermarkKnown: false` and `missedCount: 0` (the fallback recap), while
   * the body still shows the last turns.
   */
  async getReattachRecap(
    key: ThreadKey,
    workDir: string,
    sessionId: string,
    watermark: SeenWatermark | null,
  ): Promise<ReattachRecap> {
    const filePath = path.join(getClaudeProjectsRoot(), getClaudeProjectSlug(workDir), `${sessionId}.jsonl`);
    const offset = watermark?.claudeTranscriptOffset;
    const isWatermarkKnown = typeof offset === 'number' && watermark?.sessionId === sessionId;
    // ONE read serves both the count and the body. When the watermark is unknown
    // we still want the turn body, so read from 0 and drop the count below.
    const { missedCount, turns, headOffset } = readClaudeReattachTranscript(filePath, offset ?? 0, resumeContextTurnLimit);
    const isActive = this.checkIsBusy(key);
    // Head watermark = the transcript's current size, scoped to THIS session.
    // Omitted when the file was unreadable (head unknown → no idempotent advance).
    const headWatermark: SeenWatermark | undefined =
      headOffset === undefined ? undefined : { sessionId, claudeTranscriptOffset: headOffset };
    return { missedCount: isWatermarkKnown ? missedCount : 0, turns, isWatermarkKnown, isActive, headWatermark };
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
  async resumeSession(key: ThreadKey, workDir: string, sessionId: string, options?: ResumeSessionOptions): Promise<void> {
    await this.stopSessionInternal(key);

    if (!checkIsInstalled('claude')) {
      this.emit('output', key, 'Installing Claude Code...');
      await installTool('claude');
    }

    if (!checkIsValidUuid(sessionId)) {
      throw new Error(`Invalid sessionId: ${sessionId}`);
    }
    const sessionName = buildTmuxSessionName(key);
    console.log(`[Claude] Resuming session ${sessionId} in ${workDir} for ${keyToString(key)}`);

    await tmuxAsync('kill-session', '-t', sessionName);

    // Pass the UUID explicitly. If it's unknown to claude, it'll just print a
    // notice and start fresh — better than hanging on a picker. MCP flags
    // are re-applied here so a resumed session sees the same servers as a
    // fresh one would (plan §19). Argv-style shell-quoting mirrors
    // `startSession` (audit S1).
    const mcpFlagsArr = await prepareMcpFlags({ key, dataDir: resolveDataDir() });
    const claudeArgv: string[] = [
      claudePath,
      ...claudePermissionArgs,
      '--resume', sessionId,
      ...mcpFlagsArr,
    ];
    const claudeShellCmd = claudeArgv.map(shellSingleQuote).join(' ');

    try {
      await tmuxOrThrowAsync(
        'new-session',
        '-d',
        '-s', sessionName,
        '-x', '300',
        '-y', '50',
        '-c', workDir,
        claudeShellCmd,
      );
    } catch (e) {
      console.error(`[Claude] Failed to resume session:`, e);
      await tmuxAsync('kill-session', '-t', sessionName);
      cleanupMcpTempFiles({ key, dataDir: resolveDataDir() });
      throw new Error(`Failed to resume Claude session: ${e instanceof Error ? e.message : String(e)}`);
    }

    const claudeSession = this.createSession({
      key,
      workDir,
      sessionName,
      claudeSessionId: sessionId,
      isActive: true,
      handledAutoEnter: false,
      handledAutoAccept: false,
    });

    // Arm flood-suppression BEFORE the first poll: Claude repaints the whole
    // restored transcript into the pane over the next polls, which would
    // otherwise be relayed as one giant dump. Seeding swallows that text while
    // still advancing the baseline (see `pollOutput` + `getResumeSeedDecision`).
    claudeSession.resumeSeeding = true;

    this.sessions.set(keyToString(key), claudeSession);
    this.schedulePoll(key, claudeSession);
    // S7: ARM the stored /effort for re-apply on this fresh resume spawn too
    // (claude's global effort state could be from another topic). Deferred to
    // the poll-loop readiness point — same as startSession; the resume seeding
    // repaint must finish before the input box is ready, which the readiness
    // predicate already requires. See applyStoredEffortOnSpawn.
    this.applyStoredEffortOnSpawn(key);
    this.emit('started', key);

    // Post the short last-N-turn context block in place of the flood. ONLY on
    // the explicit user resume (`/sessions` pick) — a silent re-attach must
    // stay quiet (see ResumeSessionOptions). The `.jsonl` is independent of
    // the pane, so this can run immediately (it does not wait for seeding to
    // finish). Best-effort: a read failure or empty history simply posts no
    // extra block — the normal "resumed" reply stands.
    if (options?.isWithRecentContext) {
      try {
        const turns = await this.getRecentTurns(key, workDir, sessionId, resumeContextTurnLimit);
        const rendered = formatResumeContext(turns);
        // Complete one-shot block — post instantly, never via the dm draft
        // channel (its typing animation would "draw" this already-whole text).
        if (rendered) this.emit('output', key, rendered, { isComplete: true });
      } catch (e) {
        console.warn(`[Claude] resume context block failed:`, e instanceof Error ? e.message : e);
      }
    }
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
    const raw = await tmuxAsync('list-sessions', '-F', '#{session_name}');
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
   * @description Recover the `--session-id <uuid>` flag from a live tmux
   * session's start command.
   *
   * Used by the bot's reattach loop to reconcile state with reality when
   * `state.agents[key]` is missing a `claudeSessionId` (or names a
   * different adapter) but a `claude-<chatId>-<threadId>` tmux session is
   * still running. Previously such cases were treated as orphans and the
   * tmux session was killed, throwing away the user's live work.
   *
   * Implementation: read `pane_start_command` for the session's first
   * pane and parse the UUID out via {@link parseClaudeSessionIdFromCommand}.
   * `pane_start_command` survives across restarts because tmux keeps the
   * original command line for the pane.
   *
   * Returns `null` if no UUID can be recovered (caller falls back to
   * killing the session as an orphan).
   */
  async recoverSessionIdFromTmux(sessionName: string): Promise<string | null> {
    const sessions = await tmuxAsync('list-sessions', '-F', '#{session_name}');
    if (!sessions.split('\n').includes(sessionName)) return null;
    const cmd = await tmuxAsync('display-message', '-p', '-t', sessionName, '#{pane_start_command}');
    if (!cmd) return null;
    return parseClaudeSessionIdFromCommand(cmd);
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
  async adoptExistingTmuxSession(
    key: ThreadKey,
    sessionName: string,
    workDir: string,
    claudeSessionId: string,
  ): Promise<boolean> {
    const sessions = await tmuxAsync('list-sessions', '-F', '#{session_name}');
    if (!sessions.split('\n').includes(sessionName)) {
      console.log(`[Claude] adopt: tmux session ${sessionName} no longer exists`);
      return false;
    }

    // Audit S9 / #15: confirm the tmux session has a live child process,
    // not just an empty pane. With `remain-on-exit` semantics or a crashed
    // claude, a session can exist but produce no output forever; adopting
    // it would silently swallow further user input.
    const panesRaw = await tmuxAsync('list-panes', '-t', sessionName, '-F', '#{pane_pid}');
    const pids = panesRaw.split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s));
    const anyAlive = pids.some(pidStr => {
      try { process.kill(Number(pidStr), 0); return true; }
      catch { return false; }
    });
    if (!anyAlive) {
      console.log(`[Claude] adopt: ${sessionName} has no live child process, killing as zombie`);
      await tmuxAsync('kill-session', '-t', sessionName);
      return false;
    }

    const k = keyToString(key);
    // If we already have a tracked session for this key, leave it alone.
    if (this.sessions.has(k)) {
      console.log(`[Claude] adopt: already tracking ${k}, skipping`);
      return true;
    }

    console.log(`[Claude] adopt: re-attaching to ${sessionName} in ${workDir}`);
    const session = this.createSession({
      key,
      workDir,
      sessionName,
      claudeSessionId,
      isActive: true,
      handledAutoEnter: true,  // don't try to auto-Enter on a session that's already past startup
      handledAutoAccept: true, // same — bypass-permissions was accepted on the original launch
    });

    // Seed `lastContent` with the current pane snapshot **before** the
    // first poll fires. Without this, the bot's first `pollOutput` after
    // re-adoption would diff a ~2000-line scrollback (hours of stale
    // conversation that survived the restart inside tmux) against `''`
    // — `getNewPaneContent('', x) === x` — and emit every line of it to
    // Telegram as if it were brand new output. Symptom: user restarts
    // the bot, types a fresh message in an existing thread, and the
    // thread gets flooded with answers from previous sessions before
    // the new answer arrives.
    //
    // The capture uses the SAME flags as `pollOutput` (`-e -S -2000`)
    // so the seed and the next poll's snapshot are produced by the
    // same code path; otherwise edge differences in ANSI handling or
    // scrollback depth would re-introduce phantom "new" lines on the
    // first diff. Best-effort — if `capture-pane` fails the seed stays
    // empty and we fall back to the pre-fix (noisy) behaviour, which
    // is still better than refusing to adopt.
    const initialRaw = await this.enqueueTmux(session, () => tmuxAsync('capture-pane', '-t', sessionName, '-p', '-e', '-S', '-2000'));
    if (initialRaw) {
      session.lastContent = cleanOutput(initialRaw);
      // S1: seed the raw baseline too so the first poll after adoption — which
      // captures the same idle pane — skips the redundant `cleanOutput`.
      session.lastRawCapture = initialRaw;
      // Seed the relay window too (live incident 2026-06-24, thread 434): the
      // baseline above suppresses re-appearing PROSE, but a SETTLED table already
      // on the pane is deduped ONLY at the BLOCK level (`emitStabilizedTable`).
      // Without this seed the window is empty, so the first post-adopt poll
      // re-emits the whole table once per restart (~1100 chars). Recording the
      // pane + the settled table's own block signature makes that re-render hit
      // `checkBlockAlreadyRelayed === true` and be suppressed.
      seedRelayWindowFromPane(session.recentRelayWindow, session.lastContent, getLastSharpTableBlock);
    }

    this.sessions.set(k, session);
    this.schedulePoll(key, session);
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
  async killOrphanTmuxSession(sessionName: string): Promise<void> {
    console.log(`[Claude] kill orphan tmux session: ${sessionName}`);
    await tmuxAsync('kill-session', '-t', sessionName);
  }

  // Exposed for tests (see §11 Этап 7, R10): keeps the tmux-name parsing
  // logic unit-testable without instantiating the adapter (which would try to
  // auto-install claude on construction).
  static parseTmuxSessionName = parseTmuxSessionName;
  static buildTmuxSessionName = buildTmuxSessionName;

  private async probeSessionAlive(session: ClaudeSession): Promise<boolean> {
    const sessions = await this.enqueueTmux(session, () => tmuxAsync('list-sessions', '-F', '#{session_name}'));
    return sessions.split('\n').includes(session.sessionName);
  }

  private async pollOutput(key: ThreadKey): Promise<void> {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    // Audit S9 / #38: a burst of more than 200 lines between two polls
    // would slide off the top of the capture window before the next poll
    // saw it, breaking the diff and causing duplicate "new" emissions.
    // 2000 lines comfortably covers a long Claude tool-call block; we
    // still diff against `session.lastContent` in memory so the larger
    // capture doesn't grow the output we send to Telegram.
    const raw = await this.enqueueTmux(session, () => tmuxAsync('capture-pane', '-t', session.sessionName, '-p', '-e', '-S', '-2000'));
    if (!session.isActive) return;

    if (!raw) {
      const alive = await this.probeSessionAlive(session);
      if (!session.isActive) return;
      if (!alive) {
        console.log(`[Claude] Session died, cleaning up`);
        await this.stopSessionInternal(key);
        this.emit('closed', key);
      }
      return;
    }

    // Pane-RESIZE guard (live incident 2026-07-02, topic 39933): an
    // interactive `tmux attach` resizes the window to the client terminal (and
    // detach restores the `-x/-y` default); tmux re-wraps the WHOLE scrollback
    // at the new width, so the line-SET diff below would see ~every line as
    // "new" and relay ragged fragments of OLD conversation (the relay window
    // can't match re-wrapped lines, and its short-line exemption lets clusters
    // of short old lines through on every flap). Query the size AFTER the
    // capture (same-poll order is what makes the race-free direction hold: a
    // resize landing between the two calls is detected on THIS poll, before
    // its giant diff ships) and, on a change, swallow the repaint — advance
    // the baseline, emit nothing — until the capture settles. Decision logic
    // is pure: `utils/paneResizeGuard.ts`.
    const paneSizeRaw = await this.enqueueTmux(session, () =>
      tmuxAsync('display-message', '-p', '-t', session.sessionName, '#{pane_width}x#{pane_height}'),
    );
    if (!session.isActive) return;
    const currentPaneSize = parsePaneSize(paneSizeRaw);
    const resizeDecision = getPaneResizeGuardDecision({
      lastSize: session.lastPaneSize,
      currentSize: currentPaneSize,
      isSettling: session.isResizeSettling,
      settlePolls: session.resizeSettlePolls,
      isRawChanged: raw !== session.lastRawCapture,
    });
    if (currentPaneSize !== null && session.lastPaneSize !== null && currentPaneSize !== session.lastPaneSize) {
      console.log(
        `[Claude] pane resized (${session.lastPaneSize} → ${currentPaneSize}) — suppressing scrape, reseeding baseline`,
      );
    }
    if (currentPaneSize !== null) session.lastPaneSize = currentPaneSize;
    if (session.isResizeSettling && !resizeDecision.nextIsSettling) {
      console.log(`[Claude] pane resize settled after ${session.resizeSettlePolls} suppressed polls`);
    }
    session.isResizeSettling = resizeDecision.nextIsSettling;
    session.resizeSettlePolls = resizeDecision.nextSettlePolls;
    if (resizeDecision.action === 'suppress') {
      if (raw !== session.lastRawCapture) {
        session.lastRawCapture = raw;
        session.lastContent = cleanOutput(raw);
        // The pane genuinely changed — keep the 30s pane-static liveness net honest.
        session.lastContentChangeAt = Date.now();
      }
      return;
    }

    // S1: when the raw capture is byte-identical to the previous poll's, the
    // pane did not change, so the cleaned content is identical too — skip the
    // ~15-regex `cleanOutput` pass and reuse the cached result. Runs AFTER the
    // empty-raw death probe above (an empty capture short-circuits there and
    // never reaches the skip). All downstream branches behave bit-for-bit the
    // same: the resume-seeding "unchanged across 2 polls" exit still sees its
    // no-change signal, and the `content !== lastContent` compare still no-ops.
    const isRawChanged = raw !== session.lastRawCapture;
    let content: string;
    if (isRawChanged) {
      session.lastRawCapture = raw;
      // Pane changed → reset the idle clock the bot's 30s pane-static net reads.
      session.lastContentChangeAt = Date.now();
      content = cleanOutput(raw);
    } else {
      content = session.lastContent;
    }

    // S2: grow the poll delay while the pane stays idle, snap back to base on
    // any change. A change always resets the cadence so streaming latency is
    // unaffected; only no-activity panes slow down (toward maxPollIntervalMs).
    const nextCadence = getNextPollDelay({
      isChanged: isRawChanged,
      currentDelayMs: session.currentPollDelayMs,
      unchangedStreak: session.unchangedPollStreak,
    });
    session.currentPollDelayMs = nextCadence.delayMs;
    session.unchangedPollStreak = nextCadence.unchangedStreak;

    // Resume flood-suppression: while seeding, Claude is repainting the whole
    // restored transcript into the pane. We advance the baseline every poll but
    // emit NO conversation text, so once the pane stops growing the baseline
    // equals the full restored transcript and later diffs are genuine new
    // output. This runs on EVERY poll (even when `content === lastContent`),
    // because "unchanged across 2 polls" — the exit signal — is exactly the
    // no-change case. Lifecycle auto-handling KEEPS running (suppress text, not
    // the "Press Enter" / bypass-permissions prompts a resume may re-show).
    if (session.resumeSeeding) {
      const decision = getResumeSeedDecision({
        content,
        prevContent: session.resumeSeedPrevContent,
        polls: session.resumeSeedPolls,
      });
      session.lastContent = content;
      session.resumeSeedPrevContent = content;
      session.resumeSeedPolls += 1;
      this.handleAutoLifecycle(session, content, getNewPaneContent('', content).text);
      if (!decision.keepSeeding) {
        session.resumeSeeding = false;
        // The relay window must start EMPTY here: seeding SWALLOWED the
        // restored transcript (it was never relayed this lifetime), and the
        // window only ever suppresses content it actually relayed. Seeding
        // emits no output so nothing was recorded — the reset keeps that
        // invariant explicit rather than incidental.
        session.recentRelayWindow.reset();
        // Same invariant for the table stabilizer: seeding swallowed any
        // restored table, so nothing should carry over into the live phase.
        session.streamingTable = null;
        console.log(`[Claude] resume seeding done after ${session.resumeSeedPolls} polls`);
      }
      return;
    }

    // S7: re-apply the thread's stored /effort the FIRST poll the TUI input box
    // is up (and no boot gate left). Runs every non-seeding poll, incl. unchanged
    // ones — the box can appear on a poll whose content didn't otherwise change.
    // Cheap early-out below when nothing is armed; `consumePendingEffortReapply`
    // clears the flag so it fires exactly once. Must precede any buffered-prompt
    // replay, which the bot only starts after the input box exists — they share
    // the serial tmux queue, and this enqueues first.
    if (session.pendingEffortReapply && checkIsClaudePromptReady(content)) {
      this.consumePendingEffortReapply(session);
    }

    // S3 seen-watermark advance: on EVERY idle+ready poll (not just the single
    // busy→ready edge) move the persisted watermark to the transcript's current
    // EOF. Because a live Claude adapter relays the pane, an idle+ready moment
    // genuinely means "everything on disk is shown live up to here", so tracking
    // EOF here corrects a premature mid-turn idle advance and catches a final
    // assistant line flushed just after the turn ends — both of which the old
    // edge-only gate missed. Cheap: two regex tests every poll; the fs stat +
    // write only fire at an idle+ready moment, and the write only when EOF
    // actually grew. Lets a later bot restart count the assistant turns it
    // missed during downtime (the reattach recap).
    const isBusy = checkIsClaudeSessionBusy({ isActive: session.isActive, lastContent: content });
    this.advanceClaudeWatermarkIfGrown(key, session, isBusy, checkIsClaudePromptReady(content));

    // S1 idle-poll table flush: the change branch below never runs on a
    // byte-unchanged poll, so a table that is the LAST thing painted before the
    // pane freezes is flushed here instead (never silently drop it). The flush
    // is gated on the SAME done-signals as the change branch — real prose after
    // the table OR the turn going idle — so a mid-stream PAUSE (the pane briefly
    // frozen at an intermediate row count while still busy) is held, not emitted
    // (live incident 2026-06-15). A frozen-but-busy table rides the held-poll
    // safety cap; a frozen idle table emits via the idle signal.
    if (content === session.lastContent && session.streamingTable) {
      const idleDecision = getTableStabilizationDecision({
        currentTable: getLastSharpTableBlock(content),
        streamingTable: session.streamingTable,
        hasContentAfterTable: checkHasContentAfterLastSharpTable(content),
        isTurnIdle: !checkIsClaudeSessionBusy({ isActive: session.isActive, lastContent: content }),
      });
      session.streamingTable = idleDecision.nextStreamingTable;
      if (idleDecision.kind === 'emit' && idleDecision.block) {
        this.emitStabilizedTable(key, session, idleDecision.block);
      }
    }

    if (content !== session.lastContent) {
      const previousPane = session.lastContent;
      const diff = getNewPaneContent(previousPane, content);
      const startsNewParagraph = diff.startsNewParagraph;
      session.lastContent = content;

      // S1 streaming-table stabilizer (live incident 2026-06-11): a wide
      // markdown table re-flows its column widths as longer cells stream in, so
      // every layout is byte-distinct and the line-SET diff marks the whole
      // table "new" each poll — it would ship once per layout (empty → 1 row →
      // full), the final full frame often dropped under the coalescer's
      // debounce / a 429. Operate on the FULL live `content` (not the diff):
      // hold a still-laying-out table (masking its lines out of THIS poll's
      // delta so no intermediate frame ships), and emit the complete table only
      // when it is DONE — real prose now follows it, or the turn went idle, or
      // the safety cap fired (NOT on a mid-stream pause; live incident
      // 2026-06-15). Runs BEFORE the normal emit so a done table is its own
      // fenced block, ahead of any trailing prose in this same delta.
      const tableDecision = getTableStabilizationDecision({
        currentTable: getLastSharpTableBlock(content),
        streamingTable: session.streamingTable,
        hasContentAfterTable: checkHasContentAfterLastSharpTable(content),
        isTurnIdle: !checkIsClaudeSessionBusy({ isActive: session.isActive, lastContent: content }),
      });
      session.streamingTable = tableDecision.nextStreamingTable;
      // While a table is held OR being emitted separately, its lines must not
      // also ride in this poll's prose delta — mask them out either way.
      let newPart = diff.text;
      if (tableDecision.kind !== 'none') {
        newPart = maskSharpTableLines(newPart);
      }
      if (tableDecision.kind === 'emit' && tableDecision.block) {
        this.emitStabilizedTable(key, session, tableDecision.block);
      }

      if (newPart) {
        // S4: full body only when explicitly debugging the scrape pipeline;
        // default is a one-line size summary (the sync stdout write of up to
        // ~600KB per changed poll was starving the event loop in prod).
        console.log(
          isClaudeScrapeDebugEnabled
            ? `[Claude] RAW output (${newPart.length}):\n---\n${newPart}\n---`
            : `[Claude] RAW output (${newPart.length} chars)`,
        );

        // Interactive question/choice prompts are detected on the FULL pane
        // (not this diff): moving the `❯` cursor repaints only the changed
        // option lines, so a signature from the diff would be a partial
        // option set and the de-dup would re-spam the thread on every
        // keystroke. Reading the whole option group keeps the signature
        // stable across cursor moves. Deliver once as durable output — not a
        // transient status frame that gets deleted — and suppress repaints.
        const question = extractClaudeQuestion(content);
        if (question) {
          // A real AskUserQuestion selector takes PRECEDENCE over a survey: a
          // digit reply must drive the selector, not be eaten by a stale
          // survey signal. Clear the survey de-dup so it can't shadow the
          // question's digit routing.
          session.lastSurveySignature = '';
          // Detected → reset the absence counter (any prior transient null was a
          // flicker, not a resolve).
          session.questionAbsentPolls = 0;
          if (question.signature !== session.lastQuestionSignature) {
            session.lastQuestionSignature = question.signature;
            session.lastStatusText = '';
            session.openToolKind = null; // a question ends any prior tool output
            // `isQuestion`: the bot sends this as its OWN pinnable message and
            // pins it so the muted topic fires a notification.
            this.emit('output', key, `${question.text}\n\n${t('agent.question_hint')}`, { isQuestion: true });
          }
        } else {
          // No selector THIS diff. While a question is pending, a single miss is
          // usually the selector mid-repaint, NOT a resolve — debounce so we
          // don't fire `questionGone` (premature unpin) then re-emit a duplicate
          // question + notification next poll once it re-appears. Only resolve
          // after it's been absent for `questionAbsentPollThreshold` consecutive
          // diffs; clearing the signature only THEN (so an identical question
          // asked again later is still delivered, not swallowed).
          if (session.lastQuestionSignature) {
            session.questionAbsentPolls += 1;
            if (session.questionAbsentPolls >= questionAbsentPollThreshold) {
              this.emit('questionGone', key);
              session.lastQuestionSignature = '';
              session.questionAbsentPolls = 0;
            }
          } else {
            session.questionAbsentPolls = 0;
          }

          // S4: AUTO-DISMISS the native Claude session-feedback survey (the
          // periodic bare-digit prompt — either known header wording, see
          // CLAUDE_SURVEY_HEADER_REGEX). It lands on the pane mid-turn,
          // occupies the input box and disrupts the scrape (it contributed to
          // the "status never appeared" hang, live 2026-06-29; an UNDETECTED
          // wording swallowed the next prompt's Enter and hung the topic, live
          // 2026-07-02). Never surface it to the topic — send a one-shot Escape
          // to clear it. The signature (header + option digits/labels, no
          // volatile chrome) is stable across the survey's per-poll repaints, so
          // we dismiss ONCE per appearance; cleared when it leaves the pane so a
          // genuinely new survey later is dismissed again. While a survey is on
          // the pane its header/option lines are ALSO stripped from the relay
          // chunk below (gated on this `survey`), so the dismissed survey's
          // chrome never leaks into the topic as a stray prose message.
          const survey = extractClaudeSurvey(content);
          if (survey) {
            if (checkShouldDismissSurvey(survey.signature, session.lastSurveySignature)) {
              session.lastSurveySignature = survey.signature;
              this.dismissClaudeSurvey(session);
            }
          } else {
            session.lastSurveySignature = '';
          }

          // Long-horizon re-render dedup (live incident 2026-06-10, plan
          // 2026-06-10-claude-stale-rescrape-dedup): the per-poll diff above
          // only knows the PREVIOUS capture, so when the TUI re-renders
          // hours-old scrollback (full repaint / scroll-through / resize) the
          // redrawn lines arrive here as "new" and would be re-relayed as a
          // duplicate flood. Drop every line already relayed to this topic;
          // when nothing survives, skip the poll's emit entirely.
          let relayablePart = getRelayDedupedChunk(session.recentRelayWindow, newPart);
          if (relayablePart && survey) {
            // S4: a survey is on the pane this poll — drop its header/option
            // lines so the auto-dismissed survey's chrome never leaks (it would
            // otherwise classify as prose). Gated on a detected `survey` so a
            // legitimate "1: x  2: y" list in normal output is never touched.
            relayablePart = stripSurveyChromeLines(relayablePart);
          }
          if (!relayablePart) {
            console.log(`[Claude] already-relayed re-render suppressed (${newPart.length} chars)`);
          } else {
            // S4 verbosity relay: classify the chunk (pure, cheap), then route
            // its tool / panel segments per the thread's `/tool_results` pref.
            // The classifier threads fence/block context across polls (mirrors
            // `session.openToolKind` for orphan bodies whose header streamed in
            // an earlier poll). FAST PATH (regression anchor): all-`full`
            // tool+thinking prefs AND no panel-preview segment → the pre-S4
            // direct strip→emit runs BYTE-IDENTICALLY on the original chunk.
            const prefs = this.getDisplayPrefs(key);
            const classification = classifyClaudeChunk(relayablePart, session.chunkContext);
            session.chunkContext = classification.outgoingContext;

            const isFastPath = checkIsClaudeRelayFastPath(
              classification.segments,
              prefs.toolResults,
              prefs.thinking,
            );

            let stripInput: string;
            let activityLine: string | null = null;
            if (isFastPath) {
              // Pre-S4 path, unchanged: feed the ORIGINAL chunk to the stripper
              // (it is the chrome/fence backstop). Provably byte-identical.
              stripInput = relayablePart;
            } else {
              // QUIET PATH: keep prose + thinking verbatim, route tool bodies
              // (full keep / short truncate / minimal fold) and ALWAYS fold a
              // sub-agent panel preview into the rolling status frame.
              const routed = routeClaudeChunkSegments(
                classification.segments,
                prefs.toolResults,
                prefs.thinking,
                (toolLabel) => t('toolResults.activity_status', { tool: toolLabel || t('toolResults.activity_fallback') }),
                () => t('subagent.panel_fold_status'),
                () => t('thinking.live'),
                (seconds) => t('thinking.thoughtForSeconds', { seconds }),
                t('toolResults.truncated_footer'),
              );
              stripInput = routed.keptText;
              activityLine = routed.activityLine;
            }

            // Thread the tool-result kind across polls: the owning `● Bash(…)`
            // header of a slow command's output streamed in an earlier poll (the
            // line-set diff drops it as a duplicate), so `session.openToolKind`
            // carries it forward to fence the orphan `⎿` body (B2). Tracked via
            // the clean deltas, not a scan of the racy live pane.
            const stripped = stripTuiElementsWithContext(stripInput, session.openToolKind);
            session.openToolKind = stripped.toolKind;
            const cleanedOutput = stripped.text;
            // B7 shape gate (the `❯` input-box draft) FIRST; then the S1
            // content gate for the no-`❯` echo variants (preamble / wrapped
            // continuation / voice-transcript tail), armed only briefly after a
            // send so a later real reply that repeats prompt words is never eaten.
            const isShapeEcho = checkIsInputEchoFrame(cleanedOutput);
            const isContentEcho =
              !isShapeEcho &&
              Date.now() - session.lastForwardedTextAt < claudeInputEchoContentWindowMs &&
              checkIsForwardedEcho(cleanedOutput, session.lastForwardedText);
            if (cleanedOutput && (isShapeEcho || isContentEcho)) {
              // The frame is just Claude echoing the user's own typed input —
              // relaying it reads as a ghost message in the topic.
              console.log(`[Claude] input-echo frame filtered${isContentEcho ? ' (content match)' : ''}`);
            } else if (cleanedOutput) {
              // S4: gated full body (see the RAW dump above for the rationale).
              console.log(
                isClaudeScrapeDebugEnabled
                  ? `[Claude] FILTERED output (${cleanedOutput.length}):\n---\n${cleanedOutput}\n---`
                  : `[Claude] FILTERED output (${cleanedOutput.length} chars)`,
              );

              if (checkIsStatusOutput(cleanedOutput)) {
                // S6 (c): when this same poll ALSO folded a verbosity activity
                // (🔧 tool / 🤖 sub-agent / ☁️ thinking), that routed line is the
                // INTENTIONAL minimal-mode indicator — prefer it over the
                // incidental transient so the rolling status reads cleanly
                // (the transient must not shadow the routed activity). Real
                // permanent output is the `else` below and still always wins.
                const statusText = activityLine ?? cleanedOutput;
                // Deduplicate spinner updates: normalize spinner character and compare
                const dedupKey = activityLine ?? cleanedOutput.replace(/^[✻✽✶✢·*●○⏺]\s*/gm, '');
                if (dedupKey !== session.lastStatusText) {
                  session.lastStatusText = dedupKey;
                  this.emit('status', key, statusText);
                }
              } else {
                session.lastStatusText = '';
                // Record in the PANE-line domain (pre-strip): a future
                // re-render arrives as pane lines, so the window must store
                // the same shape the filter above queries. Permanent output
                // only — status frames roll/are edited in place and never
                // flood as separate messages.
                session.recentRelayWindow.record(relayablePart);
                // Carry the dropped leading paragraph break out-of-band (S2): the
                // bot rebuilds the `\n\n` separator only when APPENDING this prose
                // chunk to the pending buffer / live draft — never at a message
                // start. Out-of-band so the pipeline's trims can't strip it.
                this.emit('output', key, cleanedOutput, { startsNewParagraph });
              }
            } else if (activityLine) {
              // Quiet path folded every routable segment into the status frame
              // (e.g. `minimal` tool calls / a sub-agent panel preview) — keep
              // the user informed with one rolling activity line, deduped like
              // the spinner-status path above so the frame doesn't churn.
              if (activityLine !== session.lastStatusText) {
                session.lastStatusText = activityLine;
                this.emit('status', key, activityLine);
              }
            } else {
              console.log(`[Claude] Output filtered out completely`);
            }
          }
        }
      }

      this.handleAutoLifecycle(session, content, newPart);
    }
  }

  /**
   * @description Emit a settled streaming table (S1) as ONE fenced `output`.
   *
   * Routes the held block through the SAME fence path as the inline table path
   * ({@link stripTuiElementsWithContext} fences a sharp-corner table) so the
   * `<pre>` rendering is byte-identical to today — only the TIMING/dedup change.
   * Records the raw block in {@link RecentRelayWindow} in the PANE-line domain
   * (pre-strip) so a later full repaint of the same table is suppressed by the
   * existing re-render dedup, exactly like the normal permanent-output path.
   * Emitted with `startsNewParagraph: true` — a table is its own visual block,
   * so it must not glue onto preceding prose in the append/draft join.
   */
  private emitStabilizedTable(key: ThreadKey, session: ClaudeSession, block: string): void {
    // Root-cause dedup (flood 2026-06-16): the table block was RECORDED into the
    // relay window but never CHECKED before emit, and table lines are masked out
    // of the prose delta before `getRelayDedupedChunk` runs — so the long-horizon
    // re-render guard structurally never saw a re-printed/looped table. Each
    // re-render → one new message (a single topic flooded with ~500 byte-identical
    // copies). Check the window at the BLOCK level (border rows / tiny cells fall
    // under the per-line gate, so a per-line check would miss them) in the SAME
    // pre-strip pane-line domain `record` uses. An identical block → skip the
    // emit (suppressed exactly like a re-rendered prose chunk); a CHANGED table is
    // a different signature → still emits. Still record() to keep the window warm.
    const isAlreadyRelayed = session.recentRelayWindow.checkBlockAlreadyRelayed(block);
    const fenced = stripTuiElementsWithContext(block, session.openToolKind);
    session.openToolKind = fenced.toolKind;
    if (!fenced.text) return;
    session.recentRelayWindow.record(block);
    if (isAlreadyRelayed) {
      console.log(`[Claude] already-relayed table re-render suppressed (${block.length} chars)`);
      return;
    }
    session.lastStatusText = '';
    this.emit('output', key, fenced.text, { startsNewParagraph: true });
  }

  /**
   * @description Auto-handle the two lifecycle prompts Claude can show — the
   * "Press Enter to continue" gate and the bypass-permissions warning — by
   * issuing the matching keystrokes. Extracted from {@link pollOutput} so the
   * resume-seeding path (which suppresses conversation TEXT) can still drive
   * these prompts; suppression must hide chatter, not the lifecycle.
   *
   * Also the detection seam for a terminal provider error / logged-out row
   * ({@link getClaudeAgentErrorLine}: `API Error: …`, `⎿ … · API Error: …`, or
   * `⎿ … Please run /login`): when it first classifies, emit one `apiError`
   * event — the trigger for the auto-retry (transient / usageLimit) OR the
   * surfaced logged-out notice (auth). Detection scans the NEW pane delta only
   * (never the full pane / arbitrary conversation text), so a recognized error
   * row fires exactly once — when it first renders.
   *
   * A large new chunk (`newPart.length > 50`) means real conversation moved on,
   * so the one-shot `handled*` guards are reset to re-arm for a later prompt.
   */
  private handleAutoLifecycle(session: ClaudeSession, content: string, newPart: string): void {
    if (newPart.length > 50) {
      session.handledAutoEnter = false;
      session.handledAutoAccept = false;
      session.handledApiError = false;
    }

    if (!session.handledApiError) {
      // Scan the NEW delta, NOT the full pane: a logged-out `⎿ … /login` (or
      // `API Error:`) row lingers in the scrollback long after the user re-logs
      // in, and the guard above re-arms on any >50-char redraw during the login
      // flow — scanning `content` re-fired `apiError('auth')` on every poll, so
      // the recovery clear (first real output) and this re-fire oscillated:
      // re-pinning "logged out, run /login" AFTER a successful login and burying
      // the real answer (live 2026-07-03, topic 434). The line-SET pane diff
      // (getNewPaneContent) puts the row in `newPart` only on its FIRST
      // appearance → one fire per genuine logout episode. The resume-seed caller
      // passes the full pane AS newPart, so an adopted logged-out session still
      // surfaces once.
      const apiErrorLine = getClaudeAgentErrorLine(newPart);
      if (apiErrorLine) {
        const apiError: AgentApiErrorClass | null = classifyAgentApiError(apiErrorLine, Date.now());
        if (apiError) {
          session.handledApiError = true;
          console.log(`[Claude] API error detected (${apiError.kind}): ${apiErrorLine.trim()}`);
          this.emit('apiError', session.key, apiError);
        }
      }
    }

    if (!session.handledAutoEnter && this.checkNeedsAutoEnter(content)) {
      session.handledAutoEnter = true;
      console.log(`[Claude] Auto-pressing Enter`);
      session.autoEnterTimer = setTimeout(() => {
        session.autoEnterTimer = null;
        if (!session.isActive) return;
        this.enqueueTmuxBestEffort(session, async () => {
          if (!session.isActive) return '';
          return tmuxAsync('send-keys', '-t', session.sessionName, 'Enter');
        });
      }, 300);
    }

    if (!session.handledAutoAccept && this.checkNeedsAutoAccept(content)) {
      session.handledAutoAccept = true;
      console.log(`[Claude] Auto-accepting bypass permissions`);
      session.autoAcceptOuterTimer = setTimeout(() => {
        session.autoAcceptOuterTimer = null;
        if (!session.isActive) return;
        this.enqueueTmuxBestEffort(session, async () => {
          if (!session.isActive) return '';
          return tmuxAsync('send-keys', '-t', session.sessionName, 'Down');
        });
        session.autoAcceptInnerTimer = setTimeout(() => {
          session.autoAcceptInnerTimer = null;
          if (!session.isActive) return;
          this.enqueueTmuxBestEffort(session, async () => {
            if (!session.isActive) return '';
            return tmuxAsync('send-keys', '-t', session.sessionName, 'Enter');
          });
        }, 100);
      }, 300);
    }
  }

  private checkNeedsAutoEnter(content: string): boolean {
    return CLAUDE_AUTO_ENTER_PATTERNS.some(pattern => pattern.test(content));
  }

  private checkNeedsAutoAccept(content: string): boolean {
    const hasWarning = CLAUDE_BYPASS_WARNING_RE.test(content);
    const hasAccept = CLAUDE_BYPASS_ACCEPT_RE.test(content);
    if (hasWarning || hasAccept) {
      console.log(`[Claude] checkNeedsAutoAccept: warning=${hasWarning}, accept=${hasAccept}`);
    }
    return hasWarning && hasAccept;
  }

}
