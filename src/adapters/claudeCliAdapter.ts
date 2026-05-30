import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentAdapter, AgentSession, ThreadKey } from '../types';
import { keyToString } from '../types';
import { checkIsInstalled, installTool } from '../installManager';
import { prepareMcpFlags, cleanupMcpTempFiles } from '../mcpConfig';
import { resolveDataDir } from '../state';
import { resolveClaudeBinary } from '../utils/resolveBinary';
import { t } from '../i18n';
import { getClaudeAvailableLevels, checkIsClaudeEffortLevel } from '../effortLevels';

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
  /**
   * Signature of the last emitted interactive-question block (the option-label
   * set, ignoring which option is highlighted). Moving the `❯` cursor repaints
   * the whole box every keystroke; comparing signatures lets us deliver the
   * question once and suppress the cursor-move repaints. Cleared when real
   * prose follows (the question is over). See {@link extractClaudeQuestion}.
   */
  lastQuestionSignature: string;
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
}

const pollInterval = 300;

const claudePath = resolveClaudeBinary();
// Audit S3 / #9: session-history file belongs under DATA_DIR (the same
// directory that holds `state.json`), so the two-instance setup keeps its
// promised isolation. Previously this used `$HOME/.claude-sessions.json`,
// which silently collided when two bots ran as the same Linux user.
const sessionsFile = path.join(resolveDataDir(), '.claude-sessions.json');

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
  //
  // Strict regex on each half (audit S1 / #22): plain `Number(...)` accepts
  // `1e5`, `0x10`, `1.5`, `" 42 "`. Such values come from a foreign tmux
  // session whose name happens to share our prefix; treating them as ours
  // would cause `adoptExistingTmuxSession` to attach to an unrelated session.
  if (!name.startsWith('claude-')) return null;
  const rest = name.slice('claude-'.length);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash <= 0) return null;
  const chatIdStr = rest.slice(0, lastDash);
  const threadIdStr = rest.slice(lastDash + 1);
  if (!/^-?\d+$/.test(chatIdStr)) return null;
  if (!/^\d+$/.test(threadIdStr)) return null;
  const chatId = Number(chatIdStr);
  const threadId = Number(threadIdStr);
  if (!Number.isFinite(chatId) || !Number.isFinite(threadId)) return null;
  return { chatId, threadId };
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

/**
 * @description Reject `args` with NUL or other control characters before
 * passing to claude. These are unsafe in shell-quoted contexts (the
 * `'\\''` escape doesn't protect against `\x00`), and tmux/terminals
 * treat them as control sequences. Mirrors `validateSubdir`'s reasoning.
 */
function checkArgsAreSafe(args: string): boolean {
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(args);
}

/** Best-effort tmux call: returns stdout on success, empty string on any error. */
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
 * @description Strict tmux call: throws if tmux exits non-zero (or times out).
 * Used on critical paths (`new-session`, `send-keys` of the claude command
 * line) where silent failure would leave the bot thinking a session
 * started when it didn't. Callers should wrap and translate to a friendly
 * error for the user.
 */
