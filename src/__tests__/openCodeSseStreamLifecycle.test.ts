/**
 * @description OpenCode adapter — single `/global/event` SSE stream lifecycle,
 * envelope-directory routing, and per-directory scheduler-MCP registration
 * (plan 2026-06-17).
 *
 * The adapter now owns ONE `/global/event` stream for the whole server instead
 * of one `/event?directory=<workDir>` stream per bound folder. The single
 * stream opens for the FIRST active session ANYWHERE and closes when the LAST
 * one (any folder) leaves; every event arrives wrapped in `payload` and tagged
 * with a top-level `directory`, is parsed once, and is routed by that envelope
 * directory + sessionID to the owning session. Scheduler-MCP is registered per
 * directory on session start (decoupled from the stream).
 *
 * These tests drive the REAL adapter:
 *   - `pollSseStream` is stubbed to a no-op so `ensureGlobalStream` records the
 *     stream in the private `globalStream` field without opening a real socket;
 *   - sessions are injected into the private `sessions` map and lifecycle is
 *     driven via `connectSse` / `disconnectSse` (bracket access — tests are
 *     tsx-stripped, runtime-only, no effect on `yarn typecheck`);
 *   - routing is verified by feeding ONE payload-wrapped envelope through
 *     `routeSseData` and asserting it reaches exactly the owning session.
 */

import { describe, it, afterEach, beforeEach, mock } from 'node:test';
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
  // No real fetch/socket: ensureGlobalStream still records the stream state.
  adapter['pollSseStream'] = (async () => {}) as OpenCodeAdapter['pollSseStream'];
  return adapter;
}

/**
 * Build the `/global/event` envelope shape `routeSseData` consumes: the real
 * event wrapped in `payload` and tagged with a top-level `directory` (and a
 * `project` field the server sends but the bot ignores).
 */
function globalEnvelope(directory: string, type: string, properties: Record<string, unknown>): string {
  return JSON.stringify({ directory, project: 'proj', payload: { type, properties } });
}

describe('single global SSE stream lifecycle', () => {
  it('the FIRST active session ANYWHERE opens THE one stream; further calls are idempotent', () => {
    const adapter = createAdapter();
    const keyOne: ThreadKey = { chatId: -100, threadId: 1 };
    adapter['sessions'].set(keyToString(keyOne), makeSession(keyOne, 'ses_1', sharedDir));

    assert.equal(adapter['globalStream'], null, 'no stream before connect');
    adapter['connectSse'](keyOne);
    assert.notEqual(adapter['globalStream'], null, 'the first session opens the global stream');

    const streamRef = adapter['globalStream'];
    adapter['connectSse'](keyOne); // idempotent
    assert.equal(adapter['globalStream'], streamRef, 'a second connect reuses the same stream');
  });

  it('two threads in DIFFERENT folders SHARE the one stream; it closes only when the LAST leaves', () => {
    const adapter = createAdapter();
    const keyOne: ThreadKey = { chatId: -100, threadId: 1 };
    const keyTwo: ThreadKey = { chatId: -100, threadId: 2 };
    adapter['sessions'].set(keyToString(keyOne), makeSession(keyOne, 'ses_1', sharedDir));
    adapter['sessions'].set(keyToString(keyTwo), makeSession(keyTwo, 'ses_2', otherDir));

    adapter['connectSse'](keyOne);
    adapter['connectSse'](keyTwo);
    const streamRef = adapter['globalStream'];
    assert.notEqual(streamRef, null, 'sessions across folders share a single global stream');

    // First thread leaves — a session in the OTHER folder still keeps it open.
    adapter['disconnectSse'](keyOne);
    assert.equal(adapter['globalStream'], streamRef, 'stream stays while any session anywhere is active');

    // Last thread leaves — the stream tears down.
    adapter['disconnectSse'](keyTwo);
    assert.equal(adapter['globalStream'], null, 'stream closes when the last session anywhere leaves');
    assert.equal(streamRef?.isClosed, true, 'the closed stream is latched');
  });

  it('two threads sharing a folder also keep ONE stream; it closes on the last', () => {
    const adapter = createAdapter();
    const keyOne: ThreadKey = { chatId: -100, threadId: 1 };
    const keyTwo: ThreadKey = { chatId: -100, threadId: 2 };
    adapter['sessions'].set(keyToString(keyOne), makeSession(keyOne, 'ses_1', sharedDir));
    adapter['sessions'].set(keyToString(keyTwo), makeSession(keyTwo, 'ses_2', sharedDir));

    adapter['connectSse'](keyOne);
    adapter['connectSse'](keyTwo);
    const streamRef = adapter['globalStream'];
    assert.notEqual(streamRef, null);

    adapter['disconnectSse'](keyOne);
    assert.equal(adapter['globalStream'], streamRef, 'a sibling in the same folder keeps it open');

    adapter['disconnectSse'](keyTwo);
    assert.equal(adapter['globalStream'], null, 'closes when the last sibling leaves');
  });
});

