/**
 * @description Integration test for the wedged-turn notice wired into the REAL
 * OpenCode SSE path. Drives synthesized `/global/event` envelopes through
 * `routeSseData` (the same entry the live reader uses) and captures `output`
 * events off the adapter EventEmitter.
 *
 * Bug (live 2026-08-15, the my-news digest schedule): a bloated session accepted
 * every prompt (HTTP 204) but its agent loop exited immediately — `session.idle`
 * arrived with zero assistant activity, so the topic looked silently hung. The
 * fix arms a per-prompt flag (`awaitingTurnResponse`) and, when idle brings no
 * activity, emits `agent.no_response`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type OutputEventMeta, type ThreadKey } from '../types';
import { t } from '../i18n';

const ownSessionId = 'ses_own';
const key: ThreadKey = { chatId: -100123, threadId: 42 };
const workDir = '/tmp/work';
const noResponseNotice = t('agent.no_response');

/**
 * Build a live session mirroring the fields the idle path reads. `overrides`
 * tune the wedge preconditions (a just-sent prompt = awaiting + no activity).
 */
function createAdapterWithSession(overrides: Record<string, unknown>): {
  adapter: OpenCodeAdapter;
  outputs: string[];
  metas: (OutputEventMeta | undefined)[];
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

  const outputs: string[] = [];
  const metas: (OutputEventMeta | undefined)[] = [];
  adapter.on('output', (_key: ThreadKey, text: string, meta?: OutputEventMeta) => {
    outputs.push(text);
    metas.push(meta);
  });
  return { adapter, outputs, metas };
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

describe('OpenCode wedged-turn notice', () => {
  it('prompt awaited, idle with NO activity → emits the no-response notice once', () => {
    const { adapter, outputs, metas } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
    });

    feedSessionIdle(adapter);

    assert.deepEqual(outputs, [noResponseNotice]);
    assert.equal(metas[0]?.isComplete, true);
    // Resolved: the pending flag is cleared so a later idle cannot re-fire.
    assert.equal(adapter['sessions'].get(keyToString(key)).awaitingTurnResponse, false);

    feedSessionIdle(adapter);
    assert.equal(outputs.length, 1, 'a second idle must not re-emit the notice');
  });

  it('a turn that produced activity → idle emits NO notice', () => {
    const { adapter, outputs } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
    });

    // A real part arrives → handlePartUpdate marks activity.
    feedTextDelta(adapter, 'Working on it…');
    assert.equal(
      adapter['sessions'].get(keyToString(key)).sawTurnActivity,
      true,
      'a part must mark turn activity',
    );

    feedSessionIdle(adapter);
    assert.equal(
      outputs.includes(noResponseNotice),
      false,
      'a healthy turn must never show the wedge notice',
    );
  });

  it('idle with no pending prompt (resume / spurious idle) → NO notice', () => {
    const { adapter, outputs } = createAdapterWithSession({
      awaitingTurnResponse: false,
      sawTurnActivity: false,
    });

    feedSessionIdle(adapter);
    assert.equal(outputs.includes(noResponseNotice), false);
  });

  it('a compaction cycle idling with no text → NO notice', () => {
    const { adapter, outputs } = createAdapterWithSession({
      awaitingTurnResponse: true,
      sawTurnActivity: false,
      isCompacting: true,
    });

    feedSessionIdle(adapter);
    assert.equal(outputs.includes(noResponseNotice), false);
  });
});
