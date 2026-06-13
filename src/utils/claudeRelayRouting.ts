/**
 * @description PURE decision layer that routes the {@link ClaudeChunkSegment}s
 * of one classified Claude scrape chunk through a thread's display-verbosity
 * prefs (S4 `/tool_results`). Given the ordered, tagged segments and the
 * resolved prefs it decides — per segment — whether the lines are RELAYED as
 * permanent output, TRUNCATED, or FOLDED into the rolling status frame, and
 * returns the reassembled permanent text plus the latest folded activity line.
 *
 * Kept pure (no tmux / emit) so the segment×pref matrix is unit-testable
 * without the live relay — same shape as `toolResultRender.ts` /
 * `subagentRender.ts`. The Claude adapter's `pollOutput` calls this, then feeds
 * `keptText` through `stripTuiElementsWithContext` exactly as the pre-S4 path
 * did (the stripper stays the chrome/fence backstop).
 *
 * Scope: the TOOL, THINKING and PANEL-PREVIEW segments branch on a pref.
 *  - `thinkingBlock` follows the `/thinking` pref (S5): full keeps it verbatim;
 *    short collapses to one `💭 thought for {N}s` when a duration is parseable
 *    from the block, else folds the live `☁️ thinking …` into status; minimal
 *    always folds the live status, nothing permanent.
 *  - `subagentPanelPreview` is ALWAYS folded to status (the overview-2 flood;
 *    S6 formalises, doing it here is part of killing the flood).
 *  - `prose` is ALWAYS kept (the agent's answer is never swallowed).
 *  - `chrome` is ALWAYS dropped (as the pre-S4 stripper did).
 */

import { ClaudeChunkTag, type ClaudeChunkSegment } from './claudeChunkClassifier';
import { getTruncatedToolResult } from './toolResultRender';
import { parseThinkingDurationSeconds } from './thinkingRender';
import type { DisplayVerbosityMode } from '../types';

/** Tool names Claude's known headers carry, used to derive a compact activity
 * label (`Bash`, `Read`, …). Matches the set in `claudeScrapeShapes.ANY_TOOL_HEADER_RE`. */
const TOOL_NAME_RE =
  /\b(Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|Task|Agent|TodoWrite|WebFetch|WebSearch)\b/;

/** Result of {@link routeClaudeChunkSegments}. */
export interface ClaudeRelayRouting {
  /** The lines to relay as PERMANENT output (reassembled, NL-joined). May be
   * empty when every routable segment folded to status. */
  keptText: string;
  /** The LATEST folded activity (a `minimal` tool header, a panel preview, or a
   * folded `☁️ thinking …` status) to show in the rolling status frame, or null
   * when nothing folded. */
  activityLine: string | null;
}

/**
 * @description Extract a compact tool label from a tool-header line for the
 * folded `minimal` activity line. Returns the tool NAME (`Bash`, `Read`, …)
 * when recognised, else the trimmed first line as a last resort (never empty).
 */
export function getToolActivityLabel(headerText: string): string {
  const firstLine = headerText.split('\n')[0] ?? '';
  const nameMatch = firstLine.match(TOOL_NAME_RE);
  if (nameMatch) return nameMatch[1];
  return firstLine.trim();
}

/**
 * @description Route one classified chunk's segments through the tool-results
 * mode (S4). Walks the segments IN ORDER so `keptText` preserves the pane's
 * line order; `activityLine` carries only the LAST folded activity (the status
 * frame shows one line). Pure — the caller threads cross-poll fence context and
 * does the strip/emit.
 *
 * Per tag:
 *  - `prose`                → keep verbatim (always).
 *  - `thinkingBlock`        → full: keep verbatim; short: collapse to one
 *                             `💭 thought for {N}s` when a duration is parseable,
 *                             else fold the live `☁️ thinking …`; minimal: always
 *                             fold the live status, nothing permanent.
 *  - `toolHeader`/`toolBody`→ full: keep; short: keep header, truncate body;
 *                             minimal: drop, fold a `🔧 <tool> …` activity from
 *                             the latest header (built by the caller via i18n).
 *  - `subagentPanelPreview` → always fold (drop, contribute an activity).
 *  - `chrome`               → drop.
 *
 * @param segments classified segments, original order.
 * @param toolResultsMode the thread's `/tool_results` pref.
 * @param thinkingMode the thread's `/thinking` pref (S5).
 * @param buildToolActivity caller-supplied builder turning a tool label into a
 *   user-facing activity line (keeps i18n in `bot.ts`/`i18n.ts`, not here).
 * @param buildPanelActivity caller-supplied builder for a folded panel preview.
 * @param buildThinkingActivity caller-supplied builder for the folded live
 *   `☁️ thinking …` status line (short with no duration / minimal).
 * @param buildThoughtCollapsed caller-supplied builder turning a parsed duration
 *   into the permanent `💭 thought for {N}s` line (short with a duration).
 * @param truncationFooter the i18n "… (truncated, /tool_results full)" line
 *   appended to a `short`-mode body that was actually capped — parity with the
 *   OpenCode short path so a Claude user also learns `full` reveals the rest.
 */
