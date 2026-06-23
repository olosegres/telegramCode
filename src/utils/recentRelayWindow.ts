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

import { DIFF_GUTTER_CHANGE_RE } from './claudeScrapeShapes';

/**
 * @description Minimum NORMALIZED line length for the window to record or
 * suppress a line. Shorter lines repeat legitimately too often (confirmations,
 * bullets, numbers) to ever be treated as re-render duplicates.
 */
export const relayDedupMinLineLength = 16;

/**
 * @description True for a numbered file-DIFF CHANGE gutter line (`40 +`,
 * `51 +  …`, `42 +-`). Reuses the SINGLE shape definition
 * {@link DIFF_GUTTER_CHANGE_RE} (`claudeScrapeShapes` is a no-import leaf module,
 * so there is no cycle). A `+`-led gutter shape is structurally NEVER legitimate
 * repeated PROSE (`done`, `yes`) — nor `-`-led prose (`404 - Not Found`), which
 * the `+`-only anchor excludes — so the window records/suppresses it EVEN BELOW
 * {@link relayDedupMinLineLength} (S2): a bare `40 +` re-appearing on a scrollback
 * re-render must be dropped, while a real short confirmation still passes.
 *
 * IMPORTANT: callers pass the NORMALIZED key ({@link normalizeForRelayDedup}),
 * not the raw line — the window's record + lookup MUST decide gutter-ness in the
 * SAME domain they store/compare in, or a glyph-led re-render (`⏺ 40 +`) would
 * record under one verdict and look up under another (the module's "one
 * normalization domain" contract).
 */
export function checkIsDiffGutterLine(normalizedLine: string): boolean {
  return DIFF_GUTTER_CHANGE_RE.test(normalizedLine);
}

/**
 * @description Window capacity in lines. Sized to cover the incident-scale
 * re-render (a ~1400-line stale diff) with headroom, while keeping the memory
 * bound trivial and letting truly old content evict.
 */
export const relayWindowMaxLines = 1500;

/**
 * @description Capacity of the block-signature FIFO behind
 * {@link RecentRelayWindow.checkBlockAlreadyRelayed}. A block is one emitted
 * chunk (a table, a prose paragraph) recorded as a SINGLE joined signature, so
 * far fewer entries than the per-line window need bounding. Sized to remember a
 * good run of recent emitted blocks (covers a looped table re-printed many times
 * within a turn) while keeping the memory bound trivial.
 */
export const relayBlockSignatureMax = 200;

/**
 * @description Normalise a pane line for line-identity comparison: trim, drop
 * a leading status/tool glyph so a tool header matches regardless of which
 * `●/⏺/○/⏳/✓` state it was last rendered in (`⏺` U+23FA is the real
 * assistant-output bullet in Claude v2.1.177).
 *
 * Single source of truth for BOTH dedup layers — the per-poll set diff
 * (`getNewPaneContent`) and this relay window — which MUST share one
 * normalization domain: the window stores the same normalized forms the pane
 * diff compares, otherwise a redraw would slip past one layer or the other.
 */
export function normalizeForComparison(line: string): string {
  return line.trim().replace(/^[●○⏺⏳✓]\s*/, '');
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
 * @description Build a single normalized signature for a WHOLE block (a table,
 * a paragraph) so a fully-duplicate block can be recognised even when its
 * individual lines are too short to clear the per-line {@link
 * relayDedupMinLineLength} gate — table border rows (`├──┤`) and tiny cells
 * (`│ ✅ │`) are exactly that case. Drops blank lines, normalizes each surviving
 * line in the SAME coarse domain {@link normalizeForRelayDedup} uses, and joins
 * with `\n`. Returns `''` for a block with no substantial content (so a
 * whitespace-only block is never treated as a relayed block).
 */
export function buildRelayBlockSignature(blockText: string): string {
  const normalizedLines = blockText
    .split('\n')
    .map(normalizeForRelayDedup)
    .filter(line => line.length > 0);
  return normalizedLines.join('\n');
}

/**
 * @description Bounded FIFO of normalized, already-relayed pane lines.
 * Created per Claude session; see {@link createRecentRelayWindow}.
 */
export interface RecentRelayWindow {
  /**
   * Store the chunk's substantial lines (normalized) AND the chunk's joined
   * block signature ({@link buildRelayBlockSignature}). Call ONLY after the
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
  /**
   * True when the WHOLE block (its joined {@link buildRelayBlockSignature})
   * was already relayed — the table-flood guard. Recognises a fully-duplicate
   * block even when every line is too short for the per-line gate. An
   * empty-signature block (whitespace only) always returns false.
   */
  checkBlockAlreadyRelayed(blockText: string): boolean;
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
  /** Insertion-ordered joined block signatures — defines block eviction order. */
  const blockSignatureFifo: string[] = [];
  /** Same signatures as `blockSignatureFifo`, for O(1) membership checks. */
  const blockSignatureSet = new Set<string>();

  return {
    record(chunkText: string): void {
      for (const line of chunkText.split('\n')) {
        const normalized = normalizeForRelayDedup(line);
        // S2: a diff-gutter CHANGE line (`40 +`) is recorded even when short —
        // it is never legitimate repeated prose, so suppressing its re-render is
        // safe below the length gate. Decide gutter-ness on the NORMALIZED key
        // (same domain it is stored under — see {@link checkIsDiffGutterLine}).
        if (normalized.length < relayDedupMinLineLength && !checkIsDiffGutterLine(normalized)) continue;
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

      // Also record the chunk's whole-block signature so a fully-duplicate
      // block (a re-printed table whose individual lines are too short for the
      // per-line gate) is recognised by `checkBlockAlreadyRelayed`.
      const blockSignature = buildRelayBlockSignature(chunkText);
      if (blockSignature && !blockSignatureSet.has(blockSignature)) {
        blockSignatureFifo.push(blockSignature);
        blockSignatureSet.add(blockSignature);
        if (blockSignatureFifo.length > relayBlockSignatureMax) {
          const evictedSignature = blockSignatureFifo.shift();
          if (evictedSignature !== undefined) blockSignatureSet.delete(evictedSignature);
        }
      }
    },
    checkHasLine(line: string): boolean {
      const normalized = normalizeForRelayDedup(line);
      // S2: a short diff-gutter CHANGE line is still suppressible (it was
      // recorded short too); other short lines always pass (never suppressed).
      // Decide gutter-ness on the NORMALIZED key (same domain as record()).
      if (normalized.length < relayDedupMinLineLength && !checkIsDiffGutterLine(normalized)) return false;
      return lineSet.has(normalized);
    },
    checkBlockAlreadyRelayed(blockText: string): boolean {
      const blockSignature = buildRelayBlockSignature(blockText);
      if (!blockSignature) return false;
      return blockSignatureSet.has(blockSignature);
    },
    reset(): void {
      lineFifo.length = 0;
      lineSet.clear();
      blockSignatureFifo.length = 0;
      blockSignatureSet.clear();
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
