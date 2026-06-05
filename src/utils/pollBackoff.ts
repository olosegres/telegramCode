/**
 * @description Base poll cadence: how fast the Claude pane is captured + parsed
 * while a session is actively streaming. Mirrors the historical fixed interval.
 */
export const basePollIntervalMs = 300;

/**
 * @description Ceiling the adaptive backoff may slow an idle pane down to. An
 * idle session capped here still re-checks the pane ~every 1.5s, so it wakes
 * promptly when the agent resumes on its own (background tool finishing, etc.).
 */
export const maxPollIntervalMs = 1500;

/**
 * @description How many consecutive unchanged polls must elapse before we start
 * backing off. Kept above the resume-seeding exit (~2 unchanged polls) so
 * seeding always runs at base cadence and is never slowed by the backoff.
 */
export const backoffAfterUnchangedPolls = 10;

interface PollBackoffInput {
  /** Whether the raw capture changed since the previous poll (S1 raw compare). */
  isChanged: boolean;
  /** Delay used for the poll that just ran. */
  currentDelayMs: number;
  /** Consecutive unchanged polls observed BEFORE this one. */
  unchangedStreak: number;
}

interface PollBackoffResult {
  /** Delay to arm the next poll timer with. */
  delayMs: number;
  /** Updated consecutive-unchanged-poll counter. */
  unchangedStreak: number;
}

/**
 * @description Decide the next Claude poll delay from the latest poll's outcome.
 *
 * WHY: a fixed 300ms cadence burns a full `tmux capture-pane` + `cleanOutput`
 * (~15 regex passes over up to ~600KB) per session even when the pane is idle,
 * starving the event loop when several sessions stream in parallel. An idle
 * pane carries no information, so we double the delay (capped) once it has been
 * unchanged for {@link backoffAfterUnchangedPolls} polls. Any change — or an
 * explicit write that snaps the cadence back — returns to base immediately, so
 * user-visible latency after a prompt is unaffected.
 */
export function getNextPollDelay(input: PollBackoffInput): PollBackoffResult {
  if (input.isChanged) {
    return { delayMs: basePollIntervalMs, unchangedStreak: 0 };
  }

  const unchangedStreak = input.unchangedStreak + 1;
  if (unchangedStreak < backoffAfterUnchangedPolls) {
    return { delayMs: basePollIntervalMs, unchangedStreak };
  }

  const delayMs = Math.min(input.currentDelayMs * 2, maxPollIntervalMs);
  return { delayMs, unchangedStreak };
}