function tmuxOrThrow(...args: string[]): string {
  return execFileSync('tmux', args, {
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();
}

/**
 * @description Convert ANSI escape codes to Telegram Markdown.
 * Uses a marker-based approach: bold-on → \x01, bold-off → \x02,
 * then strips all remaining ANSI, then converts markers to *bold*.
 * Previous regex approach had two bugs:
 * 1) Bold regex consumed \x1B[ of the following sequence, leaking codes like 38;5;231m
 * 2) Cleanup regex \*\s*\* merged adjacent bold sections, removing newlines between them
 */
export function convertAnsiToMarkdown(text: string): string {
  let result = text;

  // Step 0: Strip OSC 8 hyperlink escapes. Plan §2026-05-28
  // tg-output-readability / S2 (C2).
  //
  // The full sequence is one of:
  //   ESC ] 8 ; <params> ; <url> BEL    <visible text>  ESC ] 8 ; ; BEL
  //   ESC ] 8 ; <params> ; <url> ESC\   <visible text>  ESC ] 8 ; ; ESC\
  //
  // ECMA-48 / xterm spec allows either BEL (0x07) or the C1 string
  // terminator `ESC \` (0x1B 0x5C, "ST") as the OSC closer. Live
  // capture from tmux pane shows Claude uses ST, not BEL (see
  // `od -c` of `tmux capture-pane -e -p` during the live V3
  // re-verification on 2026-05-28). The two terminators are
  // interchangeable in the spec; we support both.
  //
  // The downstream control-char filter in `cleanOutput` removes the
  // bare ESC (0x1B) and BEL (0x07) bytes — but the *payload*
  // (`]8;...;file://...`, then duplicated visible text, then `]8;;`)
  // is plain ASCII and falls through, producing live artefacts like
  // `Update(8;id=...;file:///...IDEAS.mdIDEAS.md8;;)` in Telegram.
  // We strip the whole sequence here, while ESC/BEL are still present
  // to anchor the regex, and keep only the visible text in $1.
  //
  // `\\` inside the character class matches a literal backslash, so
  // `(?:\x07|\x1B\\\\)` is "BEL  or  ESC followed by `\`".
  result = result.replace(
    // eslint-disable-next-line no-control-regex
    /\x1B\]8;[^;\x07\x1B]*;[^\x07\x1B]*(?:\x07|\x1B\\)([^\x1B\x07]*)\x1B\]8;;(?:\x07|\x1B\\)/g,
    '$1',
  );

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

  // Drop bold wrappers around a single Claude TUI spinner glyph. Plan
  // §2026-05-28 tg-output-readability / S5 (N3): claude's TUI toggles
  // ANSI bold on the spinner cell every redraw, which our bold→`*X*`
  // conversion above then turns into `*·* Brewing…` / `*✻* Smooshing…`.
  // The glyph itself carries the spinner semantics — the asterisks add
  // nothing and make the rolling status message look broken. Narrow
  // match (listed glyphs only) so a real `*x*` highlight from prose
  // survives.
  result = result.replace(/\*([✻✽✶✢·*●○])\*/g, '$1');

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

export function cleanOutput(text: string): string {
  let cleaned = convertAnsiToMarkdown(text);
  cleaned = cleaned.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '');
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  cleaned = joinBrokenUrls(cleaned);
  // Trim trailing whitespace on every line WITHOUT dropping the line
  // itself. Plan §2026-05-28 tg-output-readability / S1 (C1):
  // `tmux capture-pane -e` pads every pane line with trailing spaces to
  // terminal width, so a "blank" paragraph separator arrives as e.g.
  // "                                                                    "
  // (not ""). The previous filter dropped any whitespace-only line,
  // gluing two paragraphs together in Telegram. Per-line trim preserves
  // the line, leaves a bare empty string in its place, and lets the
  // `\n{3,}→\n\n` collapse below normalise sequences of newlines.
  cleaned = cleaned.replace(/[ \t]+$/gm, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
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
export function checkIsStatusOutput(text: string): boolean {
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
    // A short answer fragment that ends a sentence ("Done.", "OK.", "Found 3
    // bugs.") is real content, not a spinner — spinners always carry a `…`, a
    // glyph, or token stats (caught above). Don't swallow it into a status.
    const isShortSentence = /[а-яёa-z]{2,}/i.test(trimmed) && /[.!?]$/.test(trimmed);
    // Very short line without sentence-like structure (two 3+ letter words) — likely a lone spinner/icon
    if (trimmed.length < 40 && !isShortSentence && !/[а-яёa-z]{3,}\s+[а-яёa-z]{3,}/i.test(trimmed)) return true;
    return false;
  });
}

/**
 * @description Active spinner tick, per-line shape used by Claude's TUI
 * while it is thinking or running a tool. Examples:
 *   `✽ Doing… (4s · ↓ 14 tokens)`
 *   `* Brewing… (1m 30s · ↑ 88 tokens · thought for 17s)`
 *   `· Working… (7s · ↓ 222 tokens)`
 *
 * Plan §2026-05-28 tg-output-readability / S4 (N1.b). Why a SECOND
 * regex on top of `PROGRESS_LINE_RE` (in `progressLine.ts`): the
 * canonical regex requires `\d+m\s+\d+s` (a full minute count); short
 * runs under 60s render as just `5s` and slip past it. The relaxed
 * `\d+(?:m\s+\d+)?s` here accepts both shapes. We deliberately do NOT
 * loosen `PROGRESS_LINE_RE` because the bot-side coalescer
 * (`checkIsProgressChunk`) relies on its current strictness as an
 * anti-false-positive guard.
 *
 * The required `\S+…` verb-with-ellipsis disambiguates this from a
 * tool-call header (`● Bash(ls -la)`), which starts with the same
 * `●` glyph but has no ellipsis.
 */
