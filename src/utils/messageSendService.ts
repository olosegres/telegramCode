import { splitMessage } from '../messageSplit';

/**
 * @description Deliver a batch of DISCRETE messages into a topic. Unlike the
 * normal agent-output path (which coalesces / glues a burst into the fewest
 * messages), this sends each input string as its OWN Telegram message — the
 * primitive behind the `send_messages_to_user` MCP tool, used when an agent
 * wants several separate messages (e.g. a per-item news digest: one message per
 * headline). A single input string that renders past Telegram's cap is split
 * defensively, but two distinct inputs are NEVER merged.
 *
 * Kept dependency-free of `bot.ts` (which builds a Telegraf instance at module
 * load): the caller injects the target resolver + the per-chunk sender, so this
 * service composes with the same paced send path the rest of the bot uses and
 * stays unit-testable in isolation (mirrors `createSendFilesToThread`).
 */

export type SendMessagesToThreadResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

export type SendMessagesToThread = (
  threadKey: string,
  args: SendMessagesToThreadOptions,
) => Promise<SendMessagesToThreadResult>;

export interface SendMessagesToThreadOptions {
  /** The messages to deliver, in order; each becomes its own Telegram message. */
  messages: string[];
  /** Optional cancellation — checked between messages (best-effort, coarse). */
  signal?: AbortSignal;
}

/**
 * Upper bound on how many discrete messages one call may deliver. A per-item
 * news digest is ~30–40 messages; 50 leaves headroom while bounding a runaway
 * call (each message is separately rate-paced, so a large batch also floods the
 * topic with notifications).
 */
export const maxDiscreteMessages = 50;

export interface SendMessagesToThreadDeps<TTarget> {
  /** Map the scope-resolved thread key string to the concrete send target. */
  resolveTarget(threadKey: string): { ok: true; target: TTarget } | { ok: false; error: string };
  /**
   * Send ONE already-split chunk as its own permanent message; resolves `true`
   * when it landed. The caller wires this to the bot's paced HTML-with-plain
   * -fallback send so ordering / rate-limiting / `/clear` tracking are reused.
   */
  sendChunk(target: TTarget, chunk: string, signal?: AbortSignal): Promise<boolean>;
  /** Max SOURCE length per message handed to {@link splitMessage} (defensive split). */
  maxMessageLength: number;
  /** Rendered-length measure so an over-cap RENDERED message is split like normal output. */
  measureRendered(chunk: string): number;
}

/**
 * @description Build the discrete-message sender. Each input string is split
 * (defensively) into Telegram-sized chunks and every chunk is sent as its own
 * message, preserving order; a blank input (empty after trim) is skipped so a
 * stray separator never posts an empty bubble. Cancellation is checked between
 * inputs (coarse — a chunk already dispatched to the pacer still lands).
 *
 * Failure is NOT swallowed: if every send failed (Telegram rejected them all)
 * the result is an ERROR, so the agent knows nothing reached the topic instead
 * of reading a false "Delivered 0" success; a partial failure stays `ok` but
 * says how many of the attempted messages actually landed.
 */
export function createSendMessagesToThread<TTarget>(
  deps: SendMessagesToThreadDeps<TTarget>,
): SendMessagesToThread {
  return async (threadKey, { messages, signal }) => {
    const resolved = deps.resolveTarget(threadKey);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { target } = resolved;

    let attempted = 0;
    let landed = 0;
    for (const message of messages) {
      if (signal?.aborted) {
        return { ok: false, error: `cancelled after delivering ${landed} message(s)` };
      }
      if (message.trim().length === 0) continue;
      const chunks = splitMessage(message, deps.maxMessageLength, deps.measureRendered);
      for (const chunk of chunks) {
        attempted += 1;
        if (await deps.sendChunk(target, chunk, signal)) landed += 1;
      }
    }

    if (attempted > 0 && landed === 0) {
      return { ok: false, error: 'Failed to deliver any message to the topic (Telegram rejected the sends).' };
    }
    const summary =
      landed === attempted
        ? `Delivered ${landed} message${landed === 1 ? '' : 's'} to the topic.`
        : `Delivered ${landed} of ${attempted} messages to the topic (${attempted - landed} failed to send).`;
    return { ok: true, summary };
  };
}
