/**
 * @description B9 — `fetchModelInfo` must not falsely claim "Model: not set"
 * when the `GET /config` request fails on a sick/booting server.
 *
 * Bug: a THROWN `/config` request (server stale-credentials / still booting)
 * was caught, logged, then fell through to the same final branch as a
 * successful-but-empty config — emitting "Model: not set (use /model to
 * select)" and pinning `currentModelLabel = 'not set'`. Live trace: 13:40:10
 * a stale-credentials server produced the false "not set", and 22s later a
 * second resolution corrected it to anthropic/claude-opus-4-8. The healthy
 * server has a default and the prompt path resolves it independently, so the
 * message was simply wrong.
 *
 * Fix: the catch returns early — no emit, `currentModelLabel` untouched,
 * `isModelInfoShown` stays false so the next assistant message
 * (`handleMessageUpdate`) corrects it. Only a SUCCESSFUL `/config` with
 * neither `defaultModel` nor `model` reaches the genuine "not set" branch.
 *
 * Retry opportunity: `fetchModelInfo` is invoked once per session (at
 * start, openCodeAdapter.ts:949). The correction path is
 * `handleMessageUpdate` (openCodeAdapter.ts:1988-1998): on the first
 * assistant message it sets `currentModelLabel` and, if `isModelInfoShown`
 * is still false, emits the real `Model: <label>` once. Leaving the flag
 * false on a transient failure is therefore sufficient — no extra hook
 * needed. Test (3) pins this by driving a real `message.updated` SSE event.
 *
 * Harness mirrors openCodeOutputDedup.test.ts: a session is injected into
 * the adapter, `apiRequest` is stubbed, `output` events captured, and the
 * private `fetchModelInfo` / SSE dispatcher driven via bracket access
 * (tests are excluded from tsconfig and run via tsx type-stripping, so
 * runtime bracket access does not affect `yarn typecheck`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

const ownSessionId = 'ses_model_info';
// Unique key so no on-disk `/model` preference exists for it — `restoreSavedModel`
// returns false and `fetchModelInfo` reaches the `/config` branch under test.
const key: ThreadKey = { chatId: -100999111, threadId: 777 };

type ApiRequestStub = (method: string, urlPath: string) => Promise<unknown>;

/** Build a minimal-but-complete live session and inject it into the adapter. */
function createAdapterWithSession(): {
  adapter: OpenCodeAdapter;
  outputs: string[];
  setConfigResponse: (stub: ApiRequestStub) => void;
} {
  const adapter = new OpenCodeAdapter();
  const session = {
    key,
    sessionId: ownSessionId,
    workDir: '/tmp/work',
    isActive: true,
    currentResponseText: '',
    lastEmittedLength: 0,
    outputTimer: null,
    isModelInfoShown: false,
    modelOverride: null,
    currentModelLabel: null,
    partTypes: new Map(),
    statusDebounceTimer: null,
    pendingStatus: null,
    pendingQuestion: null,
    effortLevel: null,
    isBusy: false,
    isCompacting: false,
    busyChildSessionIds: new Set(),
    sseController: null,
    reconnectTimer: null,
    sseStallTimer: null,
  };
  // Private members; runtime-only bracket access (see file header).
  adapter['sessions'].set(keyToString(key), session);

  const setConfigResponse = (stub: ApiRequestStub): void => {
    adapter['apiRequest'] = stub;
  };

  const outputs: string[] = [];
  adapter.on('output', (_key: ThreadKey, text: string) => {
    outputs.push(text);
  });
  return { adapter, outputs, setConfigResponse };
}

/** Feed a `message.updated` assistant event through the real SSE dispatcher,
 * shaped as a `/global/event` envelope (event wrapped in `payload`, tagged with
 * a top-level `directory`). */
function feedAssistantMessage(adapter: OpenCodeAdapter, providerID: string, modelID: string): void {
  adapter['routeSseData'](
    JSON.stringify({
      directory: '/tmp/work',
      project: 'proj',
      payload: {
        type: 'message.updated',
        properties: {
          info: { sessionID: ownSessionId, role: 'assistant', providerID, modelID },
        },
      },
    }),
  );
}

describe('OpenCode fetchModelInfo (B9)', () => {
  it('GET /config THROWS → no "Model: not set" emit, isModelInfoShown stays false', async () => {
    const { adapter, outputs, setConfigResponse } = createAdapterWithSession();
    setConfigResponse(async () => {
      throw new Error('connection refused (server booting / stale credentials)');
    });

    await adapter['fetchModelInfo'](key);

    assert.deepEqual(outputs, [], 'transient /config failure must not claim "not set"');
    const session = adapter['sessions'].get(keyToString(key));
    assert.equal(session.isModelInfoShown, false, 'flag must stay false so a later message corrects it');
    assert.equal(session.currentModelLabel, null, 'currentModelLabel must not be pinned to "not set"');
  });

  it('GET /config SUCCEEDS with empty body → "Model: not set" emitted (true not-set, pinned behavior)', async () => {
    const { adapter, outputs, setConfigResponse } = createAdapterWithSession();
    setConfigResponse(async () => ({}));

    await adapter['fetchModelInfo'](key);

    assert.deepEqual(outputs, ['Model: not set (use /model to select)']);
    const session = adapter['sessions'].get(keyToString(key));
    assert.equal(session.currentModelLabel, 'not set');
  });

  it('GET /config THROWS, then an assistant message arrives → correct "Model: <label>" emitted once', async () => {
    const { adapter, outputs, setConfigResponse } = createAdapterWithSession();
    setConfigResponse(async () => {
      throw new Error('server still booting');
    });

    // First resolution fails transiently — nothing emitted, flag left false.
    await adapter['fetchModelInfo'](key);
    assert.deepEqual(outputs, []);
    assert.equal(adapter['sessions'].get(keyToString(key)).isModelInfoShown, false);

    // The prompt path (handleMessageUpdate) corrects it on the first assistant
    // message: emits the real label exactly once and sets the flag.
    feedAssistantMessage(adapter, 'anthropic', 'claude-opus-4-8');

    assert.deepEqual(outputs, ['Model: anthropic/claude-opus-4-8']);
    const session = adapter['sessions'].get(keyToString(key));
    assert.equal(session.isModelInfoShown, true);
    assert.equal(session.currentModelLabel, 'anthropic/claude-opus-4-8');

    // A second assistant message must NOT re-emit the model line.
    feedAssistantMessage(adapter, 'anthropic', 'claude-opus-4-8');
    assert.equal(
      outputs.filter((chunk) => chunk.startsWith('Model:')).length,
      1,
      'model line must be emitted exactly once',
    );
  });
});
