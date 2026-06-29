/**
 * @description Coverage for `src/updateDispatcher.ts` — the off-loop update
 * dispatcher that decouples Telegraf's long-polling intake/ACK from per-handler
 * latency.
 *
 * The whole point is: enqueue per-thread-serial, return immediately, run the
 * real chain off the polling loop. These tests pin:
 *   - `getUpdateQueueKey` maps each update shape to its coarse `chatId:threadId`
 *     (or `global`) key (1)
 *   - same-key work runs strictly FIFO even when the first task is slower (2)
 *   - different-key work overlaps / runs concurrently (3)
 *   - `dispatch` returns before its `run` even starts (4)
 *   - a throwing `run` is isolated to `onError`, not the queue or siblings (5)
 *   - `drainIdle` resolves after outstanding settle, and times out (never
 *     hangs) when a task never settles (6)
 *
 * Each assertion fails if the feature regresses (load-bearing).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Update } from 'telegraf/typings/core/types/typegram';
import type { User } from 'telegraf/typings/core/types/typegram';
import { createUpdateDispatcher, getUpdateQueueKey } from '../updateDispatcher';

// ── Typed fixture builders (minimal-but-complete Update shapes, no casts) ──

const sender: User = { id: 555, is_bot: false, first_name: 'Tester' };

function buildMessageUpdate(chatId: number, threadId?: number): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'supergroup', title: 'Group', is_forum: true },
      from: sender,
      text: 'hello',
      ...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
    },
  };
}

function buildDmMessageUpdate(chatId: number): Update {
  return {
    update_id: 2,
    message: {
      message_id: 11,
      date: 1_700_000_001,
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
      from: sender,
      text: 'dm',
    },
  };
}

function buildCallbackQueryUpdate(chatId: number, threadId: number): Update {
  return {
    update_id: 3,
    callback_query: {
      id: 'cb1',
      from: sender,
      chat_instance: 'inst',
      data: 'pick:1',
      message: {
        message_id: 12,
        date: 1_700_000_002,
        chat: { id: chatId, type: 'supergroup', title: 'Group', is_forum: true },
        message_thread_id: threadId,
        is_topic_message: true,
      },
    },
  };
}

function buildMyChatMemberUpdate(chatId: number): Update {
  return {
    update_id: 4,
    my_chat_member: {
      chat: { id: chatId, type: 'supergroup', title: 'Group', is_forum: true },
      from: sender,
      date: 1_700_000_003,
      old_chat_member: { status: 'member', user: sender },
      new_chat_member: { status: 'administrator', user: sender, can_be_edited: false, is_anonymous: false },
    },
  };
}

function buildNoChatUpdate(): Update {
  return {
    update_id: 5,
    inline_query: { id: 'iq1', from: sender, query: 'search', offset: '' },
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── (1) getUpdateQueueKey ──────────────────────────────────────────────────

test('getUpdateQueueKey: message in a forum topic → "<chatId>:<threadId>"', () => {
  assert.equal(getUpdateQueueKey(buildMessageUpdate(-100, 42)), '-100:42');
});

test('getUpdateQueueKey: DM message with no thread → "<chatId>:0"', () => {
  assert.equal(getUpdateQueueKey(buildDmMessageUpdate(777)), '777:0');
});

test('getUpdateQueueKey: callback_query keys off its inner message', () => {
  assert.equal(getUpdateQueueKey(buildCallbackQueryUpdate(-100, 7)), '-100:7');
});

test('getUpdateQueueKey: my_chat_member → "<chatId>:0" (chat, no thread)', () => {
  assert.equal(getUpdateQueueKey(buildMyChatMemberUpdate(-100)), '-100:0');
});

test('getUpdateQueueKey: update with no chat → "global"', () => {
  assert.equal(getUpdateQueueKey(buildNoChatUpdate()), 'global');
});

// ── (2) Ordering: same key runs strictly FIFO even when the first is slower ──

test('same-key dispatches run strictly FIFO even when the first task is slower', async () => {
  const dispatcher = createUpdateDispatcher({ getKey: getUpdateQueueKey });
  const events: string[] = [];
  const sameKey = buildMessageUpdate(-100, 42);

  dispatcher.dispatch(sameKey, async () => {
    events.push('1:start');
    await delay(30); // first is the SLOW one
    events.push('1:end');
  });
  dispatcher.dispatch(sameKey, async () => {
    events.push('2:start');
    events.push('2:end');
  });

  await dispatcher.drainIdle(1000);

  assert.deepEqual(events, ['1:start', '1:end', '2:start', '2:end']);
});

// ── (3) Parallelism: different keys overlap ─────────────────────────────────

test('different-key dispatches run concurrently (second starts before first ends)', async () => {
  const dispatcher = createUpdateDispatcher({ getKey: getUpdateQueueKey });
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstDone = false;
  let secondRan = false;

  dispatcher.dispatch(buildMessageUpdate(-100, 1), async () => {
    await firstGate; // key A blocks until released
    firstDone = true;
  });
  dispatcher.dispatch(buildMessageUpdate(-100, 2), async () => {
    secondRan = true; // key B must not be gated behind key A
  });

  // Let microtasks flush; key B (different key) should have run while A is gated.
  await delay(10);
  assert.equal(secondRan, true, 'second key must run while the first is still blocked');
  assert.equal(firstDone, false, 'first key is still gated, proving they overlap');

  releaseFirst();
  await dispatcher.drainIdle(1000);
  assert.equal(firstDone, true);
});

// ── (4) dispatch returns immediately, does not await run ────────────────────

test('dispatch returns synchronously and does not await run', async () => {
  const dispatcher = createUpdateDispatcher({ getKey: getUpdateQueueKey });
  let started = false;

  const returnValue = dispatcher.dispatch(buildMessageUpdate(-100, 1), async () => {
    started = true;
    await delay(50);
  });

  // dispatch returns void, and run has not even begun on the same tick.
  assert.equal(returnValue, undefined);
  assert.equal(started, false, 'run must not start synchronously inside dispatch');
  assert.equal(dispatcher.size(), 1, 'task is outstanding immediately');

  await dispatcher.drainIdle(1000);
  assert.equal(started, true);
});

// ── (5) A throwing run is isolated to onError; queue + siblings keep running ─

test('a throwing run routes to onError without breaking its queue or siblings', async () => {
  const errors: unknown[] = [];
  const dispatcher = createUpdateDispatcher({
    getKey: getUpdateQueueKey,
    onError: (error) => { errors.push(error); },
  });
  const keyA = buildMessageUpdate(-100, 1);
  const keyB = buildMessageUpdate(-200, 1);
  let sameQueueAfterThrowRan = false;
  let siblingRan = false;

  dispatcher.dispatch(keyA, async () => {
    throw new Error('boom');
  });
  dispatcher.dispatch(keyA, async () => {
    sameQueueAfterThrowRan = true; // same key, AFTER the throw → must still run
  });
  dispatcher.dispatch(keyB, async () => {
    siblingRan = true; // different key → unaffected
  });

  await dispatcher.drainIdle(1000);

  assert.equal(errors.length, 1, 'the thrown error must reach onError');
  assert.ok(errors[0] instanceof Error && errors[0].message === 'boom');
  assert.equal(sameQueueAfterThrowRan, true, 'a throw must not wedge its own queue');
  assert.equal(siblingRan, true, 'a throw must not affect a sibling key');
  assert.equal(dispatcher.size(), 0, 'all tasks settled (even the thrown one)');
});

// ── (6) drainIdle resolves after settle; times out without hanging ──────────

test('drainIdle resolves once all outstanding work settles', async () => {
  const dispatcher = createUpdateDispatcher({ getKey: getUpdateQueueKey });
  let done = 0;

  dispatcher.dispatch(buildMessageUpdate(-100, 1), async () => { await delay(20); done += 1; });
  dispatcher.dispatch(buildMessageUpdate(-200, 1), async () => { await delay(20); done += 1; });
  assert.equal(dispatcher.size(), 2);

  await dispatcher.drainIdle(1000);

  assert.equal(done, 2, 'both tasks completed before drainIdle resolved');
  assert.equal(dispatcher.size(), 0);
});

test('drainIdle times out (does not hang) when a task never settles', async () => {
  const dispatcher = createUpdateDispatcher({ getKey: getUpdateQueueKey });
  let release: () => void = () => {};
  const stuck = new Promise<void>((resolve) => { release = resolve; });

  dispatcher.dispatch(buildMessageUpdate(-100, 1), () => stuck);

  const timeoutMs = 30;
  const start = Date.now();
  await dispatcher.drainIdle(timeoutMs);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 300, `drainIdle should return near the timeout, got ${elapsed}ms`);
  assert.equal(dispatcher.size(), 1, 'the stuck task is still outstanding — drain timed out, did not wait it out');

  // Clean up the orphan so node:test doesn't flag a pending promise.
  release();
  await dispatcher.drainIdle(1000);
});
