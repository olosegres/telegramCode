import { normalizeForComparison } from './recentRelayWindow';

/**
 * @description Result of {@link getNewPaneContent}: the diffed NEW pane text
 * plus an OUT-OF-BAND signal that the chunk's first new line was preceded by a
 * paragraph break in the pane. The break is reported separately (not as a
 * leading blank in `text`) because every downstream `.trim()` would strip a
 * leading blank, and a fresh Telegram message must never start blank anyway —
 * so the JOIN layer reconstructs the separator from this flag instead.
 */
export interface NewPaneContent {
  /** The new pane lines, leading/trailing blanks trimmed (interior blanks kept). */
  text: string;
  /**
   * True IFF a blank line immediately preceded the chunk's first new line AND
   * there was content above that blank (so it is a real inter-paragraph break,
   * not pane-top padding). Consumed only at the append JOIN, never at a message
   * start. See {@link OutputEventMeta.startsNewParagraph}.
   */
  startsNewParagraph: boolean;
}

/**
 * @description Diff a freshly-captured pane against the last one and return
 * only the NEW lines, as a line-SET difference (positions ignored — Claude's
 * TUI redraws the whole pane every poll, so a positional diff would re-emit
 * everything that scrolled).
 *
 * Blank lines are NOT part of the matched set (they aren't unique), but a
 * single blank that sat BETWEEN two runs of new content is preserved as a
 * paragraph separator: the previous implementation `continue`d past every
 * empty line, so multi-paragraph answers arrived in Telegram with every
 * paragraph glued to the next (the `cleanOutput` C1 fix only kept blanks in
 * the FULL pane; this delta path still dropped them). An INTERIOR blank (within
 * this chunk) is kept inline in `text`; a LEADING blank (before the chunk's
 * first new line) is instead reported via `startsNewParagraph` so the separator
 * survives the pipeline's trims and is rebuilt only at the append join.
 *
 * Suppression is by SET membership, not multiset count (B10): a line that
 * appeared in `oldContent` at all is suppressed for EVERY occurrence in
 * `newContent`, not just the first `oldCount` of them. Why: typing a draft
 * that wraps to several rows grows Claude's input box; the viewport is fixed
 * height, so the transcript scrolls and tmux re-renders the lines straddling
 * the scrollback↔visible boundary twice in one capture. The old multiset diff
 * suppressed only as many copies as `oldContent` held, so the extra copy of an
 * already-sent answer line counted as new and was re-emitted (a chunk of the
 * previous answer reappeared before the next turn). Set membership errs toward
 * DROPPING such a re-render duplicate — the locked tradeoff, since a re-send is
 * the user-visible bug while a genuinely-new line that merely repeats an
 * earlier transcript line is a rare, low-cost loss. (Note: `lastContent`
 * advances to the full pane on every change in `pollOutput`, NOT only on emit,
 * so a suppressed line does NOT self-heal next poll — hence we suppress only
 * lines that were truly already present.)
 *
 * Exported + pure so the diff is unit-testable without booting tmux.
 */
export function getNewPaneContent(oldContent: string, newContent: string): NewPaneContent {
  if (!oldContent) return { text: newContent, startsNewParagraph: false };
  if (oldContent === newContent) return { text: '', startsNewParagraph: false };

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const oldLineSet = new Set<string>();
  for (const line of oldLines) {
    const normalized = normalizeForComparison(line);
    if (normalized) oldLineSet.add(normalized);
  }

  const newParts: string[] = [];
  let pendingBlank = false;
  // True once any content line (retained-old skipped OR new pushed) has been
  // seen, so a blank that precedes the chunk's FIRST emitted new line counts as
  // a real paragraph break only when there was content above it — pane-top
  // padding (no content above) must not produce a leading separator.
  let sawContent = false;
  let startsNewParagraph = false;

  for (const line of newLines) {
    const normalized = normalizeForComparison(line);
    if (!normalized) {
      pendingBlank = true;
      continue;
    }

    if (oldLineSet.has(normalized)) {
      pendingBlank = false;
      sawContent = true;
      continue;
    }

    if (newParts.length === 0) {
      // First emitted new line: the leading blank is dropped from `text` (a
      // fresh message must never start blank), but reported out-of-band so the
      // JOIN can rebuild the separator — only when there was content above it.
      if (pendingBlank && sawContent) startsNewParagraph = true;
    } else if (pendingBlank) {
      // Interior blank within this chunk — keep it inline as a separator.
      newParts.push('');
    }
    newParts.push(line);
    pendingBlank = false;
    sawContent = true;
  }

  return { text: newParts.join('\n').trim(), startsNewParagraph };
}
