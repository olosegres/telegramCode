/**
 * @description OpenCode adapter — per-directory SSE stream lifecycle and shared
 * routing (plan 2026-06-05 S5).
 *
 * The adapter now owns ONE `/event?directory=<workDir>` stream per unique bound
 * directory instead of one `/global/event` stream per thread. Threads sharing a
 * folder share one stream: it opens for the FIRST active session in a directory
 * and closes when the LAST one leaves; each event is parsed once and routed to
 * the owning session.
 *
 * These tests drive the REAL adapter:
 *   - `pollSseStream` is stubbed to a no-op so `ensureDirectoryStream` records
 *     the stream in the private `sseStreams` map without opening a real socket;
 *   - sessions are injected into the private `sessions` map and lifecycle is
 *     driven via `connectSse` / `disconnectSse` (bracket access — tests are
 *     tsx-stripped, runtime-only, no effect on `yarn typecheck`);
 *   - shared-directory routing is verified by feeding ONE event through
 *     `routeSseData` and asserting it reaches exactly the owning session.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';
import {
  configureSchedulerMcpInjection,
  resetSchedulerMcpInjection,
  schedulerMcpServerName,
} from '../scheduler/injection';
import { verifySchedulerMcpToken } from '../scheduler/mcpSurface';

const sharedDir = '/work/shared';
const otherDir = '/work/other';

function makeSession(key: ThreadKey, sessionId: string, workDir: string) {
  return {
    key,
    sessionId,
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
    isBusy: false,
    isCompacting: false,
    busyChildSessionIds: new Set(),
    isAutoNamePending: false,
  };
}

/** Adapter with the real socket reader stubbed out. */
function createAdapter(): OpenCodeAdapter {
  const adapter = new OpenCodeAdapter();
  // No real fetch/socket: ensureDirectoryStream still records the stream state.
  adapter['pollSseStream'] = (async () => {}) as OpenCodeAdapter['pollSseStream'];
  return adapter;
}

describe('per-directory SSE stream lifecycle', () => {
  it('the FIRST active session for a directory opens its stream; further calls are idempotent', () => {
    const adapter = createAdapter();
    const keyOne: ThreadKey = { chatId: -100, threadId: 1 };
    adapter['sessions'].set(keyToString(keyOne), makeSession(keyOne, 'ses_1', sharedDir));

    assert.equal(adapter['sseStreams'].has(sharedDir), false, 'no stream before connect');
    adapter['connectSse'](keyOne);
    assert.equal(adapter['sseStreams'].has(sharedDir), true, 'first session opens the stream');

    const streamRef = adapter['sseStreams'].get(sharedDir);
    adapter['connectSse'](keyOne); // idempotent
    assert.equal(adapter['sseStreams'].get(sharedDir), streamRef, 'a second connect reuses the same stream');
  });

  it('two threads sharing a directory keep ONE stream; it closes only when the LAST leaves', () => {
    const adapter = createAdapter();
    const keyOne: ThreadKey = { chatId: -100, threadId: 1 };
    const keyTwo: ThreadKey = { chatId: -100, threadId: 2 };
    adapter['sessions'].set(keyToString(keyOne), makeSession(keyOne, 'ses_1', sharedDir));
    adapter['sessions'].set(keyToString(keyTwo), makeSession(keyTwo, 'ses_2', sharedDir));

    adapter['connectSse'](keyOne);
    adapter['connectSse'](keyTwo);
    assert.equal(adapter['sseStreams'].size, 1, 'two threads in one folder share a single stream');
    const streamRef = adapter['sseStreams'].get(sharedDir);

    // First thread leaves — a sibling still keeps the stream open.
    adapter['disconnectSse'](keyOne);
    assert.equal(adapter['sseStreams'].has(sharedDir), true, 'stream stays while a sibling is active');
    assert.equal(adapter['sseStreams'].get(sharedDir), streamRef, 'the same stream object is kept');

    // Last thread leaves — the stream tears down.
    adapter['disconnectSse'](keyTwo);
    assert.equal(adapter['sseStreams'].has(sharedDir), false, 'stream closes when the last session leaves');
    assert.equal(streamRef?.isClosed, true, 'the closed stream is latched');
  });

  it('distinct directories get distinct streams', () => {
    const adapter = createAdapter();
    const keyOne: ThreadKey = { chatId: -100, threadId: 1 };
    const keyTwo: ThreadKey = { chatId: -100, threadId: 2 };
    adapter['sessions'].set(keyToString(keyOne), makeSession(keyOne, 'ses_1', sharedDir));
    adapter['sessions'].set(keyToString(keyTwo), makeSession(keyTwo, 'ses_2', otherDir));

    adapter['connectSse'](keyOne);
    adapter['connectSse'](keyTwo);
    assert.deepEqual([...adapter['sseStreams'].keys()].sort(), [sharedDir, otherDir].sort());
  });
});