describe('global-stream routing parses once and delivers to the owner', () => {
  it('an event for session B (envelope tagged with B\'s folder) reaches ONLY B', () => {
    const adapter = createAdapter();
    const keyA: ThreadKey = { chatId: -100, threadId: 1 };
    const keyB: ThreadKey = { chatId: -100, threadId: 2 };
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    adapter['sessions'].set(keyToString(keyB), makeSession(keyB, 'ses_B', otherDir));

    const outputsByThread = new Map<string, string[]>();
    adapter.on('output', (key: ThreadKey, text: string) => {
      const k = keyToString(key);
      const list = outputsByThread.get(k) ?? [];
      list.push(text);
      outputsByThread.set(k, list);
    });

    // One payload-wrapped envelope, fed once — it targets B by sessionID.
    adapter['routeSseData'](
      globalEnvelope(otherDir, 'message.part.delta', {
        sessionID: 'ses_B', messageID: 'msg', partID: 'prt', field: 'text', delta: 'hi B',
      }),
    );
    // Text deltas debounce 500ms before emitting; flush via a session.idle.
    adapter['routeSseData'](
      globalEnvelope(otherDir, 'session.idle', { sessionID: 'ses_B' }),
    );

    assert.deepEqual(outputsByThread.get(keyToString(keyB)), ['hi B'], 'owner B got the output exactly once');
    assert.equal(outputsByThread.has(keyToString(keyA)), false, 'sibling A got nothing');
  });

  it('two topics share a folder: the envelope directory + sessionID still picks ONE owner', () => {
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

    adapter['routeSseData'](
      globalEnvelope(sharedDir, 'message.part.delta', {
        sessionID: 'ses_A', messageID: 'msg', partID: 'prt', field: 'text', delta: 'hi A',
      }),
    );
    adapter['routeSseData'](globalEnvelope(sharedDir, 'session.idle', { sessionID: 'ses_A' }));

    assert.deepEqual(outputsByThread.get(keyToString(keyA)), ['hi A'], 'direct id match routes to A only');
    assert.equal(outputsByThread.has(keyToString(keyB)), false, 'sibling B got nothing');
  });

  it('an event for a directory the bot does NOT own (by-hand opencode elsewhere) is dropped', () => {
    const adapter = createAdapter();
    const keyA: ThreadKey = { chatId: -100, threadId: 1 };
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));

    let emitted = false;
    adapter.on('output', () => { emitted = true; });

    // Unknown session in an unbound folder — no active bound session there.
    adapter['routeSseData'](
      globalEnvelope('/work/byhand', 'session.idle', { sessionID: 'ses_foreign' }),
    );
    assert.equal(emitted, false, 'a foreign-directory event emits nothing');
  });

  it('an event whose session no thread owns is dropped (no emit)', () => {
    const adapter = createAdapter();
    const keyA: ThreadKey = { chatId: -100, threadId: 1 };
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));

    let emitted = false;
    adapter.on('output', () => { emitted = true; });

    // An unknown session id, tagged with a folder that has no active bound
    // session — neither id/lineage nor the directory fallback resolves an owner.
    adapter['routeSseData'](
      globalEnvelope(otherDir, 'session.idle', { sessionID: 'ses_orphan' }),
    );
    assert.equal(emitted, false, 'an unowned event emits nothing');
  });
});

