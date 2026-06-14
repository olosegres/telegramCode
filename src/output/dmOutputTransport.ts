import type { OutputTransport, OutputEventMeta, ThreadKey } from '../types';
import { keyToString } from '../types';
import { nextDraftId } from '../utils/draftId';
import { appendPendingOutput } from '../utils/outputFlushPlan';
import {
  getDraftPaceAction,
  checkShouldStreamAsDraft,
  DRAFT_MIN_INTERVAL_MS,
  DRAFT_DEFAULT_BACKOFF_MS,
} from '../utils/draftPacer';
import {
  getDraftFeedAction,
  checkShouldFinalizeOnIdle,
  FINALIZE_IDLE_MS,
} from '../utils/draftFinalize';
import {
  checkIsApiError,
  getErrorCode,
  getErrorRetryAfterSeconds,
} from '../sendErrorClassifier';

/**
 * @description Per-thread live-draft stream state (DM mode only). See the file
 * header for the cursor model. Moved here verbatim from `bot.ts` when the
 * output-transport seam landed — the DM transport OWNS this state map.
 */
interface DraftStreamState {
  /** Current response's stable draft id. Reused for every update of it. */
  draftId: number;
  /** Full pre-render text of the in-flight response (drives the draft body). */
  accumulatedText: string;
  /** Last text actually drafted, or null (nothing sent yet this turn). */
  lastSentText: string | null;
  /** When the last draft actually went out, ms, or null. */
  lastSentAtMs: number | null;
  /** Draft-channel 429 cooldown end, ms (`0` = none). Separate from rateLimiter. */
  backoffUntilMs: number;
  /** Timer to flush a deferred draft update. `null` = none armed. */
  pacerTimer: NodeJS.Timeout | null;
  /**
   * Idle-finalize timer (DM streaming v2). Armed on every feed; when it fires
   * with no newer output the accumulated draft is FINALIZED into a permanent
   * message ({@link FINALIZE_IDLE_MS} after the last feed). `null` = none armed.
   */
  idleFinalizeTimer: NodeJS.Timeout | null;
  /** When the draft was last fed new output, ms, or null. Drives the idle boundary. */
  lastFedAtMs: number | null;
  /** Is a draft turn currently active (a response is streaming)? */
  active: boolean;
}

/** The structural subset of the bot's per-thread message state the draft manager touches. */
interface DraftMessageState {
  /** True when the next output should send a new message instead of editing. */
  needsNewMessage: boolean;
}

/**
 * @description Bot primitives the DM draft manager needs, injected as closures so
 * the transport never reaches into the bot's module state directly. `queueOutput`
 * + `sendAgentChunks` stay OWNED by `bot.ts` (shared with the group path / the
 * `isComplete` one-shot); the rest are the bot's send/render/state helpers and
 * the API-error classifiers.
 */
export interface DmOutputTransportDeps {
  queueOutput(
    key: ThreadKey,
    output: string,
    isContinuation: boolean,
    isFinal: boolean,
    isComplete: boolean,
  ): void;
  sendAgentChunks(key: ThreadKey, chunks: string[]): Promise<void>;
  getThreadMessageState(key: ThreadKey): DraftMessageState;
  /** Per-thread draft-streaming gate — OpenCode only; Claude DM streams the plain path. */
  checkSupportsDraft(key: ThreadKey): boolean;
  checkIsGeneral(key: ThreadKey): boolean;
  callSendMessageDraft(method: 'sendMessageDraft', payload: Record<string, unknown>): Promise<unknown>;
  splitMessage(text: string, max: number, measure: (text: string) => number): string[];
  renderAgentHtml(text: string): string;
  maxMessageLength: number;
}

/**
 * @description The DM live-draft output transport — the relocated draft-cursor
 * manager. In DM mode the LIVE phase of a streamed reply is shown as a native
 * Telegram draft (the "bot is typing this message" animation) and FINALIZED to a
 * permanent message at boundaries (idle / overflow / isFinal / new-response /
 * teardown). The draft channel runs OFF the message rate-limiter so a draft 429
 * can never delay a real send; every draft call is best-effort. Only OpenCode
 * threads stream via drafts ({@link DmOutputTransportDeps.checkSupportsDraft}
 * gate); Claude DM falls through to the plain `queueOutput` baseline.
 */
