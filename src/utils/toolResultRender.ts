/**
 * @description Pure decision + formatting helpers for rendering a completed
 * tool call's OUTPUT (the OpenCode `toolResult` adapter event, S3). The
 * adapter emits a mode-AGNOSTIC {@link ToolResultEvent}; the bot's
 * `handleAgentToolResult` resolves the per-thread tool-results
 * {@link DisplayVerbosityMode} and
 * consults {@link getToolResultRenderAction} + {@link getTruncatedToolResult}.
 * Extracted from `bot.ts` so the mode matrix and the truncation caps are
 * unit-testable without the Telegraf machinery (same pattern as
 * `thinkingRender.ts`).
 */
import type { DisplayVerbosityMode } from '../types';

// Mode options / type guard / normalization live in the shared
// `utils/displayVerbosity.ts` — the vocabulary is unified across the three
// display commands; this module owns only the tool-result-specific semantics.

/** `short`-mode line cap — applied BEFORE the char cap. */
export const toolResultMaxLines = 15;

/** `short`-mode char cap — applied AFTER the line cap. */
export const toolResultMaxChars = 1200;

/**
 * @name ToolResultRenderAction
 * @description What the bot does with a `toolResult` event in a given mode.
 *
 * - `full`      — render the whole body, fenced.
 * - `truncated` — render the body capped by {@link getTruncatedToolResult},
 *   with a "… (truncated, /tool_results full)" footer when the caps bit.
 * - `drop`      — render nothing (the transient 🔧 status already showed);
 *   the `minimal` mode.
 */
export type ToolResultRenderAction = 'full' | 'truncated' | 'drop';

/**
 * @description Map the per-thread tool-results {@link DisplayVerbosityMode} to
 * a render action. Pure — the matrix is one line per mode, but keeping it a
 * named helper makes it unit-testable and keeps `bot.ts` free of mode-string
 * comparisons (same shape as `getThinkingEventAction`).
 */
export function getToolResultRenderAction(mode: DisplayVerbosityMode): ToolResultRenderAction {
  if (mode === 'minimal') return 'drop';
  return mode === 'short' ? 'truncated' : 'full';
}

/** Result of {@link getTruncatedToolResult}: the (possibly capped) body and
 * whether any cap actually bit — drives the truncation footer. */
export interface TruncatedToolResult {
  text: string;
  isTruncated: boolean;
}

/**
 * @description Truncate a tool-result body to the `short`-mode caps: first
 * {@link toolResultMaxLines} lines, then {@link toolResultMaxChars} chars —
 * whichever cap hits first wins; both may apply. The char cut retreats to the
 * last newline inside the budget so a line is never split mid-way unless a
 * single line alone exceeds the whole char budget (then a hard cut is the only
 * option). A body under both caps is returned unchanged.
 */
export function getTruncatedToolResult(body: string): TruncatedToolResult {
  let text = body;
  let isTruncated = false;

  const lines = text.split('\n');
  if (lines.length > toolResultMaxLines) {
    text = lines.slice(0, toolResultMaxLines).join('\n');
    isTruncated = true;
  }

  if (text.length > toolResultMaxChars) {
    const lastNewlineInBudget = text.lastIndexOf('\n', toolResultMaxChars);
    text = lastNewlineInBudget > 0 ? text.slice(0, lastNewlineInBudget) : text.slice(0, toolResultMaxChars);
    isTruncated = true;
  }

  return { text, isTruncated };
}

/**
 * @description Wrap a tool-result body in a ```` ``` ```` fence for
 * `renderAgentHtml` to turn into `<pre><code>`. Any run of 3+ backticks INSIDE
 * the body (e.g. a read of a markdown file with its own fences) is broken up
 * with zero-width spaces so it can't prematurely close our fence — the body is
 * for reading, not byte-exact copy (same approach as the Claude adapter's
 * `getFenced`). The body is end-trimmed: tool output usually ends with a
 * newline, which would otherwise render as a stray blank line above the
 * closing fence.
 */
export function buildFencedToolResultBody(body: string): string {
  const safeBody = body.trimEnd().replace(/`{3,}/g, run => run.split('').join('​'));
  return `\`\`\`\n${safeBody}\n\`\`\``;
}
