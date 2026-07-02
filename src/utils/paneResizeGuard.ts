/**
 * @description Pure decision logic for the Claude scrape pane-RESIZE guard.
 *
 * WHY it exists (live incident 2026-07-02, topic 39933): an interactive
 * `tmux attach` from a normal-width terminal resizes the tmux window to the
 * client's size (and back to the `-x/-y` default on detach). tmux re-wraps the
 * WHOLE scrollback at the new width, so every physical line becomes a
 * different string: the per-poll line-SET diff (`getNewPaneContent`) sees
 * ~everything as "new" (69k-char diffs), and the long-horizon relay window
 * can't match re-wrapped lines either — its 16-char minimum deliberately
 * exempts short lines, so clusters of short old lines (JSON fragments, code
 * snippets, list numbers) leaked into the topic as ragged messages on EVERY
 * width flap, and captures taken mid-repaint leaked broken ANSI prefixes as
 * status frames.
 *
 * The guard: the poll loop queries `#{pane_width}x#{pane_height}` AFTER each
 * capture (same-poll order matters — a resize landing between the two calls is
 * then detected on THIS poll, never after the giant diff already shipped). On
 * a size change it emits NOTHING and re-seeds the diff baseline from the fresh
 * capture, then stays in a short "settling" mode until a poll sees the capture
 * unchanged (the TUI's own SIGWINCH repaint may lag tmux's mechanical re-wrap
 * by a poll or two). {@link resizeSettleMaxPolls} caps the mode so a busy,
 * constantly-streaming pane can never be wedged into permanent silence —
 * same shape as the resume-seeding cap.
 *
 * Locked tradeoff (same direction as `getNewPaneContent` and
 * `recentRelayWindow`): err toward DROPPING output. Real output produced
 * during the few settling polls is swallowed with the repaint; a resize flood
 * is the user-visible bug, a ~1-2s hole in a streamed answer mid-resize is a
 * low-cost loss.
 */

/** Shape of a valid `display-message -p '#{pane_width}x#{pane_height}'` reply. */
const PANE_SIZE_RE = /^\d+x\d+$/;

/**
 * @description Hard cap on consecutive suppressed settling polls. The normal
 * exit is "same size and the capture stopped changing"; a pane that streams
 * real output non-stop never goes quiet, so without the cap a mid-turn resize
 * would suppress the rest of the answer. ~6 polls at base cadence ≈ 2s —
 * comfortably covers tmux's re-wrap + the TUI's SIGWINCH repaint.
 */
export const resizeSettleMaxPolls = 6;

/**
 * @description Parse the raw `display-message` reply into a canonical
 * `<width>x<height>` size string, or `null` when the query failed or returned
 * something unexpected (never guess a size from garbage).
 */
export function parsePaneSize(raw: string): string | null {
  const trimmed = raw.trim();
  return PANE_SIZE_RE.test(trimmed) ? trimmed : null;
}

export interface PaneResizeGuardInput {
  /** Last known pane size (`null` before the first successful query). */
  lastSize: string | null;
  /** This poll's parsed size (`null` = the query failed this poll). */
  currentSize: string | null;
  /** Whether the previous poll left the session in settling mode. */
  isSettling: boolean;
  /** Consecutive suppressed polls already spent settling. */
  settlePolls: number;
  /** Whether this poll's raw capture differs from the previous poll's. */
  isRawChanged: boolean;
}

export interface PaneResizeGuardDecision {
  /** `suppress` = emit nothing this poll and re-seed the diff baseline. */
  action: 'proceed' | 'suppress';
  nextIsSettling: boolean;
  nextSettlePolls: number;
}

const proceedDecision: PaneResizeGuardDecision = {
  action: 'proceed',
  nextIsSettling: false,
  nextSettlePolls: 0,
};

/**
 * @description Decide whether this poll's capture is (part of) a resize
 * repaint that must be swallowed. See the module JSDoc for the mechanism.
 */
export function getPaneResizeGuardDecision(input: PaneResizeGuardInput): PaneResizeGuardDecision {
  const { lastSize, currentSize, isSettling, settlePolls, isRawChanged } = input;

  const nextSettlePolls = settlePolls + 1;
  // The cap fires no matter which branch keeps the mode alive — a wedge-guard,
  // not part of the normal exit.
  const suppressDecision: PaneResizeGuardDecision =
    nextSettlePolls >= resizeSettleMaxPolls
      ? proceedDecision
      : { action: 'suppress', nextIsSettling: true, nextSettlePolls };

  if (currentSize === null) {
    // Size query failed — can't judge. Mid-settle the repaint may still be
    // running, so stay suppressed (bounded by the cap); otherwise never
    // suppress on missing data.
    return isSettling ? suppressDecision : proceedDecision;
  }

  // First successful read of this session — a baseline, never a resize.
  if (lastSize === null) return proceedDecision;

  if (currentSize !== lastSize) return suppressDecision;

  if (isSettling) {
    // Size is stable again but the pane may still be repainting the re-wrapped
    // scrollback — hold until a poll sees the capture unchanged.
    return isRawChanged ? suppressDecision : proceedDecision;
  }

  return proceedDecision;
}
