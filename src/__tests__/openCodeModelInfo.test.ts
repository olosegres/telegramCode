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
 * The same harness covers `getRuntimeInfo` (the `/status` metadata read): it
 * must report the model the runtime ACTUALLY ran (not a just-picked one), fill a
 * cold provider cache itself so the context limit is not blanked for a whole TTL
 * window after a server restart, reuse a warm cache instead of re-fetching, and
 * degrade to an unknown limit rather than throwing when the lookup fails. It
 * must also not make `/status` wait for work it cannot use: no provider lookup
 * at all without an observed model to size, and the two independent HTTP reads
 * issued concurrently rather than one after the other.
 *
 * Harness mirrors openCodeOutputDedup.test.ts: a session is injected into
 * the adapter, `apiRequest` is stubbed, `output` events captured, and the
 * private `fetchModelInfo` / SSE dispatcher driven via bracket access
 * (tests are excluded from tsconfig and run via tsx type-stripping, so
 * runtime bracket access does not affect `yarn typecheck`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter, resetOpenCodeProviderCaches } from '../adapters/openCodeAdapter';
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
  // The provider config cache is module-level, so a case that fills it would
  // otherwise decide what the NEXT case observes (cold vs warm).
  resetOpenCodeProviderCaches();
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
    latestParentRuntimeContext: null,
    parentAssistantObservationVersion: 0,
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

