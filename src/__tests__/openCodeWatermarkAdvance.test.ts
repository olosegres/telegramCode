/**
 * @description S7 — the OpenCode adapter advances the persisted seen-watermark on
 * each PARENT assistant message `finish` (in `handleMessageUpdate`), not only at
 * turn-end idle. The bot relays every completed assistant message live, so the
 * watermark must track each finished parent id — otherwise a mid-turn restart
 * re-counts the whole in-flight multi-message turn as a false "⚠️ missed N" (live
 * 2026-07-04, topic 218). A CHILD (sub-agent) message finishing must NEVER
 * advance the watermark (its id would poison the parent's `[watermark, …)`
 * window).
 *
 * Harness mirrors openCodeModelInfo.test.ts: a session is injected into the
 * adapter, the injected seen-watermark writer is captured, and a real
 * `/global/event` `message.updated` envelope is fed through the SSE dispatcher
 * (`routeSseData`). Private members are reached via runtime bracket access
 * (tests are type-stripped by tsx, so this does not affect `yarn typecheck`).
 *
 * Test case: N/A — telegramCode has no Jira tracker. TODO: add a test-case key
 * if one is ever created.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type SeenWatermark, type ThreadKey } from '../types';

const ownSessionId = 'ses_wm_parent';
const childSessionId = 'ses_wm_child';
const key: ThreadKey = { chatId: -100999222, threadId: 555 };

/** A complete-enough live session so `flushOutput` (called on a `finish`) runs
 *  without touching an undefined field. */
function buildSession() {
  return {
    key,
    sessionId: ownSessionId,
    workDir: '/tmp/work',
    isActive: true,
    currentResponseText: '',
    lastEmittedLength: 0,
    outputTimer: null,
    childResponseText: '',
    childLastEmittedLength: 0,
    childOutputTimer: null,
    activeSubagentTitle: null,
    isModelInfoShown: true,
    modelOverride: null,
    currentModelLabel: 'anthropic/claude',
    partTypes: new Map(),
    statusDebounceTimer: null,
    pendingStatus: null,
    reasoningText: '',
    reasoningStartedAt: null,
    reasoningTimer: null,
    emittedToolResultPartIds: new Set(),
    pendingQuestion: null,
    effortLevel: null,
    isBusy: false,
    isCompacting: false,
    busyChildSessionIds: new Set(),
    lastMessageId: undefined,
    isAutoNamePending: false,
    sseController: null,
    reconnectTimer: null,
    sseStallTimer: null,
  };
}

function createAdapterWithSession(): { adapter: OpenCodeAdapter; writes: SeenWatermark[] } {
  const adapter = new OpenCodeAdapter();
  adapter['sessions'].set(keyToString(key), buildSession());
  const writes: SeenWatermark[] = [];
  adapter.setSeenWatermarkWriter((_key, watermark) => writes.push(watermark));
  return { adapter, writes };
}

/** Feed a `message.updated` envelope through the real SSE dispatcher. */
function feedMessageUpdated(
  adapter: OpenCodeAdapter,
  info: { id?: string; role: string; sessionID?: string; finish?: string },
): void {
  adapter['routeSseData'](
    JSON.stringify({
      directory: '/tmp/work',
      project: 'proj',
      payload: { type: 'message.updated', properties: { info } },
    }),
  );
}

describe('OpenCode seen-watermark advance on parent finish (S7)', () => {
  it('advances the watermark on a PARENT assistant finish', () => {
    const { adapter, writes } = createAdapterWithSession();

    feedMessageUpdated(adapter, { id: 'msg_1', role: 'assistant', sessionID: ownSessionId, finish: 'stop' });

    assert.deepEqual(writes, [{ sessionId: ownSessionId, opencodeMessageId: 'msg_1' }]);
  });

  it('advances again on each subsequent parent finish (per-message, not once)', () => {
    const { adapter, writes } = createAdapterWithSession();

    feedMessageUpdated(adapter, { id: 'msg_1', role: 'assistant', sessionID: ownSessionId, finish: 'stop' });
    feedMessageUpdated(adapter, { id: 'msg_2', role: 'assistant', sessionID: ownSessionId, finish: 'stop' });

    assert.deepEqual(writes, [
      { sessionId: ownSessionId, opencodeMessageId: 'msg_1' },
      { sessionId: ownSessionId, opencodeMessageId: 'msg_2' },
    ]);
  });

  it('does NOT advance on a CHILD (sub-agent) message finish', () => {
    const { adapter, writes } = createAdapterWithSession();

    // A child assistant message carries a foreign sessionID → isParentMessage is
    // false → the watermark must not move (and lastMessageId must not become the
    // child's id).
    feedMessageUpdated(adapter, { id: 'child_msg', role: 'assistant', sessionID: childSessionId, finish: 'stop' });

    assert.deepEqual(writes, [], 'a child finish must never advance the watermark');
    assert.equal(adapter['sessions'].get(keyToString(key)).lastMessageId, undefined);
  });

  it('does NOT advance on an assistant message that has not finished yet', () => {
    const { adapter, writes } = createAdapterWithSession();

    // No `finish` → still streaming; the advance is only on completion.
    feedMessageUpdated(adapter, { id: 'msg_live', role: 'assistant', sessionID: ownSessionId });

    assert.deepEqual(writes, []);
  });
});
