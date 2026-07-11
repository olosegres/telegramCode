/**
 * @description Unit coverage for `postReattachRecap` — the bot-side orchestration
 * of the silent-reattach recap (S1 idempotency). Two load-bearing guarantees:
 *
 *   1. After the recap is computed the persisted watermark is ALWAYS advanced to
 *      the session's head (`recap.headWatermark`) — whether or not a recap posted,
 *      and even on `missedCount === 0` — so the same gap can never re-report on the
 *      next reattach. Skipped only when the head is unknown (record read failed).
 *   2. The recap baseline is the PRE-adopt watermark SNAPSHOT passed by the caller,
 *      not a re-read of state — so the concurrent live-advance can't move it out
 *      from under the recap read and suppress a genuine recap.
 *
 * The side-effecting collaborators (`reply`, `advanceWatermark`) are injected so
 * the orchestration is observable without a real Telegram send / StateStore. The
 * adapter is a minimal stub (only `getReattachRecap` is consulted).
 *
 * `./reattachRecapPost.testSetup` is imported FIRST so `bot.ts`'s boot-time
 * `parseEnv()` finds a token + a valid `WORK_ROOT` before the module evaluates.
 *
 * Test case: N/A — TelegramCode has no Jira tracker. TODO: add a test-case key
 * if one is ever created.
 */
import './reattachRecapPost.testSetup';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { postReattachRecap } from '../bot';
import type { AgentAdapter, ReattachRecap, SeenWatermark, ThreadKey } from '../types';

const key: ThreadKey = { chatId: -1001111111111, threadId: 9085 };
const workDir = '/work/ws-setup';
const sessionId = 'sess-1';
const head: SeenWatermark = { sessionId, claudeTranscriptOffset: 2_603_805 };
const snapshot: SeenWatermark = { sessionId, claudeTranscriptOffset: 2_597_508 };

const oneTurn = [{ role: 'assistant' as const, text: 'the answer' }];

function makeAdapter(
  recap: ReattachRecap,
  capture?: { watermark: SeenWatermark | null },
): Pick<AgentAdapter, 'getReattachRecap'> {
  return {
    getReattachRecap: async (_key, _workDir, _sessionId, watermark) => {
      if (capture) capture.watermark = watermark;
      return recap;
    },
  };
}

describe('postReattachRecap (S1 idempotency)', () => {
  let replyCalls: Array<{ key: ThreadKey; text: string }>;
  let advanceCalls: Array<{ key: ThreadKey; watermark: SeenWatermark }>;
  let deps: {
    reply: (key: ThreadKey, text: string) => Promise<unknown>;
    advanceWatermark: (key: ThreadKey, watermark: SeenWatermark) => void;
  };

  beforeEach(() => {
    replyCalls = [];
    advanceCalls = [];
    deps = {
      reply: async (k, text) => {
        replyCalls.push({ key: k, text });
        return undefined;
      },
      advanceWatermark: (k, watermark) => {
        advanceCalls.push({ key: k, watermark });
      },
    };
  });

  it('advances to head EVEN when nothing posts (clean hot reload, missedCount 0)', async () => {
    const recap: ReattachRecap = {
      missedCount: 0,
      turns: oneTurn,
      isWatermarkKnown: true,
      isActive: false,
      headWatermark: head,
    };
    // Hot reload (isColdStart=false) + known watermark + N==0 → the gate suppresses
    // the post, but the watermark MUST still advance so the gap can't re-report.
    await postReattachRecap(key, makeAdapter(recap), workDir, sessionId, snapshot, false, deps);
    assert.equal(replyCalls.length, 0, 'must not post when nothing was missed');
    assert.equal(advanceCalls.length, 1, 'must advance the watermark even when not posting');
    assert.deepEqual(advanceCalls[0].watermark, head);
  });

  it('posts AND advances to head when there is genuinely missed output', async () => {
    const recap: ReattachRecap = {
      missedCount: 3,
      turns: oneTurn,
      isWatermarkKnown: true,
      isActive: false,
      headWatermark: head,
    };
    await postReattachRecap(key, makeAdapter(recap), workDir, sessionId, snapshot, false, deps);
    assert.equal(replyCalls.length, 1, 'a real missed-output recap must post');
    assert.equal(advanceCalls.length, 1);
    assert.deepEqual(advanceCalls[0].watermark, head);
  });

  it('uses the PASSED pre-adopt snapshot as the recap baseline, not a re-read', async () => {
    const capture: { watermark: SeenWatermark | null } = { watermark: null };
    const recap: ReattachRecap = {
      missedCount: 0,
      turns: oneTurn,
      isWatermarkKnown: true,
      isActive: false,
      headWatermark: head,
    };
    await postReattachRecap(key, makeAdapter(recap, capture), workDir, sessionId, snapshot, false, deps);
    assert.deepEqual(capture.watermark, snapshot, 'getReattachRecap must receive the caller snapshot');
  });

  it('skips the advance when the head is unknown (record read failed)', async () => {
    const recap: ReattachRecap = {
      missedCount: 0,
      turns: oneTurn,
      isWatermarkKnown: false,
      isActive: false,
      // headWatermark intentionally absent → head unknown
    };
    await postReattachRecap(key, makeAdapter(recap), workDir, sessionId, snapshot, false, deps);
    assert.equal(advanceCalls.length, 0, 'no advance when the head is unknown — retry next reattach');
  });

  it('is a no-op for an adapter without getReattachRecap (Terminal)', async () => {
    await postReattachRecap(key, {}, workDir, sessionId, snapshot, false, deps);
    assert.equal(replyCalls.length, 0);
    assert.equal(advanceCalls.length, 0);
  });
});
