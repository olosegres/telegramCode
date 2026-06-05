/**
 * @description Debounced batching of Telegram media-album items.
 *
 * A media album (multiple photos/files sent as one visual message) arrives over
 * the Bot API as N SEPARATE messages that share a `media_group_id`, delivered in
 * a quick burst. Forwarding each as its own agent prompt makes them abort one
 * another's generation, and any per-item gating hint ("no agent running") fires
 * N times. This collector coalesces a group: each {@link MediaGroupCollector.collect}
 * call appends the item and resets a per-group debounce timer; once the burst
 * settles (no new item for `debounceMs`) the `onFlush` callback fires ONCE with
 * the group's items in arrival order.
 *
 * It also owns the per-group HINT DEDUPE ({@link MediaGroupCollector.checkShouldAnnounceOnce}):
 * a small set keyed by the same group key so a gating reply (no agent / unbound)
 * or a download-error reply is emitted only once per album. Entries are dropped
 * when the group flushes or times out, so the structure can't leak; an explicit
 * cap bounds it even against a pathological flood of distinct group keys.
 *
 * Side-effect-free apart from timers — `debounceMs` is a constructor param so
 * tests drive it with real short timers (e.g. 50ms) instead of mocking the clock.
 */

/**
 * Hard ceiling on concurrently-tracked groups. Telegram albums settle within a
 * couple of seconds, so live groups are normally 0–1; this only guards against a
 * degenerate flood of distinct keys never flushing. When exceeded, the oldest
 * group is force-flushed to reclaim its slot rather than dropped silently.
 */
const maxConcurrentGroups = 256;

interface GroupState<TItem> {
  items: TItem[];
  timer: ReturnType<typeof setTimeout>;
  /** Whether the one-shot per-group announcement has already been claimed. */
  isAnnounced: boolean;
}

export interface MediaGroupCollector<TItem> {
  /**
   * Append an item to its group and (re)arm the group's debounce timer. The
   * group flushes `debounceMs` after the LAST collected item.
   */
  collect(groupKey: string, item: TItem): void;
  /**
   * One-shot guard for per-group side effects (gating hints, dedup'd error
   * replies). Returns `true` the FIRST time it is called for a still-open group
   * key and `false` for every subsequent call until that group flushes. A group
   * key with no live entry is created on demand so a hint can be claimed before
   * (or without) any item is collected.
   */
  checkShouldAnnounceOnce(groupKey: string): boolean;
  /** Number of groups currently buffered — for tests / diagnostics. */
  readonly size: number;
}

export interface MediaGroupCollectorOptions<TItem> {
  /** Quiet period after the last item before a group flushes. */
  debounceMs: number;
  /** Invoked once per settled group with its items in arrival order. */
  onFlush: (groupKey: string, items: TItem[]) => void;
}

/**
 * @description Create a {@link MediaGroupCollector}. The returned object holds
 * per-group timers internally; there is no global timer, so an idle collector
 * costs nothing.
 */
export function createMediaGroupCollector<TItem>(
  options: MediaGroupCollectorOptions<TItem>,
): MediaGroupCollector<TItem> {
  const { debounceMs, onFlush } = options;
  const groups = new Map<string, GroupState<TItem>>();

  function flush(groupKey: string): void {
    const group = groups.get(groupKey);
    if (!group) return;
    clearTimeout(group.timer);
    groups.delete(groupKey);
    // Flush even an item-less group (it may exist only to hold a claimed hint);
    // an empty array is a harmless no-op for the typical onFlush.
    onFlush(groupKey, group.items);
  }

  function armTimer(groupKey: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => flush(groupKey), debounceMs);
    // Don't let a pending album timer keep the process alive on shutdown.
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function ensureGroup(groupKey: string): GroupState<TItem> {
    const existing = groups.get(groupKey);
    if (existing) return existing;
    if (groups.size >= maxConcurrentGroups) {
      // Reclaim a slot by flushing the oldest (insertion-ordered) group.
      const oldestKey = groups.keys().next().value;
      if (oldestKey !== undefined) flush(oldestKey);
    }
    const created: GroupState<TItem> = { items: [], timer: armTimer(groupKey), isAnnounced: false };
    groups.set(groupKey, created);
    return created;
  }

  return {
    collect(groupKey, item) {
      const group = ensureGroup(groupKey);
      group.items.push(item);
      clearTimeout(group.timer);
      group.timer = armTimer(groupKey);
    },
    checkShouldAnnounceOnce(groupKey) {
      const group = ensureGroup(groupKey);
      if (group.isAnnounced) return false;
      group.isAnnounced = true;
      return true;
    },
    get size() {
      return groups.size;
    },
  };
}
