/**
 * @description Pure backlog-glue for the per-topic send queue (S2b).
 *
 * When a topic BACKS UP — the global 1/2s send pacer (S1) leaves ≥3 messages
 * waiting to send for one topic — a per-2s trickle reads badly. This collapses
 * that backlog into ONE message (frames joined by a blank line, `\n\n`) so the
 * burst drains in a single send. 1–2 pending frames stay separate (snappy).
 *
 * The join+threshold is a pure, Telegraf-free helper (mirrors
 * `utils/outputFlushPlan.ts` / `utils/groupFinalizePlan.ts`): input = ordered
 * pending frames, output = the fewest messages that fit, each ≤ the cap, frames
 * joined by `\n\n`. Per-topic only — cross-topic messages carry distinct
 * `message_thread_id`s and can never merge, so "in one chat" ⇒ "in one topic's
 * queue".
 *
 * Splitting reuses {@link splitMessage}: it already emits the fewest chunks that
 * fit, preferring newline boundaries (so a glued block breaks on the `\n\n`
 * frame boundaries, never mid-line) and honouring the rendered-length cap when a
 * measure is supplied.
 */

import { splitMessage, MAX_MESSAGE_LEN } from '../messageSplit';

/**
 * @description Glue threshold: a topic's pending-send backlog collapses only at
 * this many frames or more. Below it, frames stay separate for snappiness.
 */
export const backlogGlueThreshold = 3;

/** Blank-line separator between glued frames. */
const frameSeparator = '\n\n';

/**
 * @description Collapse a topic's ordered pending frames into the fewest
 * `\n\n`-joined messages when the backlog is ≥ {@link backlogGlueThreshold};
 * otherwise return the frames unchanged (1–2 stay separate).
 *
 * @param frames Ordered pending frames (each already a would-be single message).
 * @param maxLen Per-message source-length cap (default {@link MAX_MESSAGE_LEN}).
 * @param measureRendered Optional rendered-length measure; when supplied the
 *   split also keeps each message's RENDERED length within Telegram's cap (same
 *   contract as {@link splitMessage}). Omit for plain source-length splitting.
 */
export function glueBacklogFrames(
  frames: string[],
  maxLen: number = MAX_MESSAGE_LEN,
  measureRendered?: (chunk: string) => number,
): string[] {
  if (frames.length < backlogGlueThreshold) return frames;
  return splitMessage(frames.join(frameSeparator), maxLen, measureRendered);
}
