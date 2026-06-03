/**
 * @description Split agent output into Telegram-sized chunks, keeping
 * ```` ``` ```` code fences valid across chunk boundaries.
 *
 * Pure + dependency-free so it stays unit-testable without booting Telegraf
 * (importing `bot.ts` constructs a `Telegraf` instance at module load, which
 * needs a real token). Both the durable-output and status paths in `bot.ts`
 * route through {@link splitMessage}.
 */

/** Telegram caps a message at 4096 chars; we leave headroom for markdown noise. */
export const MAX_MESSAGE_LEN = 4000;

/**
 * @description Re-balance ```` ``` ```` fences across chunk boundaries. A tool
 * diff / output (fenced by the Claude adapter) can exceed the chunk size; cut
 * mid-fence, the first chunk has an unclosed fence and the next an orphan
 * closer, so `renderAgentHtml` renders literal ```` ``` ```` instead of a
 * `<pre>`. Closing an open fence at the cut and reopening it at the start of
 * the next chunk keeps every chunk independently valid. No-op for text with
 * balanced (or no) fences. Counts only line-start fences (block fences).
 */
export function rebalanceFences(chunks: string[]): string[] {
  let carryOpen = false;
  return chunks.map(chunk => {
    let text = carryOpen ? '```\n' + chunk : chunk;
    const fenceCount = (text.match(/^\s*```/gm) ?? []).length;
    const endsOpen = fenceCount % 2 === 1;
    if (endsOpen) text = text + '\n```';
    carryOpen = endsOpen;
    return text;
  });
}

export function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    let cutAt = maxLen;
    const lastNewline = remaining.lastIndexOf('\n', maxLen);
    if (lastNewline > maxLen * 0.5) cutAt = lastNewline;
    parts.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^\n/, '');
  }
  return rebalanceFences(parts);
}
