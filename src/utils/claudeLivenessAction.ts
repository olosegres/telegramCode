import { stripLeadingSpinnerGlyph } from './claudeScrapeShapes';
import { formatElapsed } from './subagentStatusRender';

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
 *
 * (S1/S2 — working-status un-freeze + pane-static idle removal, plan
 * `2026-06-29-claude-working-status-liveness-and-idle-removal.md`: this module
 * also owns {@link buildClaudeLivenessFrameText} — the frame text carries a live
 * elapsed `m:ss` so a glyph-only tick is no longer the ONLY change the dedup
 * strips — and {@link checkShouldForceIdleRemoval} — the 30s pane-static net.)
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
  /**
   * Idle-removal latch (S2): a previous tick force-removed the frame because
   * the scraped pane went static for ≥ the idle threshold, so the agent is
   * treated as idle until the next prompt re-arms activity. While latched the
   * loop must NEVER `create`/`tick` a fresh working frame (it would resurrect
   * the very status the 30s net just removed); a stray frame is cleaned up.
   * Cleared on a new prompt / the next fresh liveness arm.
   */
  isSuppressed: boolean;
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
  // Idle-removal latch (S2): the pane went static ≥ threshold this turn, so the
  // agent is treated as idle until the next prompt. Never create/tick a fresh
  // working frame while latched; clean up a stray one if it somehow exists.
  if (input.isSuppressed) return input.hasStatusFrame ? 'delete' : 'noop';
  return input.hasStatusFrame ? 'tick' : 'create';
}

/**
 * @description Whether the liveness loop may STOP after this tick. Kept separate
 * from the create/tick/delete action because the stop decision must ALSO weigh
 * the status COALESCER: `sendStatusFrame` stores `statusMessageId` only AFTER its
 * network await, so a frame create can still be in flight on a tick that reads
 * `hasStatusFrame === false`. Stopping then strands the just-sent frame with no
 * loop left to delete it on idle — an orphan that lingers until the next message
 * (live 2026-06-29: a hung "☁️ thinking …" whose final frame landed exactly as
 * the agent went idle, so the idle tick saw no frame, stopped, and the send then
 * resurrected one with nothing watching it).
 *
 * Stop ONLY when idle, no frame tracked, AND the coalescer is fully drained
 * (nothing in flight, queued, or deferred behind a 429 cooldown). While any of
 * those hold, keep ticking: the pending send lands, the next idle tick deletes
 * the frame, and the loop then stops cleanly.
 *
 * S2 busy-onset arming grace: when the loop is armed by a freshly-forwarded
 * prompt (not by a scrape emit), Claude has not flipped its footer busy signal
 * yet, so the first tick reads idle. Without the grace the loop would self-stop
 * immediately (idle, no frame, nothing pending) and never show a working frame
 * for a long quiet think. While `withinArmingGrace`, NEVER stop — keep ticking
 * until Claude goes busy (normal flow takes over) or the grace expires (then the
 * idle stop applies as usual).
 */