async function getRuntimeInfoWithHealthyServer(adapter: OpenCodeAdapter): Promise<ReturnType<OpenCodeAdapter['getRuntimeInfo']>> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/global/health')) {
      return new Response(JSON.stringify({ version: '1.17.11' }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  try {
    return await adapter.getRuntimeInfo(key);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

  it('retains only the latest non-aborted parent assistant runtime context', () => {
    const { adapter } = createAdapterWithSession();
    const session = adapter['sessions'].get(keyToString(key));
    session.modelOverride = { providerID: 'anthropic', modelID: 'claude-opus-4-8' };

    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_current',
        sessionID: ownSessionId,
        role: 'assistant',
        providerID: 'anthropic',
        modelID: 'claude-opus-4-8',
        tokens: { input: 120, cache: { read: 30, write: 5 } },
      },
    });
    assert.deepEqual(session.latestParentRuntimeContext, {
      messageId: 'msg_current',
      model: { providerID: 'anthropic', modelID: 'claude-opus-4-8' },
      contextUsedTokens: 155,
    });

    session.isAwaitingModelAfterProviderRetryAbort = true;
    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_aborted_retry',
        sessionID: ownSessionId,
        role: 'assistant',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-6',
        tokens: { input: 9_999, cache: { read: 1, write: 1 } },
        error: 'Aborted',
      },
    });
    assert.deepEqual(session.latestParentRuntimeContext, {
      messageId: 'msg_current',
      model: { providerID: 'anthropic', modelID: 'claude-opus-4-8' },
      contextUsedTokens: 155,
    });
  });

  it('includes generated output once when reasoning is reported separately', () => {
    const { adapter } = createAdapterWithSession();
    const session = adapter['sessions'].get(keyToString(key));

    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_with_output',
        sessionID: ownSessionId,
        role: 'assistant',
        providerID: 'anthropic',
        modelID: 'claude-opus-4-8',
        tokens: { input: 120, output: 80, reasoning: 60, cache: { read: 30, write: 5 } },
      },
    });

    assert.deepEqual(session.latestParentRuntimeContext, {
      messageId: 'msg_with_output',
      model: { providerID: 'anthropic', modelID: 'claude-opus-4-8' },
      contextUsedTokens: 235,
    });
  });

  it('does not replace measured runtime context with a pending zero-token assistant placeholder', () => {
    const { adapter } = createAdapterWithSession();
    const session = adapter['sessions'].get(keyToString(key));

    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_measured',
        sessionID: ownSessionId,
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-test',
        finish: 'tool-calls',
        tokens: { input: 1_087, output: 17, cache: { read: 181_760, write: 0 } },
      },
    });
    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_pending',
        sessionID: ownSessionId,
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-test',
        finish: null,
        tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      },
    });

    assert.deepEqual(session.latestParentRuntimeContext, {
      messageId: 'msg_measured',
      model: { providerID: 'openai', modelID: 'gpt-test' },
      contextUsedTokens: 182_864,
    });
  });

  it('fetches the provider config so a cold cache still reports the context limit', async () => {
    const { adapter, setConfigResponse } = createAdapterWithSession();
    let providerRequests = 0;
    setConfigResponse(async (_method, urlPath) => {
      if (urlPath !== '/config/providers') throw new Error(`unexpected api request: ${urlPath}`);
      providerRequests += 1;
      return { providers: [{ id: 'anthropic', models: { 'claude-sonnet-4-5': { limit: { context: 200_000 } } } }] };
    });
    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_observed',
        sessionID: ownSessionId,
        role: 'assistant',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
        tokens: { input: 120, cache: { read: 30, write: 5 } },
      },
    });

    assert.deepEqual(await getRuntimeInfoWithHealthyServer(adapter), {
      version: '1.17.11',
      model: 'anthropic/claude-sonnet-4-5',
      // A cache-only peek reported this as unknown for the whole TTL window
      // after a server restart, even though the lookup is already doing HTTP.
      contextWindowTokens: 200_000,
      contextUsedTokens: 155,
    });
    assert.equal(providerRequests, 1, 'a cold cache must be filled by the runtime lookup itself');
  });

  it('skips the provider lookup entirely when no model has been observed', async () => {
    // With no observed model there is no limit to look up, so the fetched
    // config would only be discarded — `/status` must not pay for that HTTP
    // round trip on a session that has not run a turn yet.
    const { adapter, setConfigResponse } = createAdapterWithSession();
    let providerRequests = 0;
    setConfigResponse(async () => {
      providerRequests += 1;
      return { providers: [] };
    });

    assert.deepEqual(await getRuntimeInfoWithHealthyServer(adapter), {
      version: '1.17.11',
      model: null,
      contextWindowTokens: null,
      contextUsedTokens: null,
    });
    assert.equal(providerRequests, 0, 'a runtime read with no model must not fetch the provider config');
  });

  it('runs the health and provider reads concurrently, not one after the other', async () => {
    // Both reads are independent HTTP calls; awaiting them in sequence made
    // `/status` wait for their SUM. The discriminator: with a sequential await
    // the provider request cannot have started before the health response is
    // delivered, with a concurrent one it always has.
    const { adapter, setConfigResponse } = createAdapterWithSession();
    let providerRequests = 0;
    let isProviderStartedBeforeHealthResolved = false;
    setConfigResponse(async () => {
      providerRequests += 1;
      return { providers: [{ id: 'anthropic', models: { 'claude-sonnet-4-5': { limit: { context: 200_000 } } } }] };
    });
    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_observed',
        sessionID: ownSessionId,
        role: 'assistant',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
        tokens: { input: 120, cache: { read: 30, write: 5 } },
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.endsWith('/global/health')) throw new Error(`unexpected fetch in test: ${url}`);
      // Yield once so a concurrently-started provider request can be observed.
      await new Promise((resolve) => setImmediate(resolve));
      isProviderStartedBeforeHealthResolved = providerRequests > 0;
      return new Response(JSON.stringify({ version: '1.17.11' }), { status: 200 });
    }) as typeof fetch;
    try {
      await adapter.getRuntimeInfo(key);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(isProviderStartedBeforeHealthResolved, true, 'the provider read must not wait for the health read');
  });

  it('degrades to an unknown context limit when the provider lookup fails', async () => {
    const { adapter, setConfigResponse } = createAdapterWithSession();
    setConfigResponse(async () => {
      throw new Error('connection refused (server booting / stale credentials)');
    });
    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_observed',
        sessionID: ownSessionId,
        role: 'assistant',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
        tokens: { input: 120, cache: { read: 30, write: 5 } },
      },
    });

    // `/status` must still render: an unreachable provider config costs the
    // limit row, never the whole report.
    assert.deepEqual(await getRuntimeInfoWithHealthyServer(adapter), {
      version: '1.17.11',
      model: 'anthropic/claude-sonnet-4-5',
      contextWindowTokens: null,
      contextUsedTokens: 155,
    });
  });

  it('keeps selected-but-unobserved models out of runtime context until an assistant turn confirms them', async () => {
    const { adapter, setConfigResponse } = createAdapterWithSession();
    let providerRequests = 0;
    setConfigResponse(async (_method, urlPath) => {
      if (urlPath !== '/config/providers') throw new Error(`unexpected api request: ${urlPath}`);
      providerRequests += 1;
      return {
        providers: [{
          id: 'anthropic',
          models: {
            'claude-sonnet-4-5': { limit: { context: 200_000 } },
            'claude-opus-4-8': { limit: { context: 1_000_000 } },
          },
        }],
      };
    });
    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_previous',
        sessionID: ownSessionId,
        role: 'assistant',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
        tokens: { input: 100, cache: { read: 20, write: 5 } },
      },
    });
    await adapter['getProvidersConfig']();

    const session = adapter['sessions'].get(keyToString(key));
    session.modelOverride = { providerID: 'anthropic', modelID: 'claude-opus-4-8' };
    session.currentModelLabel = 'anthropic/claude-opus-4-8';

    assert.deepEqual(await getRuntimeInfoWithHealthyServer(adapter), {
      version: '1.17.11',
      // The just-selected opus is NOT yet what the runtime ran — the reported
      // model must stay the observed one until a turn confirms the switch.
      model: 'anthropic/claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      contextUsedTokens: 125,
    });
    assert.equal(providerRequests, 1, 'runtime lookup must reuse the warmed provider cache');

    adapter['handleMessageUpdate'](key, {
      info: {
        id: 'msg_selected_model',
        sessionID: ownSessionId,
        role: 'assistant',
        providerID: 'anthropic',
        modelID: 'claude-opus-4-8',
        tokens: { input: 400, cache: { read: 50, write: 10 } },
      },
    });

    assert.deepEqual(await getRuntimeInfoWithHealthyServer(adapter), {
      version: '1.17.11',
      model: 'anthropic/claude-opus-4-8',
      contextWindowTokens: 1_000_000,
      contextUsedTokens: 460,
    });
    assert.equal(providerRequests, 1);
  });
});