export function createDmOutputTransport(deps: DmOutputTransportDeps): OutputTransport {
  const draftStreams = new Map<string, DraftStreamState>();

  function getDraftStreamState(key: ThreadKey): DraftStreamState {
    const k = keyToString(key);
    let s = draftStreams.get(k);
    if (!s) {
      s = {
        draftId: 0,
        accumulatedText: '',
        lastSentText: null,
        lastSentAtMs: null,
        backoffUntilMs: 0,
        pacerTimer: null,
        idleFinalizeTimer: null,
        lastFedAtMs: null,
        active: false,
      };
      draftStreams.set(k, s);
    }
    return s;
  }

  /**
   * @description Render the FULL accumulated draft text to HTML. The draft is the
   * live "cursor" holding the entire current reply, so it renders the WHOLE
   * `accumulatedText` — never a tail window. The overflow boundary keeps
   * `accumulatedText` short enough that its render stays under the Telegram cap.
   */
  function renderDraftBody(accumulatedText: string): string {
    return deps.renderAgentHtml(accumulatedText);
  }

  /**
   * @description Rendered-HTML length of `text` — the measure the overflow
   * boundary compares against the cap. A body is sized by its RENDERED length
   * (HTML escaping + tags inflate the source), so the overflow decision must
   * measure the same way `renderDraftBody` / the persist splitter do.
   */
  function measureDraftRenderedLength(text: string): number {
    return deps.renderAgentHtml(text).length;
  }

  /** Clear both per-draft timers (pacer + idle-finalize) without touching state. */
  function clearDraftTimers(draft: DraftStreamState): void {
    if (draft.pacerTimer) {
      clearTimeout(draft.pacerTimer);
      draft.pacerTimer = null;
    }
    if (draft.idleFinalizeTimer) {
      clearTimeout(draft.idleFinalizeTimer);
      draft.idleFinalizeTimer = null;
    }
  }

  /**
   * @description Fire ONE draft update for the thread's current accumulated text,
   * reusing the turn's stable draft id. Best-effort: a 429 arms the draft-channel
   * backoff (read from `retry_after` when present, else {@link
   * DRAFT_DEFAULT_BACKOFF_MS}) and re-arms the pacer; any other failure is logged
   * and dropped. Never throws, never touches the message rate-limiter.
   */
  async function sendDraftNow(key: ThreadKey, draft: DraftStreamState): Promise<void> {
    const text = renderDraftBody(draft.accumulatedText);
    // The cursor invariant keeps `accumulatedText` under the cap; an over-cap
    // render is the TRANSIENT pre-spill state at an overflow feed (the overflow
    // boundary splits it into permanent messages on the same tick). Sending it
    // would only earn `MESSAGE_TOO_LONG`, so skip — the spill carries the content.
    if (text.length > deps.maxMessageLength) return;
    const payload: Record<string, unknown> = {
      chat_id: key.chatId,
      draft_id: draft.draftId,
      text,
      parse_mode: 'HTML',
    };
    // Mirror `buildSendExtra`'s General handling: omit `message_thread_id` for the
    // DM General thread (`DM_GENERAL_THREAD_ID = 0`).
    if (!deps.checkIsGeneral(key)) payload.message_thread_id = key.threadId;

    // Record what we are ABOUT to show + when, before the await, so a concurrent
    // feed paces against this attempt (and a failure below only adjusts backoff).
    draft.lastSentText = draft.accumulatedText;
    draft.lastSentAtMs = Date.now();
    try {
      await deps.callSendMessageDraft('sendMessageDraft', payload);
    } catch (e) {
      const code = checkIsApiError(e) ? getErrorCode(e) : undefined;
      if (code === 429) {
        const retryAfterSec = checkIsApiError(e) ? getErrorRetryAfterSeconds(e) : undefined;
        const backoffMs = retryAfterSec ? retryAfterSec * 1000 : DRAFT_DEFAULT_BACKOFF_MS;
        draft.backoffUntilMs = Date.now() + backoffMs;
        console.warn(`[draft] ${keyToString(key)} draft 429 — backing off ${backoffMs}ms`);
        armDraftPacerTimer(key, draft);
        return;
      }
      console.warn(
        `[draft] ${keyToString(key)} draft update failed (best-effort, ignored):`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  /**
   * @description Arm (replacing any existing) the draft pacer timer. It fires
   * after the soonest the pacer could next `send`: the later of the draft-channel
   * backoff remainder and the min-interval remainder since the last send, then
   * re-runs the pacer. The draft keepalive is gone (DM streaming v2): a draft is
   * either updated within the idle window or FINALIZED at the idle boundary, so it
   * never needs to survive the ~30s native ephemerality.
   */
  function armDraftPacerTimer(key: ThreadKey, draft: DraftStreamState): void {
    if (draft.pacerTimer) clearTimeout(draft.pacerTimer);
    const now = Date.now();
    const backoffRemainder = Math.max(0, draft.backoffUntilMs - now);
    const intervalRemainder =
      draft.lastSentAtMs === null
        ? 0
        : Math.max(0, draft.lastSentAtMs + DRAFT_MIN_INTERVAL_MS - now);
    // The pacer can only `send` once both the backoff and the interval clear.
    const delay = Math.max(backoffRemainder, intervalRemainder);
    draft.pacerTimer = setTimeout(() => {
      draft.pacerTimer = null;
      void runDraftPacer(key);
    }, Math.max(delay, 0));
    draft.pacerTimer.unref?.();
  }

  /**
   * @description Re-evaluate the pacer for the thread's current accumulated text
   * and act: `send` fires a draft now; `skip`/`defer` re-arm the timer. No-op once
   * the turn is inactive (a teardown / finalize cleared it).
   */
  async function runDraftPacer(key: ThreadKey): Promise<void> {
    const draft = draftStreams.get(keyToString(key));
    if (!draft || !draft.active) return;
    const now = Date.now();
    const action = getDraftPaceAction({
      nextText: draft.accumulatedText,
      lastSentText: draft.lastSentText,
      nowMs: now,
      lastSentAtMs: draft.lastSentAtMs,
      minIntervalMs: DRAFT_MIN_INTERVAL_MS,
      backoffUntilMs: draft.backoffUntilMs,
    });
    if (action === 'send') {
      await sendDraftNow(key, draft);
      return;
    }
    // `skip` / `defer` → re-arm for the remaining interval / backoff.
    armDraftPacerTimer(key, draft);
  }

  /**
   * @description Begin a fresh draft turn: allocate a new stable draft id (so this
   * response animates separately from the previous one), reset the accumulator and
   * pacing/idle state, and mark active. Called when a new response begins (a
   * non-continuation output, or a forced new-message break) — the previous turn,
   * if any, was finalized to a permanent message first.
   *
   * Opening the turn CONSUMES the `needsNewMessage` signal: the fresh draft IS the
   * new message, so subsequent continuation tails extend it instead of being
   * mis-read as another new response (in DM the draft path replaces the persist
   * path that used to clear this flag on send).
   */
  function startDraftTurn(key: ThreadKey): void {
    const draft = getDraftStreamState(key);
    clearDraftTimers(draft);
    draft.draftId = nextDraftId(draft.draftId);
    draft.accumulatedText = '';
    draft.lastSentText = null;
    draft.lastSentAtMs = null;
    draft.lastFedAtMs = null;
    draft.backoffUntilMs = 0;
    draft.active = true;
    deps.getThreadMessageState(key).needsNewMessage = false;
  }

  /**
   * @description Reset a draft turn to fully idle: clear timers + accumulator +
   * pacing state and mark inactive. The shared tail of `finalizeDraft` (after the
   * permanent message is sent) and of a defensive teardown.
   */
  function resetDraftState(draft: DraftStreamState): void {
    clearDraftTimers(draft);
    draft.active = false;
    draft.accumulatedText = '';
    draft.lastSentText = null;
    draft.lastSentAtMs = null;
    draft.lastFedAtMs = null;
    draft.backoffUntilMs = 0;
  }

  /**
   * @description Arm (replacing any existing) the idle-finalize timer. It fires
   * {@link FINALIZE_IDLE_MS} after this feed; if no newer output arrived in that
   * window the accumulated draft is FINALIZED into a permanent message (a pause is
   * a natural message boundary). Re-armed on every feed, so a steadily streaming
   * reply never trips it.
   */
  function armIdleFinalizeTimer(key: ThreadKey, draft: DraftStreamState): void {
    if (draft.idleFinalizeTimer) clearTimeout(draft.idleFinalizeTimer);
    draft.idleFinalizeTimer = setTimeout(() => {
      draft.idleFinalizeTimer = null;
      const live = draftStreams.get(keyToString(key));
      if (!live) return;
      if (!checkShouldFinalizeOnIdle(Date.now(), live.lastFedAtMs, live.active, FINALIZE_IDLE_MS)) {
        return;
      }
      void finalizeDraft(key);
    }, FINALIZE_IDLE_MS);
    draft.idleFinalizeTimer.unref?.();
  }

  /**
   * @description Append `output` to the live draft's accumulator (S5 concat rule —
   * mirroring what the eventual message holds), then pace the draft update and
   * (re)arm the idle-finalize timer. The boundary router (`feedDraft`) calls this
   * for the `append`/`overflow`-remainder/post-`finalizeThenStart` cases.
   */
  function appendToDraft(key: ThreadKey, output: string, isContinuation: boolean): void {
    const draft = getDraftStreamState(key);
    draft.accumulatedText = appendPendingOutput(
      draft.accumulatedText === '' ? null : draft.accumulatedText,
      output,
      isContinuation,
    );
    draft.lastFedAtMs = Date.now();
    void runDraftPacer(key);
    armIdleFinalizeTimer(key, draft);
  }

  /**
   * @description Finalize the active draft into a PERMANENT message and reset the
   * turn. The accumulated text is the live cursor's full body; by construction
   * (overflow boundary) it renders within one Telegram message, but the
   * render-aware splitter is reused defensively so an edge over the cap still
   * lands every chunk. After the message(s) are sent the draft state is fully
   * reset (inactive, empty, timers cleared) so the NEXT output opens a fresh
   * draft → a new message. Best-effort + idempotent: nothing accumulated, or no
   * draft at all, is a no-op.
   */
  async function finalizeDraft(key: ThreadKey): Promise<void> {
    const draft = draftStreams.get(keyToString(key));
    if (!draft) return;
    const text = draft.accumulatedText;
    // Reset BEFORE the await so a concurrent feed opens a clean fresh turn rather
    // than appending onto text we are about to ship as a permanent message.
    resetDraftState(draft);
    if (!text.trim()) return;
    await deps.sendAgentChunks(
      key,
      deps.splitMessage(text, deps.maxMessageLength, measureDraftRenderedLength),
    );
  }

  /**
   * @description Spill an over-cap draft: split the accumulated text, finalize the
   * leading chunk(s) as permanent message(s), and carry the LAST chunk (the
   * remainder still under the cap) into a fresh draft so the live cursor continues
   * below the finalized content. Called by `feedDraft` on the `overflow` boundary.
   */
  async function spillDraftOverflow(key: ThreadKey): Promise<void> {
    const draft = getDraftStreamState(key);
    const chunks = deps.splitMessage(
      draft.accumulatedText,
      deps.maxMessageLength,
      measureDraftRenderedLength,
    );
    // A single chunk means the render fit after all (e.g. an un-splittable token
    // the splitter emitted whole) — nothing to spill, just keep streaming it.
    if (chunks.length <= 1) {
      void runDraftPacer(key);
      armIdleFinalizeTimer(key, draft);
      return;
    }
    // Move the cursor to the remainder SYNCHRONOUSLY before shipping the leading
    // chunk(s): `leadingChunks` is captured in a local and a fresh draft holds only
    // the remainder, so a concurrently-dispatched continuation appends onto the
    // remainder draft (never onto text already being shipped). Without this, a feed
    // arriving during the send below would re-read the un-reset accumulator and
    // re-spill the same leading chunk (duplicate send) or be wiped (lost text).
    // Same invariant as feedDraft: no draft-state mutation AFTER the await.
    const leadingChunks = chunks.slice(0, -1);
    const remainder = chunks[chunks.length - 1];
    startDraftTurn(key);
    appendToDraft(key, remainder, /* isContinuation */ true);
    await deps.sendAgentChunks(key, leadingChunks);
  }

  /**
   * @description Feed the live draft with one `output` event and route it through
   * the boundary decision ({@link getDraftFeedAction}):
   *
   *  - `finalizeThenStart` — a new response began while a draft was active:
   *    finalize the previous draft to a permanent message, then open a fresh turn
   *    for this output;
   *  - `finalize` — the turn's last frame (`isFinal`): append, then finalize and do
   *    NOT reopen a draft;
   *  - `overflow` — appending makes the render cross the cap: append, then spill
   *    the full chunk(s) to permanent message(s) and continue in a new draft;
   *  - `append` — ordinary streaming tail: grow the draft, pace it, re-arm idle.
   *
   * Async because a boundary may send a permanent message; the caller calls it
   * fire-and-forget. Lazily opens a turn if none is active.
   */
  async function feedDraft(
    key: ThreadKey,
    output: string,
    isContinuation: boolean,
    isFinal: boolean,
  ): Promise<void> {
    const draft = getDraftStreamState(key);
    const needsNewMessage = deps.getThreadMessageState(key).needsNewMessage;
    // The text the draft WOULD hold after this output: for a continuation into a
    // live draft it extends the accumulator (so the overflow check measures the
    // real combined length); otherwise the new turn starts from just this output.
    const isAppendingContinuation = draft.active && isContinuation && !needsNewMessage;
    const prospective = isAppendingContinuation
      ? appendPendingOutput(draft.accumulatedText || null, output, true)
      : output;
    const action = getDraftFeedAction({
      isDraftActive: draft.active,
      isContinuation,
      needsNewMessage,
      isFinal,
      prospectiveRenderedLength: measureDraftRenderedLength(prospective),
      renderedCap: deps.maxMessageLength,
    });

    if (action === 'finalizeThenStart') {
      // SYNCHRONOUS reset→restart, no await between: finalizeDraft snapshots the old
      // text and resets state synchronously BEFORE its network send (which then ships
      // fire-and-forget, ordered by the per-thread send FIFO), so opening the new turn
      // immediately runs in one stack. A concurrently-dispatched output event therefore
      // cannot interleave at an await and be wiped by this startDraftTurn. Invariant for
      // this whole family of functions: no draft-state mutation AFTER an await.
      void finalizeDraft(key);
      startDraftTurn(key);
      appendToDraft(key, output, /* isContinuation */ false);
      return;
    }
    if (!draft.active) startDraftTurn(key);
    if (action === 'finalize') {
      appendToDraft(key, output, isContinuation);
      await finalizeDraft(key);
      return;
    }
    appendToDraft(key, output, isContinuation);
    if (action === 'overflow') await spillDraftOverflow(key);
  }

  /**
   * @description Route one DM `output` event to its message path:
   *  • streaming tail (not a one-shot, not a sub-agent) on a draft-capable
   *    adapter → the draft manager is the SOLE output→message path;
   *  • complete one-shot (`isComplete`) → finalize any live draft first (keeps
   *    order), then post it straight as a permanent message (no draft animation);
   *  • otherwise (e.g. Claude DM baseline) → the original `queueOutput` path.
   */
  function deliverOutput(key: ThreadKey, output: string, meta?: OutputEventMeta): void {
    const isContinuation = meta?.isContinuation === true;
    const isFinal = meta?.isFinal === true;
    const isComplete = meta?.isComplete === true;
    if (checkShouldStreamAsDraft(true, meta) && deps.checkSupportsDraft(key)) {
      void feedDraft(key, output, isContinuation, isFinal);
    } else if (isComplete) {
      void (async () => {
        await finalizeDraft(key);
        await deps.sendAgentChunks(
          key,
          deps.splitMessage(output, deps.maxMessageLength, measureDraftRenderedLength),
        );
      })();
    } else {
      deps.queueOutput(key, output, isContinuation, isFinal, isComplete);
    }
  }

  return {
    deliverOutput,
    finalizeInFlight: (key) => finalizeDraft(key),
    disposeThread(key) {
      // `finalizeInFlight` (the teardown convergence point) already finalized any
      // accumulated draft text (synchronously capturing it + clearing the timers);
      // drop the now-reset map entry so it doesn't leak across a rebind.
      draftStreams.delete(keyToString(key));
    },
  };
}