describe('scheduler MCP registration per directory on session start (plan 2026-06-17 S3)', () => {
  const secret = 'a'.repeat(64);
  const port = 4097;

  afterEach(() => {
    resetSchedulerMcpInjection();
  });

  it('inert (injection unconfigured): connecting a session POSTs nothing', async () => {
    const adapter = createAdapter();
    const keyA: ThreadKey = { chatId: -100, threadId: 1 };
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    const calls: { method: string; url: string }[] = [];
    adapter['apiRequest'] = (async (method: string, url: string) => {
      calls.push({ method, url });
    }) as OpenCodeAdapter['apiRequest'];

    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0, 'no registration POST when injection is inert');
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), false);
  });

  it('configured: connecting a session POSTs the dir-scoped registration once per dir', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const adapter = createAdapter();
    const keyA: ThreadKey = { chatId: -100, threadId: 1 };
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    const calls: { method: string; url: string; body: unknown }[] = [];
    adapter['apiRequest'] = (async (method: string, url: string, body: unknown) => {
      calls.push({ method, url, body });
    }) as OpenCodeAdapter['apiRequest'];

    adapter['connectSse'](keyA);
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

    // Latched: a second connect for a session in the SAME dir does not re-POST.
    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, 'idempotent — the dir Set prevents a re-POST');
  });

  it('registers reattached sessions after scheduler injection becomes available', async () => {
    const adapter = createAdapter();
    const keyA: ThreadKey = { chatId: -100, threadId: 1 };
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    const calls: string[] = [];
    adapter['apiRequest'] = (async (_method: string, url: string) => {
      calls.push(url);
    }) as OpenCodeAdapter['apiRequest'];

    // A bot restart restores sessions before its scheduler listener is started.
    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0, 'inert injection cannot register during reattach');

    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    adapter.registerSchedulerMcpForActiveSessions();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [`/mcp?directory=${encodeURIComponent(sharedDir)}`]);
  });

  it('clearing the dir Set (what restartServer does) makes the next connect re-register (S4)', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const adapter = createAdapter();
    const keyA: ThreadKey = { chatId: -100, threadId: 1 };
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    const calls: string[] = [];
    adapter['apiRequest'] = (async (_method: string, url: string) => {
      calls.push(url);
    }) as OpenCodeAdapter['apiRequest'];

    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, 'registered once on first connect');

    // restartServer wipes the server's MCP table, so it clears the gate; the
    // resume path then re-runs connectSse for each still-active session.
    adapter['registeredSchedulerMcpDirs'].clear();
    adapter['connectSse'](keyA);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2, 're-registered after the Set was cleared on restart');
    assert.equal(adapter['registeredSchedulerMcpDirs'].has(sharedDir), true, 'dir re-latched');
  });

  it('registration failure is swallowed (the dir is not latched, so a later connect retries)', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const adapter = createAdapter();
    const keyA: ThreadKey = { chatId: -100, threadId: 1 };
    adapter['sessions'].set(keyToString(keyA), makeSession(keyA, 'ses_A', sharedDir));
    adapter['apiRequest'] = (async () => {
      throw new Error('opencode 404 / server sick');
    }) as OpenCodeAdapter['apiRequest'];

    // Must not throw out of the sync connect path, and the stream stays open.
    assert.doesNotThrow(() => adapter['connectSse'](keyA));
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(adapter['globalStream'], null, 'stream survives a failed registration');
    assert.equal(
      adapter['registeredSchedulerMcpDirs'].has(sharedDir),
      false,
      'a failed registration leaves the dir unlatched so a later connect retries',
    );
  });
});

describe('the stall watchdog aborts its own stream', () => {
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
      directory: '<global>',
      controller,
      stallTimer: null,
      reconnectTimer: null,
      isClosed: false,
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
      directory: '<global>',
      controller,
      stallTimer: null,
      reconnectTimer: null,
      isClosed: false,
    };

    adapter['armSseStallWatchdog'](stream, controller);
    adapter['clearStreamStallTimer'](stream);
    mock.timers.tick(40_000 + 1);
    assert.equal(controller.signal.aborted, false, 'a cleared watchdog does not abort');
  });
});
