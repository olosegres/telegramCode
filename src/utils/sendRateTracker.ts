/**
 * @description Pure, bounded rolling per-chat outbound send-rate tracker.
 *
 * A real Telegram 429 only fires under genuine concurrent multi-topic load and
 * cannot be reproduced from a single client, so the bot keeps ALWAYS-ON
 * instrumentation that characterises how hard each chat's outbound channel is
 * being pushed. This helper is the measurement core: it records a timestamp per
 * outbound send (hooked at the single send chokepoint in `rateLimiter.ts`) into
 * a bounded rolling window per chat, and answers two questions used by the rich
 * 429 log line and the periodic rate summary:
 *
 *   - sends in the last 60s (the sustained rate/min we pace against), and
 *   - the PEAK count in any short sub-window (e.g. busiest 10s burst), which
 *     reveals spikes the per-minute average hides.
 *
 * Bounded + best-effort by construction: each chat keeps at most
 * {@link maxTimestampsPerChat} timestamps (old ones evicted on every record),
 * so a runaway send loop can't grow memory without bound. It NEVER throws — the
 * caller hooks it on the send hot path and must not let instrumentation break a
 * send.
 *
 * The clock is injected (same `() => number` shape as {@link BucketClock.now})
 * so unit tests drive it deterministically with a fake clock.
 */

/** Rolling window the per-minute rate is measured over. */
const rateWindowMs = 60_000;
/** Default sub-window for the peak burst query (busiest 10s). */
export const defaultPeakSubWindowMs = 10_000;
/**
 * Hard cap on retained timestamps per chat. At the 40/min sustained ceiling a
 * 60s window holds ~40 sends; a generous cap absorbs bursts well past the
 * ceiling while still bounding memory if a send loop misbehaves. Oldest are
 * dropped first.
 */
const maxTimestampsPerChat = 600;

/**
 * @description A single chat's recent outbound send timestamps, oldest-first.
 * Kept oldest-first so eviction is a cheap prefix trim.
 */
type ChatSendLog = number[];

export class SendRateTracker {
  private readonly logs = new Map<number, ChatSendLog>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Record one outbound send for a chat. Evicts timestamps that have aged out
   * of the rolling window and enforces the per-chat hard cap. Never throws.
   */
  recordSend(chatId: number, nowMs: number = this.now()): void {
    let log = this.logs.get(chatId);
    if (!log) {
      log = [];
      this.logs.set(chatId, log);
    }
    log.push(nowMs);
    this.evict(log, nowMs);
  }

  /**
   * Number of sends within the last `windowMs` for a chat. Defaults to the
   * 60s window (sends/min — the sustained rate we pace against).
   */
  getSendsInWindow(chatId: number, windowMs: number = rateWindowMs, nowMs: number = this.now()): number {
    const log = this.logs.get(chatId);
    if (!log) return 0;
    const cutoff = nowMs - windowMs;
    let count = 0;
    // Oldest-first; walk from the end while inside the window.
    for (let i = log.length - 1; i >= 0; i -= 1) {
      if (log[i] <= cutoff) break;
      count += 1;
    }
    return count;
  }

  /** Sends in the last 60s for a chat (the sustained rate/min). */
  getSendsPerMin(chatId: number, nowMs: number = this.now()): number {
    return this.getSendsInWindow(chatId, rateWindowMs, nowMs);
  }

  /**
   * Peak number of sends in ANY sliding `subWindowMs` window across the
   * retained (last-60s) timestamps — the busiest short burst, which the
   * per-minute average can hide. Defaults to a 10s sub-window.
   */
  getPeakInSubWindow(
    chatId: number,
    subWindowMs: number = defaultPeakSubWindowMs,
    nowMs: number = this.now(),
  ): number {
    const log = this.logs.get(chatId);
    if (!log || log.length === 0) return 0;
    const windowStart = nowMs - rateWindowMs;
    // Only consider timestamps still inside the rolling minute, oldest-first.
    const recent = log.filter((ts) => ts > windowStart);
    if (recent.length === 0) return 0;
    // Sliding window over the sorted timestamps: for each start, count how many
    // fall within [ts, ts + subWindowMs).
    let peak = 0;
    let right = 0;
    for (let left = 0; left < recent.length; left += 1) {
      if (right < left) right = left;
      while (right < recent.length && recent[right] - recent[left] < subWindowMs) {
        right += 1;
      }
      const count = right - left;
      if (count > peak) peak = count;
    }
    return peak;
  }

  /**
   * Chat ids that have at least one send still inside the rolling minute — the
   * chats worth logging in the periodic rate summary (silent chats are skipped).
   * Also opportunistically drops fully-aged-out chat logs so the map doesn't
   * accumulate stale chats forever.
   */
  getActiveChats(nowMs: number = this.now()): number[] {
    const active: number[] = [];
    for (const [chatId, log] of this.logs) {
      this.evict(log, nowMs);
      if (log.length === 0) {
        this.logs.delete(chatId);
        continue;
      }
      active.push(chatId);
    }
    return active;
  }

  /** Evict timestamps older than the rolling window and enforce the hard cap. */
  private evict(log: ChatSendLog, nowMs: number): void {
    const cutoff = nowMs - rateWindowMs;
    // Drop the aged-out prefix (oldest-first → contiguous prefix).
    let dropTo = 0;
    while (dropTo < log.length && log[dropTo] <= cutoff) dropTo += 1;
    if (dropTo > 0) log.splice(0, dropTo);
    // Hard cap: if still over, drop the oldest overflow.
    if (log.length > maxTimestampsPerChat) {
      log.splice(0, log.length - maxTimestampsPerChat);
    }
  }
}