describe('shared-directory routing parses once and delivers to the owner', () => {
  it('an event for session B (same folder as A) reaches ONLY B', () => {
    const adapter = createAdapter();
    const keyA: ThreadKey = { chatId: -100, threadId: 1 };
    const keyB: ThreadKey = { chatId: -100, threadId: 2 };
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    adapter['sessions'].set(keyToString(keyB), makeSession(keyB, 'ses_B', sharedDir));

    const outputsByThread = new Map<string, string[]>();
    adapter.on('output', (key: ThreadKey, text: string) => {
      const k = keyToString(key);
      const list = outputsByThread.get(k) ?? [];
      list.push(text);
      outputsByThread.set(k, list);
    });

    // One event, fed once into the shared directory's stream — it targets B.
    adapter['routeSseData'](
      sharedDir,
      JSON.stringify({
        type: 'message.part.delta',
        properties: { sessionID: 'ses_B', messageID: 'msg', partID: 'prt', field: 'text', delta: 'hi B' },
      }),
    );
    // Text deltas debounce 500ms before emitting; flush via a session.idle.
    adapter['routeSseData'](
      sharedDir,
      JSON.stringify({ type: 'session.idle', properties: { sessionID: 'ses_B' } }),
    );

    assert.deepEqual(outputsByThread.get(keyToString(keyB)), ['hi B'], 'owner B got the output exactly once');
    assert.equal(outputsByThread.has(keyToString(keyA)), false, 'sibling A got nothing');
  });

  it('an event whose session no thread owns is dropped (no emit)', () => {
    const adapter = createAdapter();
    const keyA: ThreadKey = { chatId: -100, threadId: 1 };
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));

    let emitted = false;
    adapter.on('output', () => { emitted = true; });

    adapter['routeSseData'](
      sharedDir,
      JSON.stringify({ type: 'session.idle', properties: { sessionID: 'ses_orphan' } }),
    );
    assert.equal(emitted, false, 'an unowned event emits nothing');
  });
});

describe('scheduler MCP registration on directory stream open (plan S6)', () => {
  const secret = 'a'.repeat(64);
  const port = 4097;

  afterEach(() => {
    resetSchedulerMcpInjection();
  });

  it('inert (injection unconfigured): opening a stream POSTs nothing', () => {
    const adapter = createAdapter();
    const calls: { method: string; url: string }[] = [];
    adapter['apiRequest'] = (async (method: string, url: string) => {
      calls.push({ method, url });
    }) as OpenCodeAdapter['apiRequest'];

    adapter['ensureDirectoryStream'](sharedDir);
    assert.equal(calls.length, 0, 'no registration POST when injection is inert');
    assert.equal(adapter['sseStreams'].get(sharedDir)?.isSchedulerMcpRegistered, false);
  });

  it('configured: opening a stream POSTs the dir-scoped registration once', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const adapter = createAdapter();
    const calls: { method: string; url: string; body: unknown }[] = [];
    adapter['apiRequest'] = (async (method: string, url: string, body: unknown) => {
      calls.push({ method, url, body });
    }) as OpenCodeAdapter['apiRequest'];

    adapter['ensureDirectoryStream'](sharedDir);
    // Registration is fire-and-forget (async); let the microtask settle.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 1, 'exactly one registration POST');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `/mcp?directory=${encodeURIComponent(sharedDir)}`);

    const body = calls[0].body as {
      name: string;
      config: { type: string; url: string; enabled: boolean; headers: { Authorization: string } };
    };
    assert.equal(body.name, schedulerMcpServerName);
    assert.equal(body.config.type, 'remote');
    assert.equal(body.config.enabled, true);
    assert.equal(body.config.url, `http://127.0.0.1:${port}/mcp`);
    // The token verifies to the EXACT directory scope.
    const token = body.config.headers.Authorization.slice('Bearer '.length);
    assert.deepEqual(verifySchedulerMcpToken(secret, token), { kind: 'dir', directory: sharedDir });

    // Latched: a second ensure for the SAME stream does not re-POST.
    adapter['registerSchedulerMcpForDirectory'](adapter['sseStreams'].get(sharedDir)!);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, 'idempotent — registered flag prevents a re-POST');
  });

  it('registration failure is swallowed (the stream/session is never torn down)', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const adapter = createAdapter();
    adapter['apiRequest'] = (async () => {
      throw new Error('opencode 404 / server sick');
    }) as OpenCodeAdapter['apiRequest'];

    // Must not throw out of the sync ensure path, and the stream stays open.
    assert.doesNotThrow(() => adapter['ensureDirectoryStream'](sharedDir));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adapter['sseStreams'].has(sharedDir), true, 'stream survives a failed registration');
    assert.equal(
      adapter['sseStreams'].get(sharedDir)?.isSchedulerMcpRegistered,
      false,
      'a failed registration leaves the flag unset so a later open retries',
    );
  });
});

describe('per-stream stall watchdog aborts only its own stream', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('arming the watchdog and letting it fire aborts the stream controller', () => {
    const adapter = createAdapter();
    const controller = new AbortController();
    const stream = {
      directory: sharedDir,
      controller,
      stallTimer: null,
      reconnectTimer: null,
      isClosed: false,
      isSchedulerMcpRegistered: true,
    };

    adapter['armSseStallWatchdog'](stream, controller);
    assert.equal(controller.signal.aborted, false, 'not aborted before the timeout');

    // sseStallTimeoutMs = 4 × 10s heartbeat = 40s; advance past it.
    mock.timers.tick(40_000 + 1);
    assert.equal(controller.signal.aborted, true, 'the stall watchdog aborts its own controller');
    assert.equal(stream.stallTimer, null, 'the fired timer handle is cleared');
  });

  it('clearStreamStallTimer disarms an armed watchdog so it never fires', () => {
    const adapter = createAdapter();
    const controller = new AbortController();
    const stream = {
      directory: sharedDir,
      controller,
      stallTimer: null,
      reconnectTimer: null,
      isClosed: false,
      isSchedulerMcpRegistered: true,
    };

    adapter['armSseStallWatchdog'](stream, controller);
    adapter['clearStreamStallTimer'](stream);
    mock.timers.tick(40_000 + 1);
    assert.equal(controller.signal.aborted, false, 'a cleared watchdog does not abort');
  });
});
