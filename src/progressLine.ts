/**
 * @description Detect Claude-CLI "thinking" progress lines so the bot can
 * collapse a long burst of them into a single edited Telegram message
 * instead of flooding the topic with one message per poll tick.
 *
 * Claude's TUI redraws a spinner roughly every 300 ms while the agent is
 * thinking. The line looks like:
 *
 *     <glyph> <Verb>… (Xm Ys · ↑/↓ X.Xk tokens [ · <thinking-note>])
 *
 * where `<glyph>` rotates through `✻ ✽ ✶ ✢ · *` (plus `●/○` for bullet
 * states), `<Verb>` is one of Claude's activity words (Smooshing,
 * Actioning, Coalescing, Newspapering, Booping, …) and the trailing
 * parenthesis updates time / tokens / thinking-mode every tick.
 *
 * The bot already routes adapter `status` events through a coalescer
 * that edits one message in place; the gap was that long bursts of
 * progress lines (≥ 4 lines per poll diff, or any line that pushes
 * the chunk over the adapter's `checkIsStatusOutput` length / line
 * heuristic) were misclassified as substantive `output` and flooded
 * the thread. {@link checkIsProgressChunk} is the adapter-agnostic
 * safety net: every non-empty line in the chunk must match the regex,
 * so mixed chunks with real prose still fall back to the normal
 * output path with no regression.
 *
 * Verb transitions (`Newspapering` → `Coalescing` → `Booping`) all match
 * the same regex and therefore stay in the same coalesced message — the
 * user sees the latest verb on the rolling line, never a stream of
 * separate "Now Newspapering" / "Now Coalescing" messages.
 *
 * The same applies to `/compact` (and the automatic context compaction),
 * whose progress is a different shape — a `Compacting conversation…` verb
 * line (with or without a `(Xs)` / `(Xs · ↑ X.Xk tokens)` stats parenthesis)
 * optionally accompanied by a `▰▰▱▱` bar line — caught by {@link
 * COMPACT_LINE_RE} + {@link PROGRESS_BAR_LINE_RE}. The verb line is anchored
 * on the literal `Compacting conversation` phrase, so a bar line is no longer
 * required to admit it (auto-compaction frequently redraws the verb line on
 * its own, with no bar in the diff). {@link collapseProgressChunk} then trims
 * a redraw burst down to its latest frame so the rolling message shows only
 * the current state, not every intermediate one.
 *
 * A third transient shape is the **sub-agent task panel**: while a Task
 * sub-agent runs, Claude redraws a `◯ <type>  <title>  <elapsed> · ↓ <tokens>`
 * line every tick (the trailing time/tokens change each second, so the diff
 * sees every tick as new and the topic floods). {@link
 * SUBAGENT_PROGRESS_LINE_RE} catches it (anchored on the `◯` U+25EF
 * sub-agent glyph, distinct from the `○` spinner / `●` bullet glyphs), and
 * {@link collapseProgressChunk} keeps only the latest frame of each distinct
 * task (a fan-out shows several `◯` lines at once), squeezing the TUI
 * right-alignment padding down to single spaces.
 *
 * Kept in its own module (not inlined in `bot.ts`) so the regex is the
 * single source of truth shared with `progressLine.test.ts`, and so the
 * detection logic can be reused by future adapters (OpenCode, etc.)
 * without exporting bot-internal helpers.
 */

/**
 * @description Single-line regex for one Claude-CLI progress tick.
 *
 * Structure (each group commented):
 *
 *   ^\s*                              leading whitespace (TUI indent)
 *   [✻✽✶✢·*●○]                       spinner glyph (full observed set)
 *   \s+\S+…                           one verb token ending in U+2026
 *                                     ellipsis (no hardcoded verb list →
 *                                     new verbs work automatically)
 *   \s*\(                             stats parenthesis opens
 *   \d+m\s+\d+s                       elapsed time, e.g. "3m 14s"
 *   \s*·\s*[↑↓]\s*[\d.]+k?\s*tokens   token counter, e.g. "↑ 4.4k tokens"
 *   (?:\s*·[^()]*)?                   optional thinking-note suffix
 *                                     ("thought for 9s", "thinking with
 *                                     xhigh effort", "still thinking
 *                                     with xhigh effort", "thinking
 *                                     more with xhigh effort"). `[^()]*`
 *                                     refuses nested parens so a real
 *                                     prose sentence with parentheses
 *                                     cannot be mistaken for a tick.
 *   \)\s*$                            stats parenthesis closes; line ends
 *
 * The `\S+…` "any verb followed by ellipsis" pattern is deliberately
 * greedy-free of a whitelist. Claude has shipped at least Smooshing /
 * Actioning / Coalescing / Newspapering / Booping / Flowing /
 * Cogitating / Pondering / Mussing / etc. — any new word will fit so
 * long as it's a single token before the ellipsis.
 */
