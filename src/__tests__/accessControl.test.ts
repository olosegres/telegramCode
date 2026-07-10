/**
 * @description Unit coverage for the runtime access-control module.
 *
 * `extractAdminIds` and `AdminCache` are pure / DI-driven (clock + fetch are
 * injected), so these tests run with no Telegram, no timers, and no state.json.
 * They are the load-bearing proof for the parts that can't be exercised live
 * under a single account: a demoted/left user losing access on the next refresh,
 * and a promoted user gaining it.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { ChatMember, User } from 'telegraf/typings/core/types/typegram';
import { extractAdminIds, AdminCache, checkShouldInvalidateAdminCache } from '../accessControl';

function makeUser(id: number, isBot = false): User {
  return { id, is_bot: isBot, first_name: `u${id}` };
}

function owner(id: number, isBot = false): ChatMember {
  return { status: 'creator', user: makeUser(id, isBot), is_anonymous: false };
}

function admin(id: number, isBot = false): ChatMember {
  return {
    status: 'administrator',
    user: makeUser(id, isBot),
    can_be_edited: false,
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: false,
    can_manage_video_chats: false,
    can_restrict_members: false,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: false,
  };
}

function member(id: number): ChatMember {
  return { status: 'member', user: makeUser(id) };
}

function left(id: number): ChatMember {
  return { status: 'left', user: makeUser(id) };
}

// ─── extractAdminIds ────────────────────────────────────────────────────

test('extractAdminIds: keeps creator + administrator, drops members/left and bots', () => {
  const members: ChatMember[] = [owner(1), admin(2), admin(3, true), member(4), left(5)];
  assert.deepEqual(extractAdminIds(members).sort((a, b) => a - b), [1, 2]);
});

test('extractAdminIds: empty input → empty', () => {
  assert.deepEqual(extractAdminIds([]), []);
});

// ─── AdminCache ─────────────────────────────────────────────────────────

test('AdminCache: no re-fetch within the TTL', async () => {
  let calls = 0;
  let clock = 1000;
  const cache = new AdminCache({
    fetchAdmins: async () => { calls += 1; return [owner(1), admin(2)]; },
    ttlMs: 1000,
    now: () => clock,
  });

  const first = await cache.getAdminIds();
  assert.deepEqual([...first].sort((a, b) => a - b), [1, 2]);

  clock += 500; // still inside the TTL window
  await cache.getAdminIds();
  await cache.getAdminIds();
  assert.equal(calls, 1);
});

test('AdminCache: re-fetch after TTL reflects promotion/demotion (load-bearing)', async () => {
  let calls = 0;
  let clock = 0;
  let roster: ChatMember[] = [owner(1), admin(2)];
  const cache = new AdminCache({
    fetchAdmins: async () => { calls += 1; return roster; },
    ttlMs: 1000,
    now: () => clock,
  });

  const before = await cache.getAdminIds();
  assert.equal(before.has(2), true);  // 2 is an admin initially
  assert.equal(before.has(3), false); // 3 isn't

  roster = [owner(1), admin(3)]; // demote 2, promote 3
  clock += 1001;                 // expire the cache

  const after = await cache.getAdminIds();
  assert.equal(after.has(2), false); // demoted → access dropped
  assert.equal(after.has(3), true);  // promoted → access granted
  assert.equal(calls, 2);
});

test('AdminCache: concurrent stale reads share one in-flight fetch', async () => {
  let calls = 0;
  let resolveFetch!: (members: ChatMember[]) => void;
  const cache = new AdminCache({
    fetchAdmins: () => {
      calls += 1;
      return new Promise<ChatMember[]>((resolve) => { resolveFetch = resolve; });
    },
    ttlMs: 1000,
    now: () => 0,
  });

  const p1 = cache.getAdminIds();
  const p2 = cache.getAdminIds();
  resolveFetch([owner(1)]);
  const [s1, s2] = await Promise.all([p1, p2]);

  assert.equal(calls, 1);
  assert.equal(s1.has(1), true);
  assert.equal(s2.has(1), true);
});

test('AdminCache: a failed fetch keeps the last-known set and backs off', async () => {
  let calls = 0;
  let clock = 0;
  let shouldFail = false;
  const cache = new AdminCache({
    fetchAdmins: async () => {
      calls += 1;
      if (shouldFail) throw new Error('boom');
      return [owner(1)];
    },
    ttlMs: 1000,
    failureRetryMs: 500,
    now: () => clock,
  });

  const ok = await cache.getAdminIds();
  assert.equal(ok.has(1), true);
  assert.equal(calls, 1);

  clock += 1001;     // expire
  shouldFail = true;
  const kept = await cache.getAdminIds(); // fetch throws
  assert.equal(kept.has(1), true);        // last-known retained, no lockout
  assert.equal(calls, 2);

  clock += 100;      // inside the failure backoff window
  await cache.getAdminIds();
  assert.equal(calls, 2); // suppressed — no API hammer

  clock += 500;      // past the backoff window
  await cache.getAdminIds();
  assert.equal(calls, 3); // retried
});

test('AdminCache: invalidate() forces the next read to re-fetch', async () => {
  let calls = 0;
  const cache = new AdminCache({
    fetchAdmins: async () => { calls += 1; return [owner(1)]; },
    ttlMs: 1_000_000,
    now: () => 0,
  });

  await cache.getAdminIds();
  await cache.getAdminIds();
  assert.equal(calls, 1); // fresh — cached

  cache.invalidate();
  await cache.getAdminIds();
  assert.equal(calls, 2); // forced refresh
});

// ─── checkShouldInvalidateAdminCache (chat_member → cache invalidation) ──

test('chat_member transitions touching admin status invalidate the cache', () => {
  // Promotion: a member becomes an admin → the admin set grew.
  assert.equal(checkShouldInvalidateAdminCache('member', 'administrator'), true);
  // Demotion: an admin becomes a regular member → must lose access NOW, not at TTL.
  assert.equal(checkShouldInvalidateAdminCache('administrator', 'member'), true);
  // An admin leaves / is kicked → the admin set shrank.
  assert.equal(checkShouldInvalidateAdminCache('administrator', 'left'), true);
  assert.equal(checkShouldInvalidateAdminCache('creator', 'member'), true);
});

test('chat_member transitions of regular members do not invalidate the cache', () => {
  // Join / leave / restriction of a non-admin can't change the admin set.
  assert.equal(checkShouldInvalidateAdminCache('left', 'member'), false);
  assert.equal(checkShouldInvalidateAdminCache('member', 'left'), false);
  assert.equal(checkShouldInvalidateAdminCache('member', 'restricted'), false);
});
