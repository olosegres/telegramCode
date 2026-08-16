/**
 * @description Integration test for the wedged-turn notice wired into the REAL
 * OpenCode SSE path. Drives synthesized `/global/event` envelopes through
 * `routeSseData` (the same entry the live reader uses) and captures `output`
 * events off the adapter EventEmitter.
 *
 * Bug (live 2026-08-15/16, the my-news digest schedule): a bloated session
 * accepted every prompt (HTTP 204) but its agent loop exited immediately —
 * `session.idle` arrived with zero assistant activity, so the topic looked
 * silently hung. The fix arms a per-prompt flag (`awaitingTurnResponse`) and,
 * when idle brings no activity, emits a `noResponse` event so the bot can
 * auto-recover (fresh session + replay).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

const ownSessionId = 'ses_own';
const key: ThreadKey = { chatId: -100123, threadId: 42 };
const workDir = '/tmp/work';

/**
 * Build a live session mirroring the fields the idle path reads. `overrides`
 * tune the wedge preconditions (a just-sent prompt = awaiting + no activity).
 */
function createAdapterWithSession(overrides: Record<string, unknown>): {
  adapter: OpenCodeAdapter;
  noResponseKeys: ThreadKey[];
} {
  const adapter = new OpenCodeAdapter();
  const session = {
    key,
    sessionId: ownSessionId,
    workDir,
    isActive: true,
    currentResponseText: '',
    lastEmittedLength: 0,
    outputTimer: null,
    isModelInfoShown: true,
    modelOverride: null,
    currentModelLabel: 'anthropic/claude',
    partTypes: new Map(),
    statusDebounceTimer: null,
    pendingStatus: null,
    pendingQuestion: null,
    effortLevel: null,
    isBusy: true,
    awaitingTurnResponse: false,
    sawTurnActivity: false,
    providerRetrySignature: null,
    isAwaitingModelAfterProviderRetryAbort: false,
    providerRetryAbortPromise: null,
    isCompacting: false,
    busyChildSessionIds: new Set(),
    lastMessageId: undefined,
    sseController: null,
    reconnectTimer: null,
    sseStallTimer: null,
    ...overrides,
  };
  adapter['sessions'].set(keyToString(key), session);

  const noResponseKeys: ThreadKey[] = [];
  adapter.on('noResponse', (k: ThreadKey) => {
    noResponseKeys.push(k);
  });
  return { adapter, noResponseKeys };
}

function globalEnvelope(type: string, properties: Record<string, unknown>): string {
  return JSON.stringify({ directory: workDir, project: 'proj', payload: { type, properties } });
}

function feedSessionIdle(adapter: OpenCodeAdapter): void {
  adapter['routeSseData'](globalEnvelope('session.idle', { sessionID: ownSessionId }));
}

function feedTextDelta(adapter: OpenCodeAdapter, delta: string): void {
  adapter['routeSseData'](
    globalEnvelope('message.part.delta', {
      sessionID: ownSessionId, messageID: 'msg_1', partID: 'prt_1', field: 'text', delta,
    }),
  );
}

/** Feed an assistant `message.updated` — the ONLY signal that marks turn
 * activity (a user prompt's own echoed parts must NOT count). */
function feedAssistantMessage(adapter: OpenCodeAdapter): void {
  adapter['routeSseData'](
    globalEnvelope('message.updated', {
      info: { id: 'msg_asst_1', sessionID: ownSessionId, role: 'assistant' },
    }),
  );
}

describe('OpenCode wedged-turn noResponse event', () => {
  it('prompt awaited, idle with NO activity → emits noResponse once', () => {
    const { adapter, noResponseKeys } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
    });

    feedSessionIdle(adapter);

    assert.equal(noResponseKeys.length, 1);
    assert.deepEqual(noResponseKeys[0], key);
    // Resolved: the pending flag is cleared so a later idle cannot re-fire.
    assert.equal(adapter['sessions'].get(keyToString(key)).awaitingTurnResponse, false);

    feedSessionIdle(adapter);
    assert.equal(noResponseKeys.length, 1, 'a second idle must not re-emit noResponse');
  });

  it('reattached session with undefined providerRetrySignature still fires (guard-bug regression)', () => {
    // The resume path never sets providerRetrySignature — it must read as "no
    // retry" so the wedge is NOT silently suppressed (live miss 2026-08-16).
    const { adapter, noResponseKeys } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
      providerRetrySignature: undefined,
    });

    feedSessionIdle(adapter);
    assert.equal(noResponseKeys.length, 1);
  });

  it('a turn that produced assistant activity → idle emits NO noResponse', () => {
    const { adapter, noResponseKeys } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
    });

    // An assistant message arrives → the turn genuinely started.
    feedAssistantMessage(adapter);
    assert.equal(
      adapter['sessions'].get(keyToString(key)).sawTurnActivity,
      true,
      'an assistant message must mark turn activity',
    );

    feedSessionIdle(adapter);
    assert.equal(noResponseKeys.length, 0, 'a healthy turn must never fire noResponse');
  });

  it('the user prompt echo (a text part, NOT an assistant message) does NOT mask a wedge', () => {
    // Regression: prompt_async emits message.part events for the USER prompt;
    // counting those as activity masked the wedge (live 2026-08-16).
    const { adapter, noResponseKeys } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
    });

    feedTextDelta(adapter, '[Scheduled run] Дайджест'); // the echoed user prompt
    assert.equal(
      adapter['sessions'].get(keyToString(key)).sawTurnActivity,
      false,
      'a user-prompt text part must NOT mark turn activity',
    );

    feedSessionIdle(adapter);
    assert.equal(noResponseKeys.length, 1, 'the wedge must still fire despite the prompt echo');
  });

  it('idle with no pending prompt (resume / spurious idle) → NO noResponse', () => {
    const { adapter, noResponseKeys } = createAdapterWithSession({
      awaitingTurnResponse: false,
      sawTurnActivity: false,
    });

    feedSessionIdle(adapter);
    assert.equal(noResponseKeys.length, 0);
  });

  it('a compaction cycle idling with no text → NO noResponse', () => {
    const { adapter, noResponseKeys } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
      isCompacting: true,
    });

    feedSessionIdle(adapter);
    assert.equal(noResponseKeys.length, 0);
  });
});
