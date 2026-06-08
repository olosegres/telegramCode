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

/** Telegram's hard per-message limit. A rendered chunk that crosses this is
 *  rejected with a 400 "message is too long". */
export const TELEGRAM_HARD_LIMIT = 4096;

/**
 * Margin reserved below {@link TELEGRAM_HARD_LIMIT} when splitting by rendered
 * length. The render-aware check runs on a candidate chunk BEFORE
 * {@link rebalanceFences}, which can still GROW the rendered output: closing an
 * open fence at the cut and reopening one at the next chunk's start wraps bare
 * text into an extra `<pre><code>…</code></pre>`. That wrapper adds
 * `<pre><code>` (11) + `</code></pre>` (13) = 24 rendered chars; we round up to
 * leave slack so a post-rebalance chunk can never cross the hard limit.
 */
export const RENDERED_REBALANCE_MARGIN = 32;

/** Effective rendered cap a candidate chunk must fit under so it still fits the
 *  hard limit after {@link rebalanceFences} may add fence wrappers. */
export const RENDERED_CHUNK_CAP = TELEGRAM_HARD_LIMIT - RENDERED_REBALANCE_MARGIN;

/**
 * Smallest source slice the render-aware back-off may shrink a chunk to. Guards
 * against an infinite loop / empty chunk when a single un-splittable token
 * renders huge (e.g. one very long word full of escapable `< & >`): once the
 * candidate is this short we stop backing off and emit it even if it still
 * measures over the cap, so the split always makes forward progress.
 */
export const MIN_RENDER_AWARE_CHUNK_LEN = 1;

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

/**
 * @description Split agent text into Telegram-sized chunks.
 *
 * Without `measureRendered` the cut is purely SOURCE-length based (newline
 * preferred) — exactly the legacy behaviour. With `measureRendered` the split
 * is RENDER-AWARE: `renderAgentHtml` inflates the source (HTML-escaping
 * `& < >`, adding `<b>`/`<pre>` tags), so a 4000-char source chunk can render
 * past Telegram's 4096 cap. The caller injects the measure (keeping this module
 * dependency-free); each candidate chunk is shrunk until its rendered length
 * fits {@link RENDERED_CHUNK_CAP}, which leaves margin for the fence wrappers
 * {@link rebalanceFences} may still add afterwards.
 *
 * @param measureRendered Maps a candidate source chunk to its rendered length.
 *   Omitted → source-length splitting, byte-identical to the legacy output.
 */
export function splitMessage(
  text: string,
  maxLen: number = MAX_MESSAGE_LEN,
  measureRendered?: (chunk: string) => number,
): string[] {
  if (text.length <= maxLen && (!measureRendered || measureRendered(text) <= RENDERED_CHUNK_CAP)) {
    return [text];
  }
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (
      remaining.length <= maxLen &&
      (!measureRendered || measureRendered(remaining) <= RENDERED_CHUNK_CAP)
    ) {
      parts.push(remaining);
      break;
    }
    const cutAt = getChunkCutAt(remaining, maxLen, measureRendered);
    parts.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^\n/, '');
  }
  return rebalanceFences(parts);
}

/**
 * @description Choose the source index to cut `remaining` at for the next
 * chunk. Starts from the newline-preferred SOURCE boundary (legacy behaviour),
 * then — only when a render measure is supplied — retreats while the rendered
 * candidate exceeds {@link RENDERED_CHUNK_CAP}: first to the previous newline,
 * then shrinking progressively. A floor of {@link MIN_RENDER_AWARE_CHUNK_LEN}
 * guarantees forward progress (never an empty chunk, never an infinite loop)
 * even for a single un-splittable escapable-heavy token.
 */
function getChunkCutAt(
  remaining: string,
  maxLen: number,
  measureRendered?: (chunk: string) => number,
): number {
  let cutAt = maxLen;
  const lastNewline = remaining.lastIndexOf('\n', maxLen);
  if (lastNewline > maxLen * 0.5) cutAt = lastNewline;
  if (!measureRendered) return cutAt;

  while (cutAt > MIN_RENDER_AWARE_CHUNK_LEN && measureRendered(remaining.slice(0, cutAt)) > RENDERED_CHUNK_CAP) {
    // Prefer retreating to the previous newline (keeps lines intact); if there
    // is none within the candidate, halve the slice to shrink it geometrically.
    const previousNewline = remaining.lastIndexOf('\n', cutAt - 1);
    cutAt = previousNewline > MIN_RENDER_AWARE_CHUNK_LEN ? previousNewline : Math.floor(cutAt / 2);
  }
  return Math.max(cutAt, MIN_RENDER_AWARE_CHUNK_LEN);
}