const SPINNER_TICK_RE =
  /^\s*[✻✽✶✢·*●○]\s+\S+…\s*\(\d+(?:m\s+\d+)?s(?:\s*·[^()]*)?\)\s*$/;

/**
 * @description Post-thinking trailer line that Claude's TUI prints
 * AFTER it has finished thinking (just before resuming the prompt
 * area). Examples observed in the live ExampleGroup debug session:
 *   `✻ Cooked for 27s`        (msg 1855, 1863)
 *   `✻ Cogitated for 20s`     (msg 1873)
 *   `✻ Crunched for 7s`       (msg 1869)
 *   `✻ Baked for 10s`         (msg 1837)
 *   `✻ Churned for 20s`       (msg 1897 — V3 iteration 1, 2026-05-28)
 *   `✻ Sautéed for 20s`       (msg 1909 — V3 iteration 2, 2026-05-28)
 *
 * Plan §2026-05-28 tg-output-readability / S3 (N1.a). The trailer
 * carries zero novel info — the same time was already streaming in
 * the active spinner that preceded it — so we drop it.
 *
 * Verb match is `\S+`, not an explicit list. The original plan called
 * for an explicit list of `-ed` forms (Cooked|Cogitated|...) on the
 * theory that a future Claude verb that IS real prose (e.g.
 * `✻ Ready for input`) could be silently swallowed. Two live V3
 * iterations on 2026-05-28 demonstrated the opposite failure mode:
 * Claude ships new spinner verbs faster than we'd realistically
 * extend the list (`Churned` and `Sautéed` both slipped through on
 * first encounter). The triple anchor `<glyph> <verb> for <N>s` is
 * shape-specific enough that real prose almost cannot satisfy it:
 *   - line must START with a spinner glyph (`✻✽✶✢·*●○`) — outside
 *     transient TUI status, Claude never emits these as the first
 *     non-whitespace char of a prose line;
 *   - line must END with `for \d+(?:m\s+\d+)?s` — a time literal,
 *     not a generic noun;
 *   - line has no other content (anchored `$`).
 * `\S+` is the minimal relaxation: one non-whitespace token between
 * the glyph and ` for `. Accepts `Sautéed`, `Churned`, future verbs,
 * and rejects anything containing whitespace or extra structure.
 */
const POST_THINKING_TRAILER_RE =
  /^[✻✽✶✢·*●○]\s+\S+\s+for\s+\d+(?:m\s+\d+)?s\s*$/;

/**
 * @description A single interactive question Claude scraped from the pane,
 * rendered for durable delivery.
 */
export interface ClaudeQuestion {
  /** Header + every numbered option (highlighted one kept), ready to send. */
  text: string;
  /**
   * Stable across cursor moves — the option-label set, ignoring which option
   * is currently highlighted. Two `❯`-cursor positions over the same options
   * yield the same signature, so the bot delivers the question once.
   */
  signature: string;
}

/** Box-drawing chars Claude's TUI wraps option/question lines in. */
const QUESTION_BORDER_REGEX = /^[│┃]\s?|\s*[│┃]\s*$/g;
/** Numbered option line, optionally cursor-highlighted, optionally boxed. */
const QUESTION_OPTION_REGEX = /^(❯\s*)?(\d{1,2})[.)]\s+(\S.*?)\s*$/;
/** Lines that are pure chrome (borders / blanks / nav hints), never prose. */
const QUESTION_CHROME_REGEX =
  /^[╭╮╰╯─━│┃\s]*$|Enter to select|esc to|↑↓|↑\/↓|to cycle|shift\+tab|to confirm|to submit|use arrow/i;
/** A positive "this is an interactive prompt" signal near the option group. */
const QUESTION_SELECT_HINT_REGEX = /Enter to select|to select|↑↓|↑\/↓|use arrow|esc to/i;
const QUESTION_MIN_OPTIONS = 2;
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

function stripQuestionBoxBorder(line: string): string {
  return line.replace(QUESTION_BORDER_REGEX, '');
}

