/**
 * @description B18 — `/opencode` must reply "ready" the moment the session
 * exists, NOT after model resolution.
 *
 * Bug: `startSession` awaited `fetchModelInfo` (→ `GET /config`) BEFORE
 * `emit('started')`, which is what triggers the "OpenCode готов" reply. On a
 * server saturated by another topic's heavy work, `GET /config` stalled for
 * tens of seconds (capped by the 30 s request timeout), so the topic showed no
 * ready reply for minutes (live trace 15:02: POST /session succeeded, no ready
 * emit followed).
 *
 * Fix: emit `started` right after the session exists and SSE is wired, then
 * resolve the model afterwards. A hanging `GET /config` can no longer gate the
 * ready reply.
 *
 * Harness mirrors openCodeModelInfo.test.ts: real adapter, `apiRequest`
 * stubbed, `connectSse` stubbed to a no-op (no real SSE socket), module-level
 * install/server checks pass naturally in this env (opencode installed, server
 * up). Private members reached via runtime bracket access (tests are excluded
 * from tsconfig and run via tsx type-stripping, so this does not affect
 * `yarn typecheck`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

const newSessionId = 'ses_start_ready';

/**
 * @description Build an adapter whose lifecycle dependencies are stubbed: POST
 * /session resolves immediately; GET /config behaviour is caller-controlled;
 * connectSse is a no-op (no real socket).
 */
function createStubbedAdapter(configHandler: () => Promise<unknown>): {
  adapter: OpenCodeAdapter;
  startedKeys: ThreadKey[];
} {
  const adapter = new OpenCodeAdapter();

  adapter['apiRequest'] = async (method: string, urlPath: string) => {
    if (method === 'POST' && urlPath === '/session') {
      return { id: newSessionId };
    }
    if (method === 'GET' && urlPath === '/config') {
      return configHandler();
    }
    return undefined;
  };
  // No real SSE socket in the test.
  adapter['connectSse'] = () => {};

  const startedKeys: ThreadKey[] = [];
  adapter.on('started', (startedKey: ThreadKey) => {
    startedKeys.push(startedKey);
  });

  return { adapter, startedKeys };
}

/** Wait until `predicate()` is true or a bounded number of macrotask turns
 * elapse — long enough for the start path's real awaits (server health check,
 * stubbed POST /session) to drain, short enough to fail fast. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('OpenCode startSession ready reply (B18)', () => {
  it('emits "started" even when GET /config never resolves (hanging server)', async () => {
    // GET /config returns a promise that never settles. The old code awaited it
    // BEFORE emit('started'), so the ready reply never fired. With the fix
    // `started` precedes that await — we must NOT await startSession to
    // completion (it stays pending on /config by design), just confirm the
    // ready signal arrived.
    const { adapter, startedKeys } = createStubbedAdapter(() => new Promise<unknown>(() => {}));
    const hangKey: ThreadKey = { chatId: -100999222, threadId: 1 };

    void adapter.startSession(hangKey, '/tmp/work');
    await waitFor(() => startedKeys.length > 0);

    assert.equal(startedKeys.length, 1, 'ready (started) must fire despite the hanging /config');
  });

  it('emits "started" before fetchModelInfo resolves (readiness precedes model)', async () => {
    const events: string[] = [];
    let resolveConfig: (value: unknown) => void = () => {};
    const configReady = new Promise<unknown>((resolve) => {
      resolveConfig = resolve;
    });

    const { adapter } = createStubbedAdapter(() => configReady);
    const orderKey: ThreadKey = { chatId: -100999222, threadId: 2 };
    adapter.on('started', () => events.push('started'));
    adapter.on('output', (_key: ThreadKey, text: string) => {
      if (text.startsWith('Model:')) events.push('model');
    });

    const startPromise = adapter.startSession(orderKey, '/tmp/work');

    // `started` fires before the awaited fetchModelInfo, while /config is still
    // pending — so the model line has NOT been emitted yet.
    await waitFor(() => events.includes('started'));
    assert.deepEqual(events, ['started'], 'started must be emitted before the model is resolved');

    // Now let /config resolve — the model line follows.
    resolveConfig({ defaultModel: { providerID: 'anthropic', modelID: 'claude-opus-4-8' } });
    await startPromise;

    assert.deepEqual(events, ['started', 'model'], 'model line arrives after readiness');
  });
});

describe('OpenCode single-owner prevention (B20 root cause)', () => {
  it('detaches a thread already bound to the same server session when another adopts it', async () => {
    // Thread A is already live on session ses_start_ready. Thread B starts and
    // POST /session hands back the SAME id (the corruption that delivered one
    // answer to two topics). A must be detached so only one thread owns it.
    const { adapter } = createStubbedAdapter(async () =>
      ({ defaultModel: { providerID: 'anthropic', modelID: 'claude-opus-4-8' } }),
    );
    const threadA: ThreadKey = { chatId: -100999333, threadId: 10 };
    const threadB: ThreadKey = { chatId: -100999333, threadId: 11 };

    // Inject thread A holding the shared id.
    adapter['sessions'].set(keyToString(threadA), {
      key: threadA,
      sessionId: newSessionId,
      workDir: '/tmp/work',
      isActive: true,
      currentResponseText: '',
      lastEmittedLength: 0,
      outputTimer: null,
      isModelInfoShown: true,
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
    });

    const stoppedKeys: ThreadKey[] = [];
    adapter.on('stopped', (k: ThreadKey) => stoppedKeys.push(k));

    await adapter.startSession(threadB, '/tmp/work');

    // A is detached (stopped emitted, removed); B owns the session.
    assert.ok(
      stoppedKeys.some((k) => k.threadId === 10),
      'the stale duplicate owner (thread A) must be detached',
    );
    assert.equal(adapter['sessions'].has(keyToString(threadA)), false, 'thread A removed from the session map');
    assert.equal(adapter['sessions'].get(keyToString(threadB)).sessionId, newSessionId, 'thread B owns the session');
  });
});