export function routeClaudeChunkSegments(
  segments: ClaudeChunkSegment[],
  toolResultsMode: DisplayVerbosityMode,
  thinkingMode: DisplayVerbosityMode,
  buildToolActivity: (toolLabel: string) => string,
  buildPanelActivity: () => string,
  buildThinkingActivity: () => string,
  buildThoughtCollapsed: (seconds: number) => string,
  truncationFooter: string,
): ClaudeRelayRouting {
  const keptLines: string[] = [];
  let activityLine: string | null = null;
  /** The most recent tool-header label, so a minimal-mode body folds under its
   * own header's label even when the header arrived in a separate segment. */
  let latestToolLabel: string | null = null;

  for (const segment of segments) {
    switch (segment.tag) {
      case ClaudeChunkTag.Prose:
        keptLines.push(segment.text);
        break;

      case ClaudeChunkTag.ThinkingBlock: {
        if (thinkingMode === 'full') {
          keptLines.push(segment.text);
        } else {
          // short/minimal: collapse to a permanent "💭 thought for {N}s" only
          // when short AND a duration is parseable from the scraped block;
          // otherwise fold the live "☁️ thinking …" into the status frame.
          const seconds = parseThinkingDurationSeconds(segment.text);
          if (thinkingMode === 'short' && seconds !== null) {
            keptLines.push(buildThoughtCollapsed(seconds));
          } else {
            activityLine = buildThinkingActivity();
          }
        }
        break;
      }

      case ClaudeChunkTag.ToolHeader: {
        latestToolLabel = getToolActivityLabel(segment.text);
        if (toolResultsMode === 'minimal') {
          activityLine = buildToolActivity(latestToolLabel);
        } else {
          // full and short both keep the header verbatim (short only caps the
          // body — the header names which tool ran).
          keptLines.push(segment.text);
        }
        break;
      }

      case ClaudeChunkTag.ToolBody: {
        if (toolResultsMode === 'full') {
          keptLines.push(segment.text);
        } else if (toolResultsMode === 'short') {
          const truncated = getTruncatedToolResult(segment.text);
          keptLines.push(truncated.isTruncated ? `${truncated.text}\n${truncationFooter}` : truncated.text);
        } else {
          // minimal: drop the body; fold under the latest header's label (or a
          // generic 🔧 when a body's header streamed in a prior poll).
          activityLine = buildToolActivity(latestToolLabel ?? '');
        }
        break;
      }

      case ClaudeChunkTag.SubagentPanelPreview:
        activityLine = buildPanelActivity();
        break;

      case ClaudeChunkTag.Chrome:
        break;
    }
  }

  return { keptText: keptLines.join('\n'), activityLine };
}

/**
 * @description Whether a classified chunk can skip the segment-walk and run the
 * pre-S4 direct strip→emit path BYTE-IDENTICALLY: all-`full` tool + thinking
 * prefs AND no sub-agent panel-preview segment (the one thing the old path did
 * NOT fold). The regression anchor — when true the relay output is provably the
 * same as before S4. (Re-exported as a named helper so the live fast-path and
 * its test assert the SAME predicate.)
 */
export function checkIsClaudeRelayFastPath(
  segments: ClaudeChunkSegment[],
  toolResultsMode: DisplayVerbosityMode,
  thinkingMode: DisplayVerbosityMode,
): boolean {
  if (toolResultsMode !== 'full' || thinkingMode !== 'full') return false;
  return !segments.some(segment => segment.tag === ClaudeChunkTag.SubagentPanelPreview);
}
