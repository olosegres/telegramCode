/**
 * @description Pure decision for the Claude per-thread liveness loop: given the
 * session's current busy state, whether a rolling status frame is on screen,
 * whether real output is actively streaming, and whether this tick crossed a
 * busy→idle edge, decide what the loop should do with the status frame.
 *
 * Why a separate machine (not folded into the status coalescer): the live bug
 * (#11) is that a busy Claude session can show NOTHING in Telegram — the frame
 * is emitted only opportunistically when a spinner line happens to be scraped,
 * and `handleAgentOutput` DELETES it on every real output chunk. So while the
 * agent keeps working after some output (or thinks quietly during the poll
 * backoff) the topic looks idle/hung. The fix drives the frame off the cheap,
 * reliable `checkIsBusy` footer signal instead of the scrape, and this pure
 * function is the single owner of the create/tick/delete decision so the loop
 * and `handleAgentOutput` can't thrash (delete→instant-recreate flicker / a
 * 429 storm of editMessageText).
 *
 * Extracted from `bot.ts` so the rule is unit-testable without the
 * Telegraf / tmux machinery (same pattern as `statusFlushDecision.ts`).
 *
 * @name ClaudeLivenessAction
 * @description
 * - `create` — busy, no frame on screen, output not streaming: send a fresh
 *   activity frame to the bottom of the topic (THE bug — recreate after an
 *   output chunk deleted it while work continues).
 * - `tick`   — busy, frame already present, output not streaming: re-edit it
 *   so it reads as alive during a quiet thinking stretch / poll backoff.
 * - `delete` — the session went idle (busy→idle edge or simply not busy) and a
 *   frame is still on screen: remove it (idle-only removal).
 * - `noop`   — nothing to do: output is actively streaming (let it own the
 *   message — don't fight it), or the session is idle with no frame.
 */
export type ClaudeLivenessAction = 'create' | 'tick' | 'delete' | 'noop';

export interface ClaudeLivenessActionInput {
  /** Is the Claude session mid-turn right now (`adapter.checkIsBusy`)? */
  isBusy: boolean;
  /** Is a rolling status frame currently on screen for this thread? */
  hasStatusFrame: boolean;
  /** Is real agent output actively streaming (queued / debouncing / sending)? */
  isOutputStreaming: boolean;
  /**
   * Did this tick observe a busy→idle edge? Folds into the same removal as
   * `!isBusy`; kept explicit so a caller that tracks the edge (and tests) can
   * assert the transition removes the frame even if a later poll flips busy
   * back on.
   */
  idleTransition: boolean;
}

/**
 * @description Decide what the Claude liveness loop should do this tick.
 *
 * Priority order matters:
 *  1. Streaming output wins — never edit/delete the frame while output owns the
 *     message (anti-thrash with `handleAgentOutput`'s delete-on-output).
 *  2. Idle (edge or steady) with a frame still up → `delete` (idle-only removal;
 *     a false-idle would reintroduce the gap, a false-busy a stuck spinner, so
 *     the caller anchors `isBusy` to the footer signal that drops on idle).
 *  3. Busy without a frame → `create` (the bug).
 *  4. Busy with a frame → `tick` (keep it visibly alive).
 *  5. Otherwise (idle, no frame) → `noop`.
 */
export function getClaudeLivenessAction(input: ClaudeLivenessActionInput): ClaudeLivenessAction {
  if (input.isOutputStreaming) return 'noop';
  if (!input.isBusy || input.idleTransition) {
    return input.hasStatusFrame ? 'delete' : 'noop';
  }
  return input.hasStatusFrame ? 'tick' : 'create';
}

/**
 * @description Resolve what `sendStatusFrame` must do with a status message it
 * just CREATED (a brand-new Telegram message id, from the no-existing-frame
 * branch), once the create's `await` resolves.
 *
 * The bug this guards (#11 follow-up — orphaned/duplicate spinner frames): the
 * status-frame lifecycle mutates `statusMessageId` across `await` boundaries
 * from THREE concurrent paths — the liveness tick (`create`/`tick`), the scraped
 * status coalescer, and `handleAgentOutput`'s delete-on-output. `sendStatusFrame`
 * reads `statusMessageId` at entry but only writes the new id back AFTER its
 * network `await`. If a `deleteStatusMessage` runs during that window it sees a
 * still-`null` id (or a stale one), deletes nothing of the in-flight message, and
 * the create then resurrects `statusMessageId` pointing at a message nothing will
 * ever remove → an orphan left on screen after idle, and a second `create` (the
 * next glyph tick) spawning a SEPARATE message instead of editing the one frame.
 *
 * Fix: a monotonic per-thread `generation`, bumped on every `deleteStatusMessage`.
 * `sendStatusFrame` captures the generation before creating, and feeds it here
 * with the generation observed after the `await`:
 *  - unchanged  → `store`   : safe to record the new id as the single tracked frame.
 *  - changed    → `discard` : a delete (idle / output-supersede) landed mid-create;
 *                 the new message is already orphaned — delete it, DON'T store its id.
 *
 * Pure + tiny so the invariant ("delete during an in-flight create wins, no
 * orphan, single tracked id") is unit-testable without the Telegraf/tmux stack.
 */
export type StatusFrameStoreDecision = 'store' | 'discard';

export function getStatusFrameStoreDecision(
  generationAtCreateStart: number,
  generationNow: number,
): StatusFrameStoreDecision {
  return generationAtCreateStart === generationNow ? 'store' : 'discard';
}
