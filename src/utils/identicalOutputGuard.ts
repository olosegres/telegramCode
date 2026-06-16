/**
 * @description Per-thread defense-in-depth backstop against a runaway flood of
 * byte-identical PERMANENT output.
 *
 * WHY it exists (flood 2026-06-16): a Claude tmux-scrape topic emitted a
 * box-drawing table ~500 times, one byte-identical copy every ~12s for >2h.
 * The root cause was fixed at the table emit path (S1, `recentRelayWindow`'s
 * block-level dedup), but ANY emit path that re-sends the same large block —
 * present or future, either backend — should not be able to flood a topic.
 * This guard caps that regardless of which path produced the output: if a fresh
 * permanent output is byte-identical to one recently sent to the SAME thread, it
 * is suppressed.
 *
 * Deliberately NARROW to avoid false positives:
 *  - only LARGE blocks ({@link identicalOutputMinChars}) are guarded — short
 *    answers ("done", "yes", a one-line confirmation) legitimately repeat and
 *    always pass;
 *  - only within a short TIME window ({@link identicalOutputWindowMs}) and the
 *    last few outputs ({@link identicalOutputWindowSize}) — a deliberate
 *    re-print minutes apart is not a flood and passes;
 *  - it is the BACKSTOP, not the primary fix: byte-identical only, never a
 *    fuzzy match, so a genuinely-changed block (a cell flipped, a row added) is
 *    different text and always passes.
 *
 * The continuation / status / transient / question exclusions are the caller's
 * (`bot.ts` handleAgentOutput) — this guard only ever sees fresh permanent
 * output text + the current time. State is reset at the same per-thread
 * teardown points as the other relay state (session stop / closed / unbind).
 */

/** Last N permanent outputs per thread kept for the identical-repeat check. */
export const identicalOutputWindowSize = 5;

/** Only an identical output within this time window is treated as a flood. */
export const identicalOutputWindowMs = 60_000;

/**
 * Minimum candidate length (chars) to be guarded at all. Short answers repeat
 * legitimately far too often to ever suppress — only LARGE blocks (a re-printed
 * table, a re-rendered file dump) can flood meaningfully.
 */
export const identicalOutputMinChars = 200;

/** One recorded permanent output: its text + when it was sent. */
export interface RecentOutputRecord {
  text: string;
  sentAtMs: number;
}

/**
 * @description Pure decision: is `candidate` a byte-identical repeat of a recent
 * permanent output still inside the window? Short candidates (< {@link
 * identicalOutputMinChars}) always return false. Only records within {@link
 * identicalOutputWindowMs} of `nowMs` count — an older identical output has
 * already aged out and is not a flood.
 */
export function checkIsIdenticalOutputRepeat(
  candidate: string,
  recentOutputs: readonly RecentOutputRecord[],
  nowMs: number,
): boolean {
  if (candidate.length < identicalOutputMinChars) return false;
  for (const record of recentOutputs) {
    if (nowMs - record.sentAtMs > identicalOutputWindowMs) continue;
    if (record.text === candidate) return true;
  }
  return false;
}

/**
 * @description Append a permanent output to a thread's bounded recent-output
 * history (newest last), evicting the oldest beyond {@link
 * identicalOutputWindowSize}. Returns a NEW array (pure) so callers store the
 * result. Outputs below {@link identicalOutputMinChars} are not recorded — they
 * are never guarded, so they would only waste a slot.
 */
export function recordRecentOutput(
  recentOutputs: readonly RecentOutputRecord[],
  text: string,
  sentAtMs: number,
): RecentOutputRecord[] {
  if (text.length < identicalOutputMinChars) return [...recentOutputs];
  const next = [...recentOutputs, { text, sentAtMs }];
  if (next.length > identicalOutputWindowSize) next.splice(0, next.length - identicalOutputWindowSize);
  return next;
}

/**
 * @description Stateful per-thread wrapper around the two pure helpers above.
 * `bot.ts` keeps ONE instance for all threads; the per-thread history lives in
 * an internal Map keyed by the serialised thread key.
 */
export interface IdenticalOutputGuard {
  /**
   * Decide whether `text` (a fresh permanent output) is a byte-identical flood
   * repeat for `threadKey`. When it is NOT, the output is RECORDED (so the next
   * identical one is caught) and `false` is returned. When it IS a repeat,
   * nothing is recorded and `true` is returned — the caller suppresses the send.
   */
  checkAndRecord(threadKey: string, text: string, nowMs: number): boolean;
  /** Forget a thread's history (session stop / closed / unbind). */
  reset(threadKey: string): void;
}

/**
 * @description Create an empty identical-output guard. `nowMs` is supplied per
 * call (not read from `Date.now()` here) so tests can drive the time window
 * deterministically.
 */
export function createIdenticalOutputGuard(): IdenticalOutputGuard {
  const historyByThread = new Map<string, RecentOutputRecord[]>();

  return {
    checkAndRecord(threadKey: string, text: string, nowMs: number): boolean {
      const history = historyByThread.get(threadKey) ?? [];
      if (checkIsIdenticalOutputRepeat(text, history, nowMs)) return true;
      historyByThread.set(threadKey, recordRecentOutput(history, text, nowMs));
      return false;
    },
    reset(threadKey: string): void {
      historyByThread.delete(threadKey);
    },
  };
}
