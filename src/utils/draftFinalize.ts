/**
 * @description Pure boundary/finalize decision for the DM-mode draft "cursor"
 * (DM streaming v2). The bot keeps ONE accumulating draft holding the full
 * current reply text and FINALIZES it into a permanent `sendMessage` on a
 * boundary; after a finalize the next output starts a fresh draft → a new
 * message.
 *
 * This module decides WHICH boundary (if any) a given feed / idle tick hits; the
 * `bot.ts` draft manager owns the real timers and the Telegram IO (rendering,
 * `splitMessage`, `sendMessageDraft`, `replyToThread`). Keeping the decision
 * pure lets a timeline test with an injectable clock prove the gates fire
 * (mirrors `draftPacer.test.ts`).
 *
 * The boundaries (locked in the plan):
 *  - new-response — a non-continuation output (or a forced new-message break)
 *    arriving while a draft is already active: finalize the previous draft, then
 *    start a fresh one for this output;
 *  - overflow — the prospective accumulated text would render past the Telegram
 *    cap: finalize the full chunk(s) and continue the remainder in a new draft;
 *  - isFinal — the turn's last frame: finalize and do not reopen a draft;
 *  - idle — no new output for {@link FINALIZE_IDLE_MS}: finalize the snapshot;
 *  - append — none of the above: just grow the draft and pace it.
 */

/**
 * Idle window after the last draft feed with no new output before the draft is
 * FINALIZED into a permanent message (a pause is a natural message boundary —
 * like sending what you've typed, then continuing in a new bubble). Repurposes
 * the value the removed `OUTPUT_DEBOUNCE_MS_DM` held; it is NOT a send-throttle.
 */
export const FINALIZE_IDLE_MS = 4000;

/**
 * @name DraftFeedAction
 * @description What the draft manager should do with an incoming `output` feed.
 *
 * - `finalizeThenStart` — a new response began while a draft was active: finalize
 *   the active draft to a permanent message FIRST, then open a fresh draft and
 *   append this output.
 * - `finalize` — the turn ended (`isFinal`): finalize the active draft (with this
 *   output appended) and do NOT reopen a draft.
 * - `overflow` — appending this output makes the draft render past the cap:
 *   finalize the full chunk(s) as permanent message(s) and carry the remainder
 *   into a new draft.
 * - `append` — ordinary streaming tail: grow the draft and pace the update.
 */
export type DraftFeedAction = 'finalizeThenStart' | 'finalize' | 'overflow' | 'append';

export interface DraftFeedInput {
  /** Is a draft turn currently active (a response is mid-stream)? */
  isDraftActive: boolean;
  /** Does this output continue the in-flight response (vs a standalone one)? */
  isContinuation: boolean;
  /** Thread flag: the next output must start a new message (user prompt, etc.). */
  needsNewMessage: boolean;
  /** Is this the turn's last frame (`OutputEventMeta.isFinal`)? */
  isFinal: boolean;
  /**
   * Rendered length of the PROSPECTIVE accumulated text once this output is
   * appended to the active draft (the bot measures it the same way it renders
   * the draft body). Compared against {@link DraftFeedInput.renderedCap}.
   */
  prospectiveRenderedLength: number;
  /** The rendered-length cap a single draft/message must fit under. */
  renderedCap: number;
}

/**
 * @description Decide what the draft manager does with an incoming feed.
 *
 * Order matters and is load-bearing:
 *  1. new-response (active draft + a non-continuation / forced break) →
 *     `finalizeThenStart`: the previous reply is complete, snapshot it before the
 *     new one overwrites the cursor. Checked before overflow because the
 *     prospective length is computed against the OLD accumulator and would be
 *     meaningless across a response boundary.
 *  2. isFinal → `finalize`: end the turn; no new draft.
 *  3. overflow (prospective render > cap) → `overflow`: spill into permanent
 *     message(s) + a fresh draft for the remainder.
 *  4. otherwise → `append`.
 */
export function getDraftFeedAction(input: DraftFeedInput): DraftFeedAction {
  const isStartOfResponse = !input.isContinuation || input.needsNewMessage;
  if (input.isDraftActive && isStartOfResponse) return 'finalizeThenStart';
  if (input.isFinal) return 'finalize';
  if (input.prospectiveRenderedLength > input.renderedCap) return 'overflow';
  return 'append';
}

/**
 * @description Should the idle timer finalize the draft now? True once a draft
 * is active and at least {@link FINALIZE_IDLE_MS} has elapsed since the last
 * feed with no newer output. Never true when nothing has been fed yet
 * (`lastFedAtMs === null`) or the draft is inactive — there is nothing to
 * finalize.
 */
export function checkShouldFinalizeOnIdle(
  nowMs: number,
  lastFedAtMs: number | null,
  isDraftActive: boolean,
  idleMs: number,
): boolean {
  if (!isDraftActive) return false;
  if (lastFedAtMs === null) return false;
  return nowMs - lastFedAtMs >= idleMs;
}
