import type { ChatMember } from 'telegraf/typings/core/types/typegram';

/**
 * @description Access control for the bot: who may talk to the agent.
 *
 * The authority is fully runtime — the creator and administrators of the served
 * forum group, read live from Telegram via `getChatAdministrators`. There is no
 * static allow-list env and no `/grant` command: promoting/demoting someone in
 * the Telegram group is the only knob. To avoid an API round-trip on every
 * message the admin set is cached ({@link AdminCache}) with a long TTL and
 * refreshed lazily once it goes stale.
 */

/** Admin set cache lifetime. A demotion/promotion takes effect within this window. */
export const ADMIN_CACHE_TTL_MS = 3_600_000; // 1 hour

/**
 * After a failed `getChatAdministrators` we keep serving the last-known set and
 * suppress further fetches for this long, so a Telegram outage doesn't turn into
 * a per-message API hammer.
 */
export const ADMIN_CACHE_FAILURE_RETRY_MS = 60_000;

/**
 * @description Reduce a `getChatAdministrators` response to the human admin user
 * ids. Keeps only `creator` / `administrator` statuses and drops bots (Telegram
 * already excludes bots, but the guard makes the intent explicit and the helper
 * total over any `ChatMember[]`).
 */
export function extractAdminIds(members: ChatMember[]): number[] {
  const ids: number[] = [];
  for (const member of members) {
    if (member.status !== 'creator' && member.status !== 'administrator') continue;
    if (member.user.is_bot) continue;
    ids.push(member.user.id);
  }
  return ids;
}

/**
 * @description Should a `chat_member` status transition invalidate the cached
 * admin set? Only transitions that TOUCH admin status matter — someone was or
 * becomes creator/administrator (promotion, demotion, an admin leaving).
 * Joins/leaves of regular members can't change the admin set, so they must not
 * trigger a `getChatAdministrators` refetch.
 */
export function checkShouldInvalidateAdminCache(
  oldStatus: ChatMember['status'],
  newStatus: ChatMember['status'],
): boolean {
  return (
    oldStatus === 'creator' ||
    oldStatus === 'administrator' ||
    newStatus === 'creator' ||
    newStatus === 'administrator'
  );
}

export interface AdminCacheDeps {
  /** Fetches the current admin list (e.g. `bot.telegram.getChatAdministrators(groupId)`). */
  fetchAdmins: () => Promise<ChatMember[]>;
  /** Cache lifetime; defaults to {@link ADMIN_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** Backoff after a failed fetch; defaults to {@link ADMIN_CACHE_FAILURE_RETRY_MS}. */
  failureRetryMs?: number;
  /** Clock injection point for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * @description Lazily-refreshed cache of the served group's admin user ids.
 *
 * `getAdminIds()` returns the cached set while it's fresh (age < ttl); once
 * stale it re-fetches, replaces the set, and decides against the fresh data.
 * Concurrent callers during a fetch share one in-flight request. A fetch failure
 * keeps the last-known set (never locks everyone out) and starts a short backoff.
 */
export class AdminCache {
  private readonly fetchAdmins: () => Promise<ChatMember[]>;
  private readonly ttlMs: number;
  private readonly failureRetryMs: number;
  private readonly now: () => number;

  private ids = new Set<number>();
  /** Timestamp of the last SUCCESSFUL fetch, or `null` if never fetched. */
  private fetchedAt: number | null = null;
  /** Timestamp of the last FAILED fetch, or `null`. */
  private lastFailAt: number | null = null;
  private inFlight: Promise<Set<number>> | null = null;

  constructor(deps: AdminCacheDeps) {
    this.fetchAdmins = deps.fetchAdmins;
    this.ttlMs = deps.ttlMs ?? ADMIN_CACHE_TTL_MS;
    this.failureRetryMs = deps.failureRetryMs ?? ADMIN_CACHE_FAILURE_RETRY_MS;
    this.now = deps.now ?? Date.now;
  }

  async getAdminIds(): Promise<Set<number>> {
    const now = this.now();
    if (this.fetchedAt !== null && now - this.fetchedAt < this.ttlMs) {
      return this.ids;
    }
    if (this.inFlight) return this.inFlight;
    // A recent failure → serve last-known without re-hitting the API yet.
    if (this.lastFailAt !== null && now - this.lastFailAt < this.failureRetryMs) {
      return this.ids;
    }
    this.inFlight = this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /** Drop freshness so the next {@link getAdminIds} re-fetches (used on re-pair). */
  invalidate(): void {
    this.fetchedAt = null;
    this.lastFailAt = null;
  }

  private async refresh(): Promise<Set<number>> {
    try {
      const members = await this.fetchAdmins();
      this.ids = new Set(extractAdminIds(members));
      this.fetchedAt = this.now();
      this.lastFailAt = null;
      return this.ids;
    } catch (e) {
      this.lastFailAt = this.now();
      console.warn(
        '[access] getChatAdministrators failed; keeping last-known admin set:',
        e instanceof Error ? e.message : e,
      );
      return this.ids;
    }
  }
}
