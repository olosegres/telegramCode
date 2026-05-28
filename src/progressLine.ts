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
  return lines.every(line => PROGRESS_LINE_RE.test(line));
}