export const PROGRESS_LINE_RE =
  /^\s*[✻✽✶✢·*●○]\s+\S+…\s*\(\d+m\s+\d+s\s*·\s*[↑↓]\s*[\d.]+k?\s*tokens(?:\s*·[^()]*)?\)\s*$/;

/**
 * @description Verb line of Claude's `/compact` (and automatic context
 * compaction) progress. Observed shapes:
 *   `✶ Compacting conversation…`                          (before the timer)
 *   `✻ Compacting conversation… (1m 22s)`                 (elapsed time only)
 *   `· Compacting conversation… (48s · ↑ 3.1k tokens)`    (time + token stats)
 *
 * Anchored on the literal `Compacting conversation` phrase, followed by the
 * ellipsis and an OPTIONAL `(…)` stats parenthesis (`[^()]*` so a real prose
 * sentence with nested parens can't stretch the match). The phrase anchor is
 * specific enough that this line on its own is safe to treat as progress —
 * unlike a broad `\S.*…` body, it can never collide with a real `●`-prefixed
 * answer, so {@link checkIsProgressChunk} no longer needs a bar line to admit
 * it (auto-compaction redraws the verb line with no bar in the diff).
 */
export const COMPACT_LINE_RE =
  /^\s*[✻✽✶✢·*●○]\s+Compacting conversation…\s*(?:\([^()]*\))?\s*$/;

/**
 * @description Sub-agent task line of Claude's TUI, redrawn every tick while a
 * Task sub-agent runs, e.g.
 *   `◯ general-purpose  Move styles into solClientKit          6m 50s · ↓ 120.2k tokens`
 * optionally prefixed with the `❯` selection cursor, optionally without the
 * trailing stats (right after the sub-agent starts, before its timer shows).
 *
 * Anchored on the `◯` (U+25EF) sub-agent glyph — deliberately distinct from
 * the `○` (U+25CB) thinking spinner and the `●` (U+25CF) tool/result bullet,
 * so a `● Bash(…)` tool call or a `○ Thinking…` tick is never mistaken for a
 * sub-agent frame. The trailing time/token counter changes each second, which
 * is exactly why the pane diff sees every tick as a new line and the topic
 * floods without collapsing.
 */
export const SUBAGENT_PROGRESS_LINE_RE = /^\s*(?:❯\s+)?◯\s+\S.*$/;

/**
 * @description Progress-bar line of Claude's `/compact`, e.g.
 * `▰▰▰▰▰▰▱▱▱▱▱▱ 15%`. A run of filled/empty bar cells (U+25B0 `▰` /
 * U+25B1 `▱`) optionally followed by a percentage.
 *
 * The percentage is optional because a terminal-redraw scrape can clip the
 * trailing `N%` mid-frame; such a fragment must still count as progress (so
 * it never floods the topic) and {@link collapseProgressChunk} falls back to
 * the filled-cell count for ordering it. The `{4,}` cell run is a high-signal
 * anchor (bar cells never appear in real prose), so a bar line on its own is
 * always treated as progress; {@link COMPACT_LINE_RE} carries its own phrase
 * anchor and no longer relies on a bar being present.
 */
export const PROGRESS_BAR_LINE_RE = /^\s*[▰▱]{4,}(?:\s*\d{1,3}\s*%?)?\s*$/;

/**
 * @description Return `true` iff `text` consists exclusively of Claude
 * progress lines.
 *
 * Splits on `\n`, drops empty / whitespace-only lines, and requires that
 * the remaining array is non-empty **and every line matches**
 * {@link PROGRESS_LINE_RE}. This means:
 *
 *  - a single tick line → `true`
 *  - a 4-line burst of ticks (one verb, time advancing) → `true`
 *  - a verb-transition burst (Newspapering → Coalescing → Booping) →
 *    `true`, because every individual line still matches
 *  - a chunk that mixes a tick line with real prose → `false`, so the
 *    chunk reaches the normal output pipeline unchanged
 *  - empty string → `false` (nothing to collapse)
 *
 * @example
 *   checkIsProgressChunk('✽ Smooshing… (1m 49s · ↑ 3.3k tokens)') // true
 *   checkIsProgressChunk('Sure, here is the answer…')             // false
 */