export function getClaudeLivenessShouldStop(input: {
  isBusy: boolean;
  hasStatusFrame: boolean;
  statusSendPending: boolean;
  withinArmingGrace: boolean;
}): boolean {
  if (input.withinArmingGrace) return false;
  return !input.isBusy && !input.hasStatusFrame && !input.statusSendPending;
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

/**
 * @description Decide whether the liveness loop should RE-RENDER+SEND the
 * working-status frame on this tick (S3 — cooldown-scaled throttle).
 *
 * Mirrors the relay output debounce ({@link ./outputFlushTiming.ts}): the 1s
 * idle-CHECK tick must not turn into a per-second `editMessageText`, so a `tick`
 * (frame already on screen) only re-sends after the throttle window. The window
 * is the LONGER of the base refresh floor and the live remaining 429 cooldown —
 * so while the chat is throttling, the status frame coalesces into one larger,
 * later edit instead of piling more requests onto the storm (the status frame was
 * ~half the 429-storm traffic, live 2026-06-29). A `create` (no frame yet) always
 * sends so the indicator appears immediately, regardless of cooldown.
 *
 * Pure so the cadence rule is unit-testable without the Telegraf/tmux stack.
 */
export function checkShouldSendLivenessFrame(input: {
  /** Is this a `create` (no frame on screen yet)? Then always send. */
  isCreate: boolean;
  /** Ms since the loop last sent the frame. */
  msSinceLastSent: number;
  /** Base refresh floor (`claudeWorkingStatusRefreshMs`). */
  refreshMs: number;
  /** Live remaining 429 cooldown for the chat, ms (0 when not limited). */
  remainingCooldownMs: number;
}): boolean {
  if (input.isCreate) return true;
  return input.msSinceLastSent >= Math.max(input.refreshMs, input.remainingCooldownMs);
}

/**
 * @description Build the Claude working-status frame text (S1 un-freeze).
 *
 * Root cause of the freeze: the loop rotated a leading spinner glyph each tick
 * to look alive, but `getStatusFlushAction` STRIPS that lead glyph before its
 * dedup compare — so when the scraped activity line had no ticking tail (a
 * generic tool / "working…" indicator), the only thing changing was the part
 * the dedup removed → every tick `skip`ped → the frame sat static for minutes,
 * indistinguishable from a hung agent.
 *
 * Fix: append a live elapsed `m:ss` tail (reusing the shared {@link formatElapsed}
 * the sub-agent status uses) anchored at `workingSince`. The elapsed advances
 * every second and is NOT stripped by `stripLeadingSpinnerGlyph`, so a re-render
 * a few seconds later differs after the glyph strip → the coalescer `send`s it →
 * the frame visibly ticks. Prefers the scraped activity word (e.g. "Clauding…",
 * lead glyph swapped for our rotating one) over `fallbackText` (a neutral
 * localized "working…"). `workingSince === null` ⇒ no tail (defensive; the loop
 * always sets it on a fresh turn).
 */
export function buildClaudeLivenessFrameText(input: {
  /** Rotating heartbeat glyph for this tick (from `CLAUDE_LIVENESS_GLYPHS`). */
  glyph: string;
  /** Latest scraped activity line, or null when none has been seen this turn. */
  activityText: string | null;
  /** Already-localized neutral fallback (i18n `agent.workingIndicator`). */
  fallbackText: string;
  /** Epoch ms the current busy turn started, or null when not tracking. */
  workingSince: number | null;
  /** Now, epoch ms — the elapsed base for `m:ss`. */
  nowMs: number;
}): string {
  const elapsedSuffix =
    input.workingSince === null ? '' : ` · ${formatElapsed(input.nowMs - input.workingSince)}`;
  const activity = input.activityText?.trim();
  if (activity) {
    // Swap the scrape's own leading spinner glyph for our rotating one so the
    // heartbeat shows while preserving the activity word + any scraped tail.
    return `${input.glyph} ${stripLeadingSpinnerGlyph(activity)}${elapsedSuffix}`;
  }
  return `${input.fallbackText}${elapsedSuffix}`;
}

/**
 * @description S2 hard anti-hang net: should the liveness loop FORCE-remove the
 * working-status frame because the scraped TUI pane has gone static for too long?
 *
 * The frame is normally removed on the busy→idle edge (`getClaudeLivenessAction`
 * `delete`), but that anchors on Claude's footer busy signal, which can wrongly
 * stay "busy" after a turn ends — leaving a working status hanging for minutes
 * (live 2026-06-29). A genuinely working agent keeps the pane changing every
 * second (animated spinner + the TUI's own elapsed timer), so a pane that has
 * NOT changed for `idlePaneThresholdMs` is idle regardless of the footer: remove
 * the frame and stop the loop. `null` age (no live session) never triggers it.
 */
export function checkShouldForceIdleRemoval(input: {
  msSincePaneChange: number | null;
  idlePaneThresholdMs: number;
}): boolean {
  if (input.msSincePaneChange === null) return false;
  return input.msSincePaneChange >= input.idlePaneThresholdMs;
}
