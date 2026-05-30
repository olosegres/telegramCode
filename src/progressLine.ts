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
 * The same applies to `/compact`, whose progress is a different shape — a
 * `Compacting conversation… N%` verb line plus a `▰▰▱▱` bar line, with no
 * token stats — caught by {@link COMPACT_VERB_LINE_RE} + {@link
 * PROGRESS_BAR_LINE_RE}. {@link collapseProgressChunk} then trims a redraw
 * burst down to its latest frame so the rolling message shows only the
 * current percentage, not every intermediate one.
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
 * @description Spinner/verb line of Claude's `/compact` progress, e.g.
 * `✻ Compacting conversation… (1m 22s)` or the bare `✶ Compacting
 * conversation…` before the timer starts.
 *
 * Unlike {@link PROGRESS_LINE_RE} this carries NO token stats — compaction
 * only shows an elapsed-time parenthesis (`(22s)` / `(1m 22s)`) or nothing.
 * The verb may be multiple words (`Compacting conversation`), so the body is
 * `\S.*…` (anything ending in the ellipsis) rather than a single token.
 *
 * Because that body is broad, this line on its own is NOT enough to call a
 * chunk "progress": {@link checkIsProgressChunk} only accepts the compaction
 * shape when the chunk ALSO contains a {@link PROGRESS_BAR_LINE_RE} bar line,
 * so a real `●`-prefixed answer that happens to end in `…` is never mistaken
 * for a transient status frame.
 */
export const COMPACT_VERB_LINE_RE =
  /^\s*[✻✽✶✢·*●○]\s+\S.*…\s*(?:\(\s*(?:\d+m\s+)?\d+s\s*\))?\s*$/;

/**
 * @description Progress-bar line of Claude's `/compact`, e.g.
 * `▰▰▰▰▰▰▱▱▱▱▱▱ 15%`. A run of filled/empty bar cells (U+25B0 `▰` /
 * U+25B1 `▱`) optionally followed by a percentage.
 *
 * The percentage is optional because a terminal-redraw scrape can clip the
 * trailing `N%` mid-frame; such a fragment must still count as progress (so
 * it never floods the topic) and {@link collapseProgressChunk} falls back to
 * the filled-cell count for ordering it. The `{4,}` cell run is the
 * high-signal anchor (bar cells never appear in real prose) that lets the
 * looser {@link COMPACT_VERB_LINE_RE} be admitted safely.
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

  // `/compact` progress — a redraw burst of "Compacting conversation… N%"
  // frames. Anchored on at least one bar line so the loose verb regex can't
  // swallow a real `●`-prefixed answer; every other line must still be a
  // bar, a compaction verb line, or a thinking tick (mixed bursts happen
  // when the scrape diff straddles a thinking→compaction transition).
  const hasBarLine = lines.some(line => PROGRESS_BAR_LINE_RE.test(line));
  if (
    hasBarLine &&
    lines.every(
      line =>
        PROGRESS_BAR_LINE_RE.test(line) ||
        COMPACT_VERB_LINE_RE.test(line) ||
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
 * @description Reduce a progress chunk (see {@link checkIsProgressChunk}) to
 * the single most-recent frame, so the coalesced status message rolls in
 * place instead of stacking every intermediate tick/percentage.
 *
 * - thinking-spinner chunk → the last tick line (time only grows, scrape is
 *   in order, so "last" is "latest").
 * - `/compact` chunk → the highest-percentage bar line (a redraw scrape can
 *   arrive out of order, and `%` only grows, so max is the true latest)
 *   prefixed with the most recent `Compacting conversation…` verb line for
 *   context. The pair mirrors Claude's own two-line frame.
 *
 * Must only be called on a chunk that {@link checkIsProgressChunk} accepted.
 */
export function collapseProgressChunk(text: string): string {
  const lines = text.split('\n').filter(l => l.trim().length > 0);

  const barLines = lines.filter(line => PROGRESS_BAR_LINE_RE.test(line));
  if (barLines.length === 0) {
    return lines[lines.length - 1].trim();
  }

  const latestBar = barLines.reduce((best, line) =>
    getProgressBarPercent(line) >= getProgressBarPercent(best) ? line : best,
  );
  const verbLines = lines.filter(
    line => COMPACT_VERB_LINE_RE.test(line) && !PROGRESS_BAR_LINE_RE.test(line),
  );
  const latestVerb = verbLines.length > 0 ? verbLines[verbLines.length - 1].trim() : null;

  return latestVerb ? `${latestVerb}\n${latestBar.trim()}` : latestBar.trim();
}