function checkIsOptionLine(line: string): boolean {
  return QUESTION_OPTION_REGEX.test(line);
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
  return QUESTION_CHROME_REGEX.test(line);
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
 */
export function extractClaudeQuestion(text: string): ClaudeQuestion | null {
  const lines = text.split('\n').map(line => stripQuestionBoxBorder(line).trim());

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

  const options = lines
    .slice(start, end + 1)
    .filter(checkIsOptionLine)
    .map(line => {
      const match = line.match(QUESTION_OPTION_REGEX)!;
      return { highlighted: Boolean(match[1]), number: match[2], label: match[3].trim() };
    });
  if (options.length < QUESTION_MIN_OPTIONS) return null;

  // Positive interactive signal, or it's not a real choice prompt.
  const hasCursor = options.some(option => option.highlighted);
  const tail = lines.slice(end + 1, end + 1 + QUESTION_HINT_LOOKAHEAD).join('\n');
  if (!hasCursor && !QUESTION_SELECT_HINT_REGEX.test(tail)) return null;

  // Header: skip the blank/border gap above the options, then collect the
  // contiguous prose line(s) above that.
  let h = start - 1;
  while (h >= 0 && checkIsQuestionChrome(lines[h])) h--;
  const headerLines: string[] = [];
  while (h >= 0 && !checkIsOptionLine(lines[h]) && !checkIsQuestionChrome(lines[h])) {
    headerLines.unshift(lines[h]);
    h--;
  }

  const header = headerLines.join('\n').trim();
  const renderedOptions = options
    .map(option => `${option.highlighted ? '❯' : ' '} ${option.number}. ${option.label}`)
    .join('\n');
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

export function stripTuiElements(text: string): string {
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

    if (inUserTurnEcho) {
      if (/^\s+\S/.test(line)) continue;
      inUserTurnEcho = false;
    }
    if (/^❯\s+\S/.test(line)) {
      inUserTurnEcho = true;
      continue;
    }

    if (/^[─━]+$/.test(line.trim())) continue;
    if (/⏵⏵\s*(bypass permissions|accept edits)\s*(on|off)/i.test(line)) continue;
    if (/^❯/.test(line)) continue;
    // Ephemeral UI hint Claude prints under a turn ("⎿  Tip: Use Plan Mode…").
    // Require the `⎿` marker so plain prose starting with "Tip:" is NOT eaten.
    if (/^\s*⎿\s*Tip:\s/i.test(line)) continue;
    if (/\(shift\+tab to cycle\)/i.test(line)) continue;
    if (/^[\s·✽✢✶✻⏵❯─━↵]+$/.test(line)) continue;

    // S3 (N1.a) / S4 (N1.b): per-line strip of mid-chunk spinner ticks
    // and post-thinking trailers. These shapes used to slip through
    // `checkIsStatusOutput` (adapter side) and `checkIsProgressChunk`
    // (bot side) when they appeared mixed with real output in a single
    // poll diff (msg 1853, 1855, 1863 in the debug session).
    if (SPINNER_TICK_RE.test(line)) continue;
    if (POST_THINKING_TRAILER_RE.test(line.trim())) continue;

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
  // Audit S15 / #42: previously every read error was swallowed; a
  // corrupt JSON file (single edit gone wrong) would silently look like
  // "no sessions" forever. Log so the operator notices; archive the
  // bad file so subsequent writes start clean.
  try {
    if (!fs.existsSync(sessionsFile)) return [];
    const raw = fs.readFileSync(sessionsFile, 'utf-8');
    return JSON.parse(raw) as StoredSession[];
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    console.error(`[Claude] loadStoredSessions failed (${code ?? 'parse'}):`, e instanceof Error ? e.message : e);
    if (fs.existsSync(sessionsFile)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const archive = `${sessionsFile}.corrupted-${ts}`;
      try {
        fs.renameSync(sessionsFile, archive);
        console.warn(`[Claude] archived corrupt sessions file to ${archive}`);
      } catch (re) {
        console.warn(`[Claude] failed to archive corrupt sessions file:`, re);
      }
    }
    return [];
  }
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
  } catch (e) {
    console.error(`[Claude] saveStoredSession failed:`, e instanceof Error ? e.message : e);
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

  /**
   * @description Schedule the next `pollOutput` for a session. Audit S9 /
   * #37: replaces `setInterval` so a slow `tmux capture-pane` cannot
   * cause overlapping invocations. The handle is stored back on
   * `session.pollTimer` so `stopSession` can cancel the next tick.
   */
  private schedulePoll(key: ThreadKey, session: ClaudeSession): void {
    if (!session.isActive) return;
    session.pollTimer = setTimeout(() => {
      if (!session.isActive) return;
      if (session.isPolling) {
        // Previous poll still in-flight; skip this tick and reschedule.
        this.schedulePoll(key, session);
        return;
      }
      session.isPolling = true;
      try {
        this.pollOutput(key);
      } finally {
        session.isPolling = false;
        this.schedulePoll(key, session);
      }
    }, pollInterval);
  }

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
    tmux('kill-session', '-t', sessionName);

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
    const mcpFlagsArr = prepareMcpFlags({ key, dataDir: resolveDataDir() });
    const claudeArgv: string[] = [
      claudePath,
      '--dangerously-skip-permissions',
      '--session-id', claudeSessionId,
      ...mcpFlagsArr,
      ...(args ? [args] : []),
    ];
    const claudeShellCmd = claudeArgv.map(shellSingleQuote).join(' ');
    try {
      // `-c <workDir>` sets the new session's start directory, avoiding a
      // preceding `cd && …` chain (which would have to be shell-quoted too).
      tmuxOrThrow(
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
      tmux('kill-session', '-t', sessionName);
      cleanupMcpTempFiles({ key, dataDir: resolveDataDir() });
      // Audit S10 / #16: throw so the caller's `await startSession()`
      // sees the failure and skips registering the binding.
      throw new Error(`Failed to start Claude session: ${e instanceof Error ? e.message : String(e)}`);
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
      lastQuestionSignature: '',
      autoEnterTimer: null,
      autoAcceptOuterTimer: null,
      autoAcceptInnerTimer: null,
      isPolling: false,
    };

    this.sessions.set(keyToString(key), session);
    this.schedulePoll(key, session);
    this.emit('started', key);
  }

  stopSession(key: ThreadKey): void {
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
    tmux('send-keys', '-t', session.sessionName, '-l', input);
    tmux('send-keys', '-t', session.sessionName, 'Enter');
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
   * @description Send a single Escape. In Claude's TUI this serves two
   * purposes the bot relies on: (1) cancel an on-screen `AskUserQuestion`
   * selector, and (2) break Claude out of the "busy" state where a typed
   * prompt would otherwise be queued and only answered after the current turn
   * finishes. The bot prepends this before forwarding free-form prompts so
   * messages are acted on immediately instead of piling up in the queue.
   */
  sendEscape(key: ThreadKey): void {
    const session = this.sessions.get(keyToString(key));
    if (!session?.isActive) return;

    console.log(`[Claude] sendEscape`);
    tmux('send-keys', '-t', session.sessionName, 'Escape');
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
   * @description For Claude CLI, model switching is done via the /model slash command.
   * Sends "/model <modelId>" as input to the tmux session. Returns `null`
   * on success (best-effort: claude doesn't ack the change synchronously).
   * Audit S10 / #39: unified signature with OpenCode adapter.
   */
  async setModel(key: ThreadKey, modelId: string): Promise<string | null> {
    this.sendInput(key, `/model ${modelId}`);
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

    if (!checkIsValidUuid(sessionId)) {
      throw new Error(`Invalid sessionId: ${sessionId}`);
    }
    const sessionName = buildTmuxSessionName(key);
    console.log(`[Claude] Resuming session ${sessionId} in ${workDir} for ${keyToString(key)}`);

    tmux('kill-session', '-t', sessionName);

    // Pass the UUID explicitly. If it's unknown to claude, it'll just print a
    // notice and start fresh — better than hanging on a picker. MCP flags
    // are re-applied here so a resumed session sees the same servers as a
    // fresh one would (plan §19). Argv-style shell-quoting mirrors
    // `startSession` (audit S1).
    const mcpFlagsArr = prepareMcpFlags({ key, dataDir: resolveDataDir() });
    const claudeArgv: string[] = [
      claudePath,
      '--dangerously-skip-permissions',
      '--resume', sessionId,
      ...mcpFlagsArr,
    ];
    const claudeShellCmd = claudeArgv.map(shellSingleQuote).join(' ');

    try {
      tmuxOrThrow(
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
      tmux('kill-session', '-t', sessionName);
      cleanupMcpTempFiles({ key, dataDir: resolveDataDir() });
      throw new Error(`Failed to resume Claude session: ${e instanceof Error ? e.message : String(e)}`);
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
      lastQuestionSignature: '',
      autoEnterTimer: null,
      autoAcceptOuterTimer: null,
      autoAcceptInnerTimer: null,
      isPolling: false,
    };

    this.sessions.set(keyToString(key), claudeSession);
    this.schedulePoll(key, claudeSession);
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
  recoverSessionIdFromTmux(sessionName: string): string | null {
    const sessions = tmux('list-sessions', '-F', '#{session_name}');
    if (!sessions.includes(sessionName)) return null;
    const cmd = tmux('display-message', '-p', '-t', sessionName, '#{pane_start_command}');
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

    // Audit S9 / #15: confirm the tmux session has a live child process,
    // not just an empty pane. With `remain-on-exit` semantics or a crashed
    // claude, a session can exist but produce no output forever; adopting
    // it would silently swallow further user input.
    const panesRaw = tmux('list-panes', '-t', sessionName, '-F', '#{pane_pid}');
    const pids = panesRaw.split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s));
    const anyAlive = pids.some(pidStr => {
      try { process.kill(Number(pidStr), 0); return true; }
      catch { return false; }
    });
    if (!anyAlive) {
      console.log(`[Claude] adopt: ${sessionName} has no live child process, killing as zombie`);
      tmux('kill-session', '-t', sessionName);
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
      lastQuestionSignature: '',
      autoEnterTimer: null,
      autoAcceptOuterTimer: null,
      autoAcceptInnerTimer: null,
      isPolling: false,
    };

    // Seed `lastContent` with the current pane snapshot **before** the
    // first poll fires. Without this, the bot's first `pollOutput` after
    // re-adoption would diff a ~2000-line scrollback (hours of stale
    // conversation that survived the restart inside tmux) against `''`
    // — `getNewContent('', x) === x` — and emit every line of it to
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
    const initialRaw = tmux('capture-pane', '-t', sessionName, '-p', '-e', '-S', '-2000');
    if (initialRaw) {
      session.lastContent = cleanOutput(initialRaw);
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

    // Audit S9 / #38: a burst of more than 200 lines between two polls
    // would slide off the top of the capture window before the next poll
    // saw it, breaking the diff and causing duplicate "new" emissions.
    // 2000 lines comfortably covers a long Claude tool-call block; we
    // still diff against `session.lastContent` in memory so the larger
    // capture doesn't grow the output we send to Telegram.
    const raw = tmux('capture-pane', '-t', session.sessionName, '-p', '-e', '-S', '-2000');

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

        // Interactive question/choice prompts are detected on the FULL pane
        // (not this diff): moving the `❯` cursor repaints only the changed
        // option lines, so a signature from the diff would be a partial
        // option set and the de-dup would re-spam the thread on every
        // keystroke. Reading the whole option group keeps the signature
        // stable across cursor moves. Deliver once as durable output — not a
        // transient status frame that gets deleted — and suppress repaints.
        const question = extractClaudeQuestion(content);
        if (question) {
          if (question.signature !== session.lastQuestionSignature) {
            session.lastQuestionSignature = question.signature;
            session.lastStatusText = '';
            this.emit('output', key, `${question.text}\n\n${t('agent.question_hint')}`);
          }
        } else {
          // No question on screen — clear the de-dup so an identical question
          // asked again later is delivered, not silently swallowed.
          session.lastQuestionSignature = '';

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
      }

      if (newPart.length > 50) {
        session.handledAutoEnter = false;
        session.handledAutoAccept = false;
      }

      if (!session.handledAutoEnter && this.checkNeedsAutoEnter(content)) {
        session.handledAutoEnter = true;
        console.log(`[Claude] Auto-pressing Enter`);
        session.autoEnterTimer = setTimeout(() => {
          session.autoEnterTimer = null;
          if (!session.isActive) return;
          tmux('send-keys', '-t', session.sessionName, 'Enter');
        }, 300);
      }

      if (!session.handledAutoAccept && this.checkNeedsAutoAccept(content)) {
        session.handledAutoAccept = true;
        console.log(`[Claude] Auto-accepting bypass permissions`);
        session.autoAcceptOuterTimer = setTimeout(() => {
          session.autoAcceptOuterTimer = null;
          if (!session.isActive) return;
          tmux('send-keys', '-t', session.sessionName, 'Down');
          session.autoAcceptInnerTimer = setTimeout(() => {
            session.autoAcceptInnerTimer = null;
            if (!session.isActive) return;
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
