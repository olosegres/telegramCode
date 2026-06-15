/**
 * @description Rolling window of recently-RELAYED Claude pane lines — the
 * long-horizon companion to the per-poll line-set diff (`getNewPaneContent`
 * in `adapters/claudeCliAdapter.ts`).
 *
 * WHY it exists (live incident 2026-06-10, plan
 * `agent/tasks/actual/2026-06-10-claude-stale-rescrape-dedup.md`): the
 * per-poll diff only knows the immediately-previous pane capture. When the
 * Claude TUI re-renders hours-old scrollback (full repaint, scroll-through,
 * resize), the redrawn lines are absent from that previous capture, so the
 * diff classifies them as "new" and re-relays them — chunked and overlapping
 * as the pane scrolls (a topic was flooded with ~12 chunks of a stale ~1400
 * line diff). This window remembers what was actually RELAYED to the topic,
 * so a re-render of already-sent content is suppressed regardless of WHAT
 * triggered the redraw.
 *
 * Locked tradeoff — the SAME direction as the per-poll set diff (see
 * `getNewPaneContent`'s JSDoc): err toward DROPPING a re-render duplicate. A
 * re-send flood is the user-visible bug; a rare suppressed legit repeat (e.g.
 * re-running an identical long command within the window horizon) is a
 * low-cost loss. Like `lastContent`, the window does not self-heal a
 * wrongly-suppressed line within its horizon. Two guards bound the damage:
 * only SUBSTANTIAL lines (≥ {@link relayDedupMinLineLength} after
 * normalization) are ever recorded or suppressed — short lines ("yes",
 * "done", list bullets) repeat legitimately all the time and always pass —
 * and the FIFO bound means old lines eventually evict as new content is
 * relayed.
 */

/**
 * @description Minimum NORMALIZED line length for the window to record or
 * suppress a line. Shorter lines repeat legitimately too often (confirmations,
 * bullets, numbers) to ever be treated as re-render duplicates.
 */
export const relayDedupMinLineLength = 16;

/**
 * @description Window capacity in lines. Sized to cover the incident-scale
 * re-render (a ~1400-line stale diff) with headroom, while keeping the memory
 * bound trivial and letting truly old content evict.
 */
export const relayWindowMaxLines = 1500;

/**
 * @description Normalise a pane line for line-identity comparison: trim, drop
 * a leading status/tool glyph so a tool header matches regardless of which
 * `●/○/⏳/✓` state it was last rendered in.
 *
 * Single source of truth for BOTH dedup layers — the per-poll set diff
 * (`getNewPaneContent`) and this relay window — which MUST share one
 * normalization domain: the window stores the same normalized forms the pane
 * diff compares, otherwise a redraw would slip past one layer or the other.
 */
export function normalizeForComparison(line: string): string {
  return line.trim().replace(/^[●○⏳✓]\s*/, '');
}

/**
 * @description COARSER normalization for the LONG-HORIZON relay-window dedup
 * (record + suppress). Builds on {@link normalizeForComparison} and ADDITIONALLY
 * strips markdown emphasis/code markers (`*`, `_`, `` ` ``, `~`) and collapses
 * whitespace runs.
 *
 * WHY a second, coarser form (live re-emit 2026-06-15): a line that scrolled off
 * and was re-rendered comes back with the SAME text but different emphasis spans
 * — `the Claude *liveness loop* …` one capture, `the Claude *liveness* *loop* …`
 * the next — or shifted padding/wrapping. The per-poll diff's plain
 * normalization left those as DIFFERENT strings, so the window failed to
 * recognise the re-render and re-emitted it. Stripping the volatile markup makes
 * the re-render match.
 *
 * It is a strict COARSENING of {@link normalizeForComparison} (only further
 * transforms its output), so the window still recognises every line the per-poll
 * diff emitted (it can only match MORE, never fewer) — the "no redraw slips past
 * one layer" guarantee holds, WITHOUT touching the per-poll core diff (and group
 * mode), where over-suppression would risk dropping genuinely-new content.
 */
export function normalizeForRelayDedup(line: string): string {
  return normalizeForComparison(line)
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @description Bounded FIFO of normalized, already-relayed pane lines.
 * Created per Claude session; see {@link createRecentRelayWindow}.
 */
export interface RecentRelayWindow {
  /**
   * Store the chunk's substantial lines (normalized). Call ONLY after the
   * chunk was actually emitted as permanent OUTPUT — transient status frames
   * roll in place and never flood as separate messages, so recording them
   * would only risk suppressing genuine output.
   */
  record(chunkText: string): void;
  /**
   * True when the line's normalized form is a substantial line already
   * relayed. Short lines (< {@link relayDedupMinLineLength}) always return
   * false — they are never suppressed.
   */
  checkHasLine(line: string): boolean;
  /** Forget everything (session lifecycle reset points). */
  reset(): void;
}

/**
 * @description Create an empty relay window holding up to `maxLines`
 * normalized lines; the oldest line is evicted first once full.
 */
export function createRecentRelayWindow(maxLines: number = relayWindowMaxLines): RecentRelayWindow {
  /** Insertion-ordered normalized lines — defines eviction order. */
  const lineFifo: string[] = [];
  /** Same lines as `lineFifo`, for O(1) membership checks. */
  const lineSet = new Set<string>();

  return {
    record(chunkText: string): void {
      for (const line of chunkText.split('\n')) {
        const normalized = normalizeForRelayDedup(line);
        if (normalized.length < relayDedupMinLineLength) continue;
        // A line repeated within one chunk must occupy ONE slot, or the FIFO
        // and the Set would desync on eviction.
        if (lineSet.has(normalized)) continue;
        lineFifo.push(normalized);
        lineSet.add(normalized);
        if (lineFifo.length > maxLines) {
          const evictedLine = lineFifo.shift();
          if (evictedLine !== undefined) lineSet.delete(evictedLine);
        }
      }
    },
    checkHasLine(line: string): boolean {
      const normalized = normalizeForRelayDedup(line);
      if (normalized.length < relayDedupMinLineLength) return false;
      return lineSet.has(normalized);
    },
    reset(): void {
      lineFifo.length = 0;
      lineSet.clear();
    },
  };
}

/**
 * @description Filter a pane-diff chunk against the window: drop every line
 * whose normalized form was already relayed (substantial lines only — short
 * lines always pass). Returns `''` when nothing survives, so the caller can
 * skip the poll's emit entirely (no empty messages).
 *
 * Blank-line shaping mirrors `getNewPaneContent`'s pending-blank exactly: a
 * single blank that sat BETWEEN two surviving lines is preserved as a
 * paragraph separator; leading/trailing blanks and blanks adjacent to dropped
 * lines never leak out. An already-shaped chunk passes through an empty
 * window byte-identical — fresh output is never altered.
 */
export function getRelayDedupedChunk(relayWindow: RecentRelayWindow, chunkText: string): string {
  if (!chunkText) return '';

  const keptParts: string[] = [];
  let pendingBlank = false;

  for (const line of chunkText.split('\n')) {
    const normalized = normalizeForComparison(line);
    if (!normalized) {
      pendingBlank = true;
      continue;
    }

    if (relayWindow.checkHasLine(line)) {
      pendingBlank = false;
      continue;
    }

    if (pendingBlank && keptParts.length > 0) keptParts.push('');
    keptParts.push(line);
    pendingBlank = false;
  }

  return keptParts.join('\n').trim();
}