export function checkIsProgressChunk(text: string): boolean {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return false;

  // Thinking-spinner burst — every line is a full token-stats tick.
  if (lines.every(line => PROGRESS_LINE_RE.test(line))) return true;

  // Sub-agent task panel redraw — every line is a `◯ <type>  <title> …` frame
  // (a fan-out interleaves several distinct tasks; each still matches).
  if (lines.every(line => SUBAGENT_PROGRESS_LINE_RE.test(line))) return true;

  // Compaction progress — `Compacting conversation…` verb lines (phrase-
  // anchored, so no bar line is needed to admit them), optionally interleaved
  // with `▰▱` bar lines and thinking ticks (a scrape diff can straddle a
  // thinking→compaction transition). Require at least one compaction or bar
  // line so a pure thinking burst is handled by the first branch, not here.
  const hasCompactOrBar = lines.some(
    line => COMPACT_LINE_RE.test(line) || PROGRESS_BAR_LINE_RE.test(line),
  );
  if (
    hasCompactOrBar &&
    lines.every(
      line =>
        COMPACT_LINE_RE.test(line) ||
        PROGRESS_BAR_LINE_RE.test(line) ||
        PROGRESS_LINE_RE.test(line),
    )
  ) {
    return true;
  }

  return false;
}

/**
 * @description Parse the percentage a `/compact` bar line represents, used to
 * pick the latest frame out of a jumbled scrape burst.
 *
 * Prefers the explicit trailing `N%`; falls back to counting filled bar
 * cells (`▰`) when the percentage text was clipped from the diff.
 */
function getProgressBarPercent(line: string): number {
  const percentMatch = line.match(/(\d{1,3})\s*%/);
  if (percentMatch) return Number(percentMatch[1]);
  return (line.match(/▰/g) ?? []).length;
}

/**
 * @description Collapse runs of 2+ whitespace (Claude's TUI right-alignment
 * padding) down to a single space and trim — turns a heavily-padded scrape
 * line into a compact one-liner for Telegram.
 */
function squeezeWhitespace(line: string): string {
  return line.replace(/\s{2,}/g, ' ').trim();
}

/**
 * @description Identity of a sub-agent task line, stable across ticks: the
 * `◯ <type>  <title>` prefix with the trailing `<pad><elapsed> · ↓ <tokens>`
 * stats removed. The pad+stats always begin with 2+ spaces followed by a
 * digit, which the single-spaced title never contains — so cutting at the
 * first such run drops the changing tail without touching the title.
 *
 * The leading `❯` selection cursor is stripped first: it hops on/off a task
 * as the user navigates the panel, so keeping it would split one task into
 * two rolling lines (cursored vs not) within a single burst.
 */
function getSubagentTaskIdentity(line: string): string {
  return squeezeWhitespace(line.replace(/^\s*❯\s+/, '').replace(/\s{2,}\d.*$/, ''));
}

/**
 * @description Reduce a progress chunk (see {@link checkIsProgressChunk}) to
 * the single most-recent frame, so the coalesced status message rolls in
 * place instead of stacking every intermediate tick/percentage.
 *
 * - sub-agent chunk → the latest frame of EACH distinct task (grouped by
 *   {@link getSubagentTaskIdentity}, first-seen order preserved), so a
 *   parallel fan-out shows one rolling line per sub-agent, padding squeezed.
 * - thinking-spinner chunk → the last tick line (time only grows, scrape is
 *   in order, so "last" is "latest").
 * - compaction chunk with a bar → the highest-percentage bar line (a redraw
 *   scrape can arrive out of order, and `%` only grows, so max is the true
 *   latest) prefixed with the most recent `Compacting conversation…` verb
 *   line for context. The pair mirrors Claude's own two-line frame.
 * - compaction chunk with no bar (verb lines only) → the last verb line.
 *
 * Must only be called on a chunk that {@link checkIsProgressChunk} accepted.
 */
export function collapseProgressChunk(text: string): string {
  const lines = text.split('\n').filter(l => l.trim().length > 0);

  // Sub-agent panel: keep the latest frame of each distinct task. A Map keyed
  // by task identity, last write wins, preserves insertion (first-seen) order.
  // The `❯` selection cursor is dropped from both the key and the rendered
  // line so a task reads identically whether or not it's currently selected.
  if (lines.every(line => SUBAGENT_PROGRESS_LINE_RE.test(line))) {
    const latestFrameByTask = new Map<string, string>();
    for (const line of lines) {
      const frame = squeezeWhitespace(line.replace(/^\s*❯\s+/, ''));
      latestFrameByTask.set(getSubagentTaskIdentity(line), frame);
    }
    return [...latestFrameByTask.values()].join('\n');
  }

  const barLines = lines.filter(line => PROGRESS_BAR_LINE_RE.test(line));
  if (barLines.length === 0) {
    return lines[lines.length - 1].trim();
  }

  const latestBar = barLines.reduce((best, line) =>
    getProgressBarPercent(line) >= getProgressBarPercent(best) ? line : best,
  );
  const verbLines = lines.filter(
    line => COMPACT_LINE_RE.test(line) && !PROGRESS_BAR_LINE_RE.test(line),
  );
  const latestVerb = verbLines.length > 0 ? verbLines[verbLines.length - 1].trim() : null;

  return latestVerb ? `${latestVerb}\n${latestBar.trim()}` : latestBar.trim();
}
