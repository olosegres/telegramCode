/**
 * @description Pure planning logic for flushing agent `output` to Telegram —
 * extracted from `bot.ts` so the streaming-append decision is unit-testable
 * without booting Telegraf.
 *
 * Live repro 2026-06-05 (topic "overview app 1"): OpenCode emits a long reply
 * as incremental tails, and the bot edited the SAME message with only the
 * newest batch each flush — every edit replaced everything before it, so the
 * user could read only the last tail. The fix: a continuation tail is
 * appended to the text already rendered into the last message and the FULL
 * combined text is re-rendered (also re-pairing markdown tokens that straddle
 * two flushes), spilling into new messages when it outgrows the Telegram cap.
 */

import { splitMessage } from '../messageSplit';

export interface OutputFlushInput {
  /** The batch of output text to flush (already debounce-coalesced). */
  output: string;
  /** True when `output` continues the text already sent to `lastMessageId`. */
  isContinuation: boolean;
  /** Thread flag: next output must start a new message (user prompt, etc.). */
  needsNewMessage: boolean;
  /** Id of the last agent message in the thread, if editable. */
  lastMessageId: number | null;
  /** Source (pre-render) text currently shown in `lastMessageId`. */
  lastMessageText: string | null;
}

export interface OutputFlushPlan {
  /** Telegram-sized chunks covering the full (possibly combined) text. */
  chunks: string[];
  /**
   * True → `chunks[0]` re-edits `lastMessageId` in place (append semantics);
   * remaining chunks send as new messages. False → every chunk sends new.
   */
  shouldEditFirstChunk: boolean;
}

/**
 * @description Decide how a flush lands in Telegram. Append-edit is possible
 * only when the batch is a continuation AND the last message is still
 * editable (id + source text known, no forced break since).
 */
export function getOutputFlushPlan(input: OutputFlushInput): OutputFlushPlan {
  const canAppend =
    input.isContinuation &&
    !input.needsNewMessage &&
    input.lastMessageId !== null &&
    input.lastMessageText !== null;
  if (!canAppend) {
    return { chunks: splitMessage(input.output), shouldEditFirstChunk: false };
  }
  return {
    chunks: splitMessage(input.lastMessageText + input.output),
    shouldEditFirstChunk: true,
  };
}

/**
 * @description Coalesce a new output batch into the pending (not yet flushed)
 * buffer. Continuation tails concatenate as-is — they may be cut mid-word, a
 * `\n` would split the word across lines; standalone outputs join with `\n`
 * as distinct logical messages.
 */
export function appendPendingOutput(
  pending: string | null,
  output: string,
  isContinuation: boolean,
): string {
  if (!pending) return output;
  return isContinuation ? pending + output : `${pending}\n${output}`;
}
