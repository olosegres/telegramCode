/**
 * @description Coverage for `scheduler/mcpSurface.ts` (S5):
 *
 *   - token helpers: build/verify round-trip, tampered scope/signature rejected,
 *     malformed tokens rejected, timing-safe compare used (read from source).
 *   - buildSpecFromCreateArgs: exactly-one-of (+ recipe hint), one-shot tolerates
 *     a redundant repeatCount (ignored, not an error), empty-string normalization,
 *     bad cron.
 *   - resolveTargetThreadKey: thread scope (match/mismatch), dir scope
 *     (0 / 1 / >1 bound threads, threadKey requirement + validation).
 *   - END-TO-END over real HTTP: start the server on port 0, connect with the
 *     SDK Client + StreamableHTTPClientTransport using a valid thread-scope
 *     token → create (cron + once + N-times) → list → cancel → list empty;
 *     invalid token rejected; dir-scope with 2 bound threads requires threadKey;
 *     thread-scope create with a mismatching threadKey arg errors; the real
 *     file-send service routes single MP4, mixed photo/video album, and
 *     `as_file` MP4 calls through the exact typed Telegram gateway methods.
 *
 * The end-to-end test uses a REAL StateStore (state.test.ts fake-HOME idiom) and
 * fake armJob/disarmJob + Telegram gateway capturing calls, so the assertions
 * are load-bearing: a broken token verify, scope resolution, tool handler, or
 * MP4/media-group routing fails the round-trip.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StateStore } from '../state';
import { keyToString } from '../types';
import {
  buildSchedulerMcpToken,
  verifySchedulerMcpToken,
  buildSpecFromCreateArgs,
  resolveTargetThreadKey,
  createSchedulerMcpServer,
  serializeSchedulerScope,
  parseSchedulerScope,
  getSchedulerMcpPort,
  resolveSchedulerMcpPort,
  defaultSchedulerMcpPort,
  createSchedulerMcpCancellationLifecycle,
  schedulerMcpClientIdHeader,
  schedulerMcpPendingCancellationMax,
  schedulerMcpPendingCancellationTtlMs,
  type SchedulerScope,
  type SchedulerMcpHandle,
  type SchedulerMcpDeps,
} from '../scheduler/mcpSurface';
import { createServer, request, type ClientRequest } from 'node:http';
import type { ScheduleRecord } from '../scheduler/types';
import {
  createSendFilesToThread,
  type SendFilesToThread,
  type SendFilesToThreadOptions,
} from '../utils/fileSendService';
import type { SendMessagesToThread } from '../utils/messageSendService';
import {
  createFileSendTestRecorderGateway,
  type RecordedFileSendGatewayCall,
} from './fileSendTestRecorder';

const secret = 'a'.repeat(64);
const threadAKey = keyToString({ chatId: -1001234567890, threadId: 11 });
const threadBKey = keyToString({ chatId: -1001234567890, threadId: 22 });
const nowMs = new Date(2026, 5, 6, 10, 0, 0).getTime();
const schedulerMcpStopTimeoutMs = 1_000;
const incompleteRequestBody = '{"jsonrpc":"2.0"';
const linuxIt = process.platform === 'linux' ? it : it.skip;

interface IncompleteHttpRequest {
  request: ClientRequest;
  connected: Promise<void>;
}

function checkPromiseResolvesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function createIncompleteHttpRequest(port: number, token: string): IncompleteHttpRequest {
  const activeRequest = request({
    host: '127.0.0.1',
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': (incompleteRequestBody.length + 1).toString(),
    },
  });
  // Destroying the request during test cleanup reports ECONNRESET asynchronously.
  activeRequest.on('error', () => {});
  const connected = new Promise<void>((resolve) => {
    activeRequest.once('socket', (socket) => {
      if (socket.connecting) socket.once('connect', resolve);
      else resolve();
    });
  });
  activeRequest.write(incompleteRequestBody);
  return { request: activeRequest, connected };
}

// ─── port resolution + reuse ─────────────────────────────────────────

describe('resolveSchedulerMcpPort', () => {
  it('an explicit env port wins over a persisted one', () => {
    assert.equal(resolveSchedulerMcpPort(4107, 5555), 4107);
  });
  it('reuses the persisted port when no env override is set', () => {
    assert.equal(resolveSchedulerMcpPort(defaultSchedulerMcpPort, 5555), 5555);
  });
  it('falls back to ephemeral (0) when neither env nor a persisted port exist', () => {
    assert.equal(resolveSchedulerMcpPort(defaultSchedulerMcpPort, undefined), defaultSchedulerMcpPort);
  });
  it('ignores a non-positive persisted port', () => {
    assert.equal(resolveSchedulerMcpPort(defaultSchedulerMcpPort, 0), defaultSchedulerMcpPort);
  });
});

describe('createSchedulerMcpServer port binding', () => {
  it('falls back to an ephemeral port when the requested port is already in use', async () => {
    // Occupy a port with a throwaway server, then ask the scheduler server for
    // that same port: it must NOT reject boot — it retries on an ephemeral one.
    const blocker = createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const takenPort = (blocker.address() as { port: number }).port;

    const deps: SchedulerMcpDeps = {
      store: {} as SchedulerMcpDeps['store'],
      armJob: () => {},
      disarmJob: () => {},
      getThreadsForDirectory: () => [],
      getThreadAdapterName: () => 'claude',
      sendFilesToThread: async () => ({ ok: true, summary: 'unused' }),
      sendMessagesToThread: async () => ({ ok: true, summary: 'unused' }),
      getSecret: async () => secret,
      port: takenPort,
    };
    const handle = createSchedulerMcpServer(deps);
    try {
      await handle.start();
      assert.ok(handle.port > 0, 'a port was bound');
      assert.notEqual(handle.port, takenPort, 'did not bind the occupied port');
    } finally {
      await handle.stop();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

// ─── cancellation correlation lifecycle ─────────────────────────────

describe('scheduler MCP cancellation correlation lifecycle', () => {
  const clientIdentity = 'token:verified-token:client:test-client';
  let currentTimeMs = 1_000;

  const invalidMaxTombstoneCases = [
    { label: 'zero', value: 0 },
    { label: 'negative', value: -1 },
    { label: 'fractional', value: 1.5 },
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
  ];

  function getNowMs(): number {
    return currentTimeMs;
  }

  beforeEach(() => {
    currentTimeMs = 1_000;
  });

  for (const invalidCase of invalidMaxTombstoneCases) {
    it(`rejects a ${invalidCase.label} maxTombstones bound`, () => {
      assert.throws(
        () => createSchedulerMcpCancellationLifecycle({
          getNowMs,
          maxTombstones: invalidCase.value,
        }),
        /maxTombstones must be a positive safe integer/,
      );
    });
  }

  it('expires a pending cancellation before a later request registers', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    lifecycle.cancelRequest(clientIdentity, 41, 'cancel before registration');
    currentTimeMs += schedulerMcpPendingCancellationTtlMs;

    const requestRegistration = lifecycle.registerRequest(clientIdentity, 41);
    assert.equal(requestRegistration.controller.signal.aborted, false);
    requestRegistration.unregister();
  });

  it('bounds pending cancellations and evicts the oldest tombstone first', () => {
    assert.equal(schedulerMcpPendingCancellationMax, 1_000, 'production keeps the 1,000-entry bound');
    const lifecycle = createSchedulerMcpCancellationLifecycle({
      getNowMs,
      maxTombstones: 2,
    });
    lifecycle.cancelRequest(clientIdentity, 1, 'oldest');
    lifecycle.cancelRequest(clientIdentity, 2, 'middle');
    lifecycle.cancelRequest(clientIdentity, 3, 'newest');

    const oldest = lifecycle.registerRequest(clientIdentity, 1);
    const middle = lifecycle.registerRequest(clientIdentity, 2);
    const newest = lifecycle.registerRequest(clientIdentity, 3);
    assert.equal(oldest.controller.signal.aborted, false, 'the oldest pending cancellation must be evicted');
    assert.equal(middle.controller.signal.aborted, true);
    assert.equal(newest.controller.signal.aborted, true);
    oldest.unregister();
    middle.unregister();
    newest.unregister();
  });

  it('isolates pending cancellations by token, client, and typed request ID', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    lifecycle.cancelRequest(clientIdentity, 7, 'exact correlation only');

    const otherToken = lifecycle.registerRequest('token:other-token:client:test-client', 7);
    const otherClient = lifecycle.registerRequest('token:verified-token:client:other-client', 7);
    const stringId = lifecycle.registerRequest(clientIdentity, '7');
    const exactMatch = lifecycle.registerRequest(clientIdentity, 7);
    assert.equal(otherToken.controller.signal.aborted, false);
    assert.equal(otherClient.controller.signal.aborted, false);
    assert.equal(stringId.controller.signal.aborted, false);
    assert.equal(exactMatch.controller.signal.aborted, true);
    otherToken.unregister();
    otherClient.unregister();
    stringId.unregister();
    exactMatch.unregister();
  });

  it('expires a recent completion before an unmatched cancellation arrives', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    const completed = lifecycle.registerRequest(clientIdentity, 51);
    completed.markTerminal();
    completed.unregister();
    currentTimeMs += schedulerMcpPendingCancellationTtlMs;

    lifecycle.cancelRequest(clientIdentity, 51, 'late cancellation after completion expiry');
    const laterRequest = lifecycle.registerRequest(clientIdentity, 51);
    assert.equal(laterRequest.controller.signal.aborted, true, 'the expired completion must not suppress cancellation');
    laterRequest.unregister();
  });

  it('cancels an active reused request even while a recent completion remains', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    const completed = lifecycle.registerRequest(clientIdentity, 52);
    completed.markTerminal();
    completed.unregister();

    const reused = lifecycle.registerRequest(clientIdentity, 52);
    assert.equal(reused.controller.signal.aborted, false);
    lifecycle.cancelRequest(clientIdentity, 52, 'cancel active reused generation');
    assert.equal(reused.controller.signal.aborted, true, 'an active controller must take precedence over a tombstone');
    reused.unregister();
  });

  it('ignores a late cancellation for an inactive recently completed request', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    const completed = lifecycle.registerRequest(clientIdentity, 53);
    completed.markTerminal();
    completed.unregister();

    lifecycle.cancelRequest(clientIdentity, 53, 'late cancellation for completed generation');
    const reused = lifecycle.registerRequest(clientIdentity, 53);
    assert.equal(reused.controller.signal.aborted, false, 'late cancellation must not create a pending tombstone');
    reused.unregister();
  });

  it('does not refresh recent-completion expiry when terminal marking repeats', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({ getNowMs });
    const completed = lifecycle.registerRequest(clientIdentity, 54);
    const terminalTimeMs = currentTimeMs;
    completed.markTerminal();
    currentTimeMs += 1;
    completed.markTerminal();
    completed.unregister();
    currentTimeMs = terminalTimeMs + schedulerMcpPendingCancellationTtlMs;

    lifecycle.cancelRequest(clientIdentity, 54, 'late cancellation after original terminal expiry');
    const reused = lifecycle.registerRequest(clientIdentity, 54);
    assert.equal(reused.controller.signal.aborted, true, 'repeated terminal marking must not extend the tombstone TTL');
    reused.unregister();
  });

  it('bounds recent completions and evicts the oldest tombstone first', () => {
    const lifecycle = createSchedulerMcpCancellationLifecycle({
      getNowMs,
      maxTombstones: 2,
    });
    for (const requestId of [61, 62, 63]) {
      const registration = lifecycle.registerRequest(clientIdentity, requestId);
      registration.markTerminal();
      registration.unregister();
    }

    lifecycle.cancelRequest(clientIdentity, 62, 'retained completion suppresses this inactive cancellation');
    lifecycle.cancelRequest(clientIdentity, 61, 'oldest completion was evicted');
    const oldestReused = lifecycle.registerRequest(clientIdentity, 61);
    const retainedReused = lifecycle.registerRequest(clientIdentity, 62);
    assert.equal(oldestReused.controller.signal.aborted, true);
    assert.equal(retainedReused.controller.signal.aborted, false, 'the retained completion must suppress a late cancellation');
    oldestReused.unregister();
    retainedReused.unregister();
  });
});

// ─── token helpers ───────────────────────────────────────────────────

describe('scheduler MCP token', () => {
  it('round-trips a thread scope', () => {
    const scope: SchedulerScope = { kind: 'thread', threadKey: threadAKey };
    const token = buildSchedulerMcpToken(secret, scope);
    assert.deepEqual(verifySchedulerMcpToken(secret, token), scope);
  });

  it('round-trips a dir scope', () => {
    const scope: SchedulerScope = { kind: 'dir', directory: '/work/project-x' };
    const token = buildSchedulerMcpToken(secret, scope);
    assert.deepEqual(verifySchedulerMcpToken(secret, token), scope);
  });

  it('rejects a tampered signature', () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const [scopeB64, sig] = token.split('.');
    // Flip the last hex char of the signature.
    const lastChar = sig[sig.length - 1];
    const flipped = sig.slice(0, -1) + (lastChar === '0' ? '1' : '0');
    assert.equal(verifySchedulerMcpToken(secret, `${scopeB64}.${flipped}`), null);
  });

  it('rejects a tampered scope (signature no longer matches)', () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const sig = token.split('.')[1];
    const forgedScope = Buffer.from(`thread:${threadBKey}`, 'utf8').toString('base64url');
    assert.equal(verifySchedulerMcpToken(secret, `${forgedScope}.${sig}`), null);
  });

  it('rejects a wrong secret', () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    assert.equal(verifySchedulerMcpToken('b'.repeat(64), token), null);
  });

  it('rejects malformed tokens', () => {
    assert.equal(verifySchedulerMcpToken(secret, 'no-dot'), null);
    assert.equal(verifySchedulerMcpToken(secret, '.onlysig'), null);
    assert.equal(verifySchedulerMcpToken(secret, 'onlyscope.'), null);
    assert.equal(verifySchedulerMcpToken(secret, ''), null);
  });

  it('uses a constant-time compare (timingSafeEqual), per source', () => {
    // Load-bearing static check: a plain === compare would be a timing oracle on
    // the HMAC. Assert the implementation imports and calls timingSafeEqual.
    const source = fs.readFileSync(path.join(__dirname, '..', 'scheduler', 'mcpSurface.ts'), 'utf8');
    assert.match(source, /timingSafeEqual/);
    assert.match(source, /import\s*\{[^}]*timingSafeEqual[^}]*\}\s*from\s*'node:crypto'/);
  });

  it('serialize / parse scope round-trip and reject junk', () => {
    assert.equal(serializeSchedulerScope({ kind: 'thread', threadKey: threadAKey }), `thread:${threadAKey}`);
    assert.equal(serializeSchedulerScope({ kind: 'dir', directory: '/d' }), 'dir:/d');
    assert.deepEqual(parseSchedulerScope(`thread:${threadAKey}`), { kind: 'thread', threadKey: threadAKey });
    assert.deepEqual(parseSchedulerScope('dir:/x'), { kind: 'dir', directory: '/x' });
    assert.equal(parseSchedulerScope('bogus:x'), null);
    assert.equal(parseSchedulerScope('nocolon'), null);
    assert.equal(parseSchedulerScope('thread:'), null);
  });
});

describe('getSchedulerMcpPort', () => {
  const original = process.env.SCHEDULER_MCP_PORT;
  afterEach(() => {
    if (original === undefined) delete process.env.SCHEDULER_MCP_PORT;
    else process.env.SCHEDULER_MCP_PORT = original;
  });
  it('uses an ephemeral port when unset / invalid, and accepts explicit ports', () => {
    delete process.env.SCHEDULER_MCP_PORT;
    assert.equal(getSchedulerMcpPort(), defaultSchedulerMcpPort);
    process.env.SCHEDULER_MCP_PORT = 'nope';
    assert.equal(getSchedulerMcpPort(), defaultSchedulerMcpPort);
    process.env.SCHEDULER_MCP_PORT = '0';
    assert.equal(getSchedulerMcpPort(), 0);
    process.env.SCHEDULER_MCP_PORT = '5099';
    assert.equal(getSchedulerMcpPort(), 5099);
  });
});

// ─── spec building ───────────────────────────────────────────────────

describe('buildSpecFromCreateArgs', () => {
  it('builds a cron spec', () => {
    const result = buildSpecFromCreateArgs({ cron: '0 9 * * *' }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'cron', cronExpr: '0 9 * * *' });
  });

  it('builds a cron N-times spec via repeatCount', () => {
    const result = buildSpecFromCreateArgs({ cron: '0 9 * * *', repeatCount: 3 }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'cron', cronExpr: '0 9 * * *', remainingRuns: 3 });
  });

  it('builds a once spec', () => {
    const future = new Date(nowMs + 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ onceAt: future }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'once', onceAtIso: future });
  });

  it('rejects cron + onceAt together, with the recipe hint', () => {
    const future = new Date(nowMs + 5 * 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ cron: '0 9 * * *', onceAt: future }, nowMs);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /not both/);
      assert.match(result.error, /Recipes/);
    }
  });

  it('rejects neither cron nor onceAt, with the recipe hint', () => {
    const result = buildSpecFromCreateArgs({}, nowMs);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /exactly one/);
      assert.match(result.error, /Recipes/);
    }
  });

  // The live bug: the agent reached for repeatCount:1 to mean "run once". That is
  // now ACCEPTED (a one-shot always runs once) — repeatCount is ignored, not an error.
  it('ignores repeatCount:1 on a one-shot (the natural "run once" call)', () => {
    const future = new Date(nowMs + 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ onceAt: future, repeatCount: 1 }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'once', onceAtIso: future });
    assert.match(result.note ?? '', /ignored/i);
  });

  it('ignores an absurd repeatCount on a one-shot', () => {
    const future = new Date(nowMs + 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ onceAt: future, repeatCount: 8842354424542 }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'once', onceAtIso: future });
  });

  it('treats an empty-string cron on a one-shot as omitted', () => {
    const future = new Date(nowMs + 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ onceAt: future, cron: '' }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'once', onceAtIso: future });
    assert.equal(result.note, undefined);
  });

  it('treats an empty/whitespace onceAt on a cron as omitted', () => {
    const result = buildSpecFromCreateArgs({ cron: '0 9 * * *', onceAt: '   ' }, nowMs);
    assert.ok(result.ok);
    assert.deepEqual(result.spec, { kind: 'cron', cronExpr: '0 9 * * *' });
  });

  it('surfaces a bad cron message', () => {
    const result = buildSpecFromCreateArgs({ cron: 'not a cron' }, nowMs);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /cron/i);
  });

  it('rejects a too-frequent cron (min interval)', () => {
    const result = buildSpecFromCreateArgs({ cron: '* * * * *' }, nowMs);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /too often|minimum/i);
  });

  it('rejects a past one-shot', () => {
    const past = new Date(nowMs - 60_000).toISOString();
    const result = buildSpecFromCreateArgs({ onceAt: past }, nowMs);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /past/i);
  });
});

// ─── thread resolution ───────────────────────────────────────────────

describe('resolveTargetThreadKey', () => {
  const noThreads = () => [];

  it('thread scope resolves to its own thread', () => {
    const result = resolveTargetThreadKey({ kind: 'thread', threadKey: threadAKey }, undefined, noThreads);
    assert.deepEqual(result, { ok: true, threadKey: threadAKey });
  });

  it('thread scope accepts a matching threadKey arg', () => {
    const result = resolveTargetThreadKey({ kind: 'thread', threadKey: threadAKey }, threadAKey, noThreads);
    assert.deepEqual(result, { ok: true, threadKey: threadAKey });
  });

  it('thread scope rejects a mismatching threadKey arg', () => {
    const result = resolveTargetThreadKey({ kind: 'thread', threadKey: threadAKey }, threadBKey, noThreads);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /does not match/);
  });

  it('dir scope with 0 bound threads errors', () => {
    const result = resolveTargetThreadKey({ kind: 'dir', directory: '/d' }, undefined, () => []);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /no thread is bound/);
  });

  it('dir scope with exactly 1 bound thread is implicit', () => {
    const result = resolveTargetThreadKey({ kind: 'dir', directory: '/d' }, undefined, () => [threadAKey]);
    assert.deepEqual(result, { ok: true, threadKey: threadAKey });
  });

  it('dir scope with >1 bound thread requires threadKey', () => {
    const result = resolveTargetThreadKey({ kind: 'dir', directory: '/d' }, undefined, () => [threadAKey, threadBKey]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /2 bound threads/);
  });

  it('dir scope with >1 bound thread accepts a valid threadKey', () => {
    const result = resolveTargetThreadKey({ kind: 'dir', directory: '/d' }, threadBKey, () => [threadAKey, threadBKey]);
    assert.deepEqual(result, { ok: true, threadKey: threadBKey });
  });

  it('dir scope rejects a threadKey not bound to the directory', () => {
    const result = resolveTargetThreadKey({ kind: 'dir', directory: '/d' }, threadBKey, () => [threadAKey]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not bound/);
  });
});

// ─── end-to-end over real HTTP ───────────────────────────────────────

interface ServerFixture {
  handle: SchedulerMcpHandle;
  store: StateStore;
  armed: ScheduleRecord[];
  disarmed: string[];
  boundThreads: Map<string, string[]>;
  fileWorkDir: string;
  fileSendGatewayCalls: Array<RecordedFileSendGatewayCall<string>>;
  recordedMessageIds: number[];
  fileSendCalls: Array<{ threadKey: string; options: SendFilesToThreadOptions }>;
  fileSendHandler: { current: SendFilesToThread };
  messageSendCalls: Array<{ threadKey: string; messages: string[] }>;
}

const mcpSingleMessageId = 301;
const mcpAlbumMessageIds = [401, 402];
const mcpSingleMessageIds = {
  sendPhoto: mcpSingleMessageId,
  sendAnimation: mcpSingleMessageId,
  sendVideo: mcpSingleMessageId,
  sendDocument: mcpSingleMessageId,
};

async function buildClient(
  port: number,
  token: string | null,
  clientId?: string,
): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (clientId !== undefined) headers[schedulerMcpClientIdHeader] = clientId;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

function sendCancellationNotification(
  port: number,
  token: string,
  clientId: string,
  requestId: number,
  reason = 'pre-cancelled by test',
): Promise<void> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId, reason },
  });
  return new Promise((resolve, reject) => {
    const cancellationRequest = request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        [schedulerMcpClientIdHeader]: clientId,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body).toString(),
      },
    }, (response) => {
      response.resume();
      response.once('end', () => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`cancellation notification failed with ${response.statusCode}`));
          return;
        }
        resolve();
      });
    });
    cancellationRequest.once('error', reject);
    cancellationRequest.end(body);
  });
}

interface RawHttpResponse {
  statusCode: number;
  body: string;
}

interface RawFileSendCall {
  request: ClientRequest;
  response: Promise<RawHttpResponse>;
}

function startRawFileSendCall(
  port: number,
  token: string,
  clientId: string,
  requestId: number,
  filePath: string,
): RawFileSendCall {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: {
      name: 'send_file_to_user',
      arguments: { paths: [filePath] },
    },
  });
  let resolveResponse = (_response: RawHttpResponse): void => {};
  let rejectResponse = (_error: Error): void => {};
  const response = new Promise<RawHttpResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const fileSendRequest = request({
    host: '127.0.0.1',
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      [schedulerMcpClientIdHeader]: clientId,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
  }, (incomingResponse) => {
    const chunks: string[] = [];
    incomingResponse.setEncoding('utf8');
    incomingResponse.on('data', (chunk: string) => chunks.push(chunk));
    incomingResponse.once('end', () => {
      resolveResponse({
        statusCode: incomingResponse.statusCode ?? 500,
        body: chunks.join(''),
      });
    });
  });
  fileSendRequest.once('error', rejectResponse);
  fileSendRequest.end(body);
  return { request: fileSendRequest, response };
}

/** First text content block of a tool result. */
function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const parsedResult = CallToolResultSchema.parse(result);
  const block = parsedResult.content.find((content) => content.type === 'text');
  return block?.text ?? '';
}

describe('scheduler MCP server end-to-end (real HTTP)', () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let fixture: ServerFixture;

  async function startFixture(): Promise<ServerFixture> {
    const dataDir = path.join(fakeHome, '.telegramCode');
    fs.mkdirSync(dataDir, { recursive: true });
    const store = new StateStore(dataDir, { saveDebounceMs: 20 });
    await store.init();

    const armed: ScheduleRecord[] = [];
    const disarmed: string[] = [];
    const boundThreads = new Map<string, string[]>();
    const fileWorkDir = path.join(fakeHome, 'bound-project');
    fs.mkdirSync(fileWorkDir);
    const fileSendGatewayCalls: Array<RecordedFileSendGatewayCall<string>> = [];
    const recordedMessageIds: number[] = [];
    const defaultSendFilesToThread = createSendFilesToThread({
      resolveTargetAndWorkDir: (threadKey) =>
        threadKey === threadAKey
          ? { ok: true, target: threadKey, workDir: fileWorkDir }
          : { ok: false, error: `invalid threadKey "${threadKey}"` },
      gateway: createFileSendTestRecorderGateway(fileSendGatewayCalls, {
        singleMessageIds: mcpSingleMessageIds,
        albumMessageIds: mcpAlbumMessageIds,
      }),
      recordMessageIds: async (_target, messageIds) => {
        recordedMessageIds.push(...messageIds);
      },
    });
    const fileSendCalls: Array<{ threadKey: string; options: SendFilesToThreadOptions }> = [];
    const fileSendHandler = { current: defaultSendFilesToThread };
    const sendFilesToThread: SendFilesToThread = (threadKey, options) => {
      fileSendCalls.push({ threadKey, options });
      return fileSendHandler.current(threadKey, options);
    };

    const messageSendCalls: Array<{ threadKey: string; messages: string[] }> = [];
    const sendMessagesToThread: SendMessagesToThread = async (threadKey, { messages }) => {
      if (threadKey !== threadAKey) return { ok: false, error: `invalid threadKey "${threadKey}"` };
      messageSendCalls.push({ threadKey, messages });
      return { ok: true, summary: `Delivered ${messages.length} messages to the topic.` };
    };

    const deps: SchedulerMcpDeps = {
      store,
      armJob: (record) => armed.push(record),
      disarmJob: (jobId) => disarmed.push(jobId),
      getThreadsForDirectory: (directory) => boundThreads.get(directory) ?? [],
      getThreadAdapterName: () => 'claude',
      sendFilesToThread,
      sendMessagesToThread,
      getSecret: async () => secret,
      port: 0,
    };
    const handle = createSchedulerMcpServer(deps);
    await handle.start();
    return {
      handle,
      store,
      armed,
      disarmed,
      boundThreads,
      fileWorkDir,
      fileSendGatewayCalls,
      recordedMessageIds,
      fileSendCalls,
      fileSendHandler,
      messageSendCalls,
    };
  }

  beforeEach(async () => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-mcp-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    fixture = await startFixture();
  });

  afterEach(async () => {
    await fixture.handle.stop();
    await fixture.store.flush();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('binds an ephemeral port', () => {
    assert.ok(fixture.handle.port > 0);
  });

  it('destroys active sockets while an initialized client remains connected', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const activeRequest = createIncompleteHttpRequest(fixture.handle.port, token);
    let stopPromise: Promise<void> | null = null;
    try {
      await activeRequest.connected;
      stopPromise = fixture.handle.stop();
      assert.equal(
        await checkPromiseResolvesWithin(stopPromise, schedulerMcpStopTimeoutMs),
        true,
        'stop must destroy the active request socket instead of waiting for its unfinished body',
      );
    } finally {
      if (stopPromise === null) stopPromise = fixture.handle.stop();
      activeRequest.request.destroy();
      await client.close();
      await stopPromise;
    }
  });

  it('rejects a connection with no token', async () => {
    await assert.rejects(buildClient(fixture.handle.port, null));
  });

  it('rejects a connection with an invalid token', async () => {
    await assert.rejects(buildClient(fixture.handle.port, 'garbage.token'));
  });

  it('reports connect-time server instructions on initialize', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const instructions = client.getInstructions();
      assert.ok(instructions, 'server should report instructions on initialize');
      // Use-case pointer, not recipe repetition: names the tools + the fresh-session caveat.
      assert.match(instructions, /schedule_create/);
      assert.match(instructions, /send_file_to_user/);
      assert.match(instructions, /send_messages_to_user/);
      assert.match(instructions, /fresh session/);
    } finally {
      await client.close();
    }
  });

  it('exposes the file-send tool under its agent-facing name send_file_to_user', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('send_file_to_user'), 'file-send tool should be listed as send_file_to_user');
    assert.ok(!toolNames.includes('send_file'), 'the old send_file name must not be exposed anymore');
  });

  it('exposes the discrete-message tool as send_messages_to_user', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(toolNames.includes('send_messages_to_user'), 'message-send tool should be listed');
    } finally {
      await client.close();
    }
  });

  it('send_messages_to_user routes each message to the scope-resolved thread', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_messages_to_user',
        arguments: { messages: ['🗞 Digest', '📅 4 September', 'headline one https://t.me/x/1'] },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.deepEqual(fixture.messageSendCalls, [
        { threadKey: threadAKey, messages: ['🗞 Digest', '📅 4 September', 'headline one https://t.me/x/1'] },
      ]);
      assert.match(firstText(result), /Delivered 3 messages/);
    } finally {
      await client.close();
    }
  });

  it('send_messages_to_user rejects a cross-thread threadKey (scope isolation)', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_messages_to_user',
        arguments: { messages: ['x'], threadKey: threadBKey },
      });
      assert.equal(result.isError, true);
      assert.equal(fixture.messageSendCalls.length, 0, 'no send when the threadKey is out of scope');
    } finally {
      await client.close();
    }
  });

  linuxIt('send_file_to_user routes a single MP4 to sendVideo with its caption', async () => {
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'clip.mp4'), 'video');
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['clip.mp4'], caption: 'clip caption' },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.deepEqual(fixture.fileSendGatewayCalls, [
        {
          method: 'sendVideo',
          target: threadAKey,
          source: { filename: 'clip.mp4', sizeBytes: 5, contents: 'video' },
          caption: 'clip caption',
        },
      ]);
      assert.deepEqual(fixture.recordedMessageIds, [mcpSingleMessageId]);
    } finally {
      await client.close();
    }
  });

  linuxIt('send_file_to_user coerces bridge-stringified paths (JSON string and bare string)', async () => {
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'clip.mp4'), 'video');
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      // Some MCP bridges serialize array arguments as a raw JSON STRING.
      const jsonStringResult = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: '["clip.mp4"]', caption: 'stringified array' },
      });
      assert.notEqual(jsonStringResult.isError, true, firstText(jsonStringResult));
      assert.equal(fixture.fileSendGatewayCalls.length, 1);
      assert.equal(fixture.fileSendGatewayCalls[0]?.method, 'sendVideo');

      // A bare single path string wraps into a one-element array.
      const bareStringResult = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: 'clip.mp4' },
      });
      assert.notEqual(bareStringResult.isError, true, firstText(bareStringResult));
      assert.equal(fixture.fileSendGatewayCalls.length, 2);
      assert.equal(fixture.fileSendGatewayCalls[1]?.method, 'sendVideo');
    } finally {
      await client.close();
    }
  });

  linuxIt('send_file_to_user routes a PNG+MP4 album as photo then video with one caption', async () => {
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'chart.png'), 'photo');
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'clip.mp4'), 'video');
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['chart.png', 'clip.mp4'], caption: 'album caption' },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.deepEqual(fixture.fileSendGatewayCalls, [
        {
          method: 'sendMediaGroup',
          target: threadAKey,
          mediaGroup: {
            kind: 'photoVideo',
            media: [
              {
                type: 'photo',
                media: { filename: 'chart.png', sizeBytes: 5, contents: 'photo' },
                caption: 'album caption',
              },
              {
                type: 'video',
                media: { filename: 'clip.mp4', sizeBytes: 5, contents: 'video' },
              },
            ],
          },
        },
      ]);
      assert.deepEqual(fixture.recordedMessageIds, mcpAlbumMessageIds);
    } finally {
      await client.close();
    }
  });

  linuxIt('send_file_to_user routes an as_file MP4 to sendDocument', async () => {
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'clip.mp4'), 'video');
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['clip.mp4'], as_file: true },
      });
      assert.notEqual(result.isError, true, firstText(result));
      assert.deepEqual(fixture.fileSendGatewayCalls, [
        {
          method: 'sendDocument',
          target: threadAKey,
          source: { filename: 'clip.mp4', sizeBytes: 5, contents: 'video' },
        },
      ]);
      assert.deepEqual(fixture.recordedMessageIds, [mcpSingleMessageId]);
    } finally {
      await client.close();
    }
  });

  linuxIt('directory-scoped send_file_to_user forwards its canonical authorized directory', async () => {
    fs.writeFileSync(path.join(fixture.fileWorkDir, 'clip.mp4'), 'video');
    fixture.boundThreads.set(fixture.fileWorkDir, [threadAKey]);
    const token = buildSchedulerMcpToken(secret, {
      kind: 'dir',
      directory: fixture.fileWorkDir,
    });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['clip.mp4'] },
      });

      assert.notEqual(result.isError, true, firstText(result));
      assert.equal(fixture.fileSendCalls.length, 1);
      assert.equal(fixture.fileSendCalls[0].threadKey, threadAKey);
      assert.equal(fixture.fileSendCalls[0].options.authorizedWorkDir, fixture.fileWorkDir);
      assert.ok(fixture.fileSendCalls[0].options.signal instanceof AbortSignal);
    } finally {
      await client.close();
    }
  });

  it('returns deliveryUnknown as machine-readable non-error output that forbids retry', async () => {
    fixture.fileSendHandler.current = async () => ({
      ok: false,
      kind: 'deliveryUnknown',
      error: 'Telegram may already have accepted this delivery; MUST NOT retry automatically.',
    });
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['ambiguous.bin'] },
      });
      const parsedResult = CallToolResultSchema.parse(result);

      assert.notEqual(parsedResult.isError, true, firstText(result));
      assert.deepEqual(parsedResult.structuredContent, {
        kind: 'deliveryUnknown',
        retryable: false,
      });
      assert.match(firstText(result), /must not retry automatically/i);
    } finally {
      await client.close();
    }
  });

  it('canceling a real HTTP file-send call aborts the service signal', async () => {
    let markFileSendStarted = () => {};
    let markServerSignalAborted = () => {};
    const fileSendStarted = new Promise<void>((resolve) => { markFileSendStarted = resolve; });
    const serverSignalAborted = new Promise<void>((resolve) => { markServerSignalAborted = resolve; });
    fixture.fileSendHandler.current = async (_threadKey, options) => {
      const signal = options.signal;
      assert.ok(signal, 'the MCP request signal must reach the file-send service');
      markFileSendStarted();
      return new Promise((_resolve, reject) => {
        const handleAbort = () => {
          markServerSignalAborted();
          reject(signal.reason);
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        if (signal.aborted) handleAbort();
      });
    };
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const controller = new AbortController();
    try {
      const result = client.callTool(
        {
          name: 'send_file_to_user',
          arguments: { paths: ['unused.bin'] },
        },
        CallToolResultSchema,
        { signal: controller.signal },
      );
      await fileSendStarted;
      controller.abort();

      await assert.rejects(result, /AbortError: This operation was aborted/);
      assert.equal(
        await checkPromiseResolvesWithin(serverSignalAborted, schedulerMcpStopTimeoutMs),
        true,
        'the canceled HTTP request must abort the server-side tool signal',
      );
    } finally {
      controller.abort();
      await client.close();
    }
  });

  it('suppresses an inactive late cancellation but cancels the active reused request', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const clientId = 'reused-request-client';
    fixture.fileSendHandler.current = async () => ({ ok: true, summary: 'first completed' });
    const firstClient = await buildClient(fixture.handle.port, token, clientId);
    try {
      const firstResult = await firstClient.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['first.bin'] },
      });
      assert.equal(firstText(firstResult), 'first completed');
    } finally {
      await firstClient.close();
    }

    await sendCancellationNotification(
      fixture.handle.port,
      token,
      clientId,
      1,
      'stale cancellation for the inactive completed generation',
    );

    let markReusedRequestStarted = () => {};
    let markReusedRequestAborted = () => {};
    const reusedRequestStarted = new Promise<void>((resolve) => {
      markReusedRequestStarted = resolve;
    });
    const reusedRequestAborted = new Promise<void>((resolve) => {
      markReusedRequestAborted = resolve;
    });
    let reusedRequestSignal: AbortSignal | undefined;
    fixture.fileSendHandler.current = async (_threadKey, options) => {
      const signal = options.signal;
      assert.ok(signal);
      reusedRequestSignal = signal;
      markReusedRequestStarted();
      return new Promise((_resolve, reject) => {
        const handleAbort = () => {
          markReusedRequestAborted();
          reject(signal.reason);
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        if (signal.aborted) handleAbort();
      });
    };

    const reusedClient = await buildClient(fixture.handle.port, token, clientId);
    try {
      const reusedResultSettled = reusedClient.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['reused.bin'] },
      }).then(() => undefined, () => undefined);
      await reusedRequestStarted;
      assert.equal(
        reusedRequestSignal?.aborted,
        false,
        'the inactive late cancellation must not poison the reused request',
      );

      await sendCancellationNotification(
        fixture.handle.port,
        token,
        clientId,
        1,
        'legitimate cancellation for the active reused generation',
      );
      assert.equal(
        await checkPromiseResolvesWithin(reusedRequestAborted, schedulerMcpStopTimeoutMs),
        true,
        'the active reused request must receive its legitimate cancellation',
      );
      assert.equal(reusedRequestSignal?.aborted, true);
      await reusedResultSettled;
    } finally {
      await reusedClient.close();
    }
  });

  it('records abnormal response closure before abort so late cancellation cannot poison ID reuse', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const clientId = 'abnormal-close-client';
    const requestId = 77;
    let markFirstRequestStarted = () => {};
    let markFirstRequestAborted = () => {};
    const firstRequestStarted = new Promise<void>((resolve) => {
      markFirstRequestStarted = resolve;
    });
    const firstRequestAborted = new Promise<void>((resolve) => {
      markFirstRequestAborted = resolve;
    });
    let firstRequestSignal: AbortSignal | undefined;
    let wasReusedRequestAbortedOnEntry: boolean | undefined;
    let serviceCallCount = 0;
    fixture.fileSendHandler.current = async (_threadKey, options) => {
      const signal = options.signal;
      assert.ok(signal);
      serviceCallCount += 1;
      if (serviceCallCount === 1) {
        firstRequestSignal = signal;
        markFirstRequestStarted();
        return new Promise((_resolve, reject) => {
          const handleAbort = () => {
            markFirstRequestAborted();
            reject(signal.reason);
          };
          signal.addEventListener('abort', handleAbort, { once: true });
          if (signal.aborted) handleAbort();
        });
      }

      wasReusedRequestAbortedOnEntry = signal.aborted;
      assert.equal(signal.aborted, false, 'the late cancellation must not pre-cancel the reused request');
      return { ok: true, summary: 'reused request entered un-aborted' };
    };

    const abnormalCall = startRawFileSendCall(
      fixture.handle.port,
      token,
      clientId,
      requestId,
      'abnormal.bin',
    );
    void abnormalCall.response.catch(() => undefined);
    await firstRequestStarted;
    abnormalCall.request.destroy();

    assert.equal(
      await checkPromiseResolvesWithin(firstRequestAborted, schedulerMcpStopTimeoutMs),
      true,
      'abnormal client closure must abort the active server signal',
    );
    assert.equal(firstRequestSignal?.aborted, true);

    await sendCancellationNotification(
      fixture.handle.port,
      token,
      clientId,
      requestId,
      'late cancellation after abnormal closure',
    );
    const reusedCall = startRawFileSendCall(
      fixture.handle.port,
      token,
      clientId,
      requestId,
      'reused-after-abnormal.bin',
    );
    const reusedResponse = await reusedCall.response;

    assert.equal(reusedResponse.statusCode, 200, reusedResponse.body);
    assert.equal(serviceCallCount, 2, 'the reused call must enter the service');
    assert.equal(wasReusedRequestAbortedOnEntry, false);
  });

  it('isolates equal request IDs from two clients that share one bearer token', async () => {
    const serverSignals: AbortSignal[] = [];
    const startedResolvers: Array<() => void> = [];
    const abortedResolvers: Array<() => void> = [];
    const started = [0, 1].map(() => new Promise<void>((resolve) => {
      startedResolvers.push(resolve);
    }));
    const aborted = [0, 1].map(() => new Promise<void>((resolve) => {
      abortedResolvers.push(resolve);
    }));
    let releaseSecond = () => {};
    fixture.fileSendHandler.current = async (_threadKey, options) => {
      const signal = options.signal;
      assert.ok(signal);
      const callIndex = serverSignals.length;
      serverSignals.push(signal);
      startedResolvers[callIndex]();
      return new Promise((resolve, reject) => {
        const handleAbort = () => {
          abortedResolvers[callIndex]();
          reject(signal.reason);
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        if (signal.aborted) handleAbort();
        if (callIndex === 1) {
          releaseSecond = () => resolve({ ok: true, summary: 'second delivered' });
        }
      });
    };
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const firstClient = await buildClient(fixture.handle.port, token, 'client-a');
    const secondClient = await buildClient(fixture.handle.port, token, 'client-b');
    const firstController = new AbortController();
    try {
      const firstResult = firstClient.callTool(
        { name: 'send_file_to_user', arguments: { paths: ['first.bin'] } },
        CallToolResultSchema,
        { signal: firstController.signal },
      );
      await started[0];
      const secondResult = secondClient.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['second.bin'] },
      });
      await started[1];

      firstController.abort();
      await assert.rejects(firstResult, /AbortError: This operation was aborted/);
      assert.equal(
        await checkPromiseResolvesWithin(aborted[0], schedulerMcpStopTimeoutMs),
        true,
        'the canceled client must abort its server request',
      );
      assert.equal(serverSignals[0].aborted, true);
      assert.equal(serverSignals[1].aborted, false, 'one client must not cancel another client\'s equal request ID');

      releaseSecond();
      const secondToolResult = await secondResult;
      assert.notEqual(secondToolResult.isError, true, firstText(secondToolResult));
      assert.equal(firstText(secondToolResult), 'second delivered');
    } finally {
      firstController.abort();
      releaseSecond();
      await firstClient.close();
      await secondClient.close();
    }
  });

  it('applies a cancellation notification that arrives before request registration', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const clientId = 'pre-cancel-client';
    await sendCancellationNotification(fixture.handle.port, token, clientId, 1);
    const client = await buildClient(fixture.handle.port, token, clientId);
    try {
      const result = await client.callTool({
        name: 'send_file_to_user',
        arguments: { paths: ['must-not-send.bin'] },
      });

      assert.equal(result.isError, true);
      assert.match(firstText(result), /abort|cancel/i);
      assert.equal(fixture.fileSendCalls.length, 0, 'a pre-cancelled request must not enter the service');
    } finally {
      await client.close();
    }
  });

  it('thread-scope: create (cron + once + N-times) → list → cancel → list empty', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);

    const futureIso = new Date(Date.now() + 5 * 60_000).toISOString();
    const cronResult = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Daily', cron: '0 9 * * *', prompt: 'standup' },
    });
    assert.notEqual(cronResult.isError, true, firstText(cronResult));
    assert.match(firstText(cronResult), /Scheduled "Daily"/);

    const onceResult = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'OneShot', onceAt: futureIso, prompt: 'fire once' },
    });
    assert.notEqual(onceResult.isError, true, firstText(onceResult));

    const ntimesResult = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Thrice', cron: '0 */6 * * *', repeatCount: 3, prompt: 'thrice' },
    });
    assert.notEqual(ntimesResult.isError, true, firstText(ntimesResult));

    // All three armed and persisted to the right thread.
    assert.equal(fixture.armed.length, 3);
    assert.equal(fixture.store.getThreadSchedules({ chatId: -1001234567890, threadId: 11 }).length, 3);

    const listResult = await client.callTool({ name: 'schedule_list', arguments: {} });
    const listText = firstText(listResult);
    assert.match(listText, /Daily/);
    assert.match(listText, /OneShot/);
    assert.match(listText, /Thrice/);
    assert.match(listText, /3 runs left/);

    // Cancel the cron one by its real id.
    const dailyId = fixture.armed.find((r) => r.name === 'Daily')?.id;
    assert.ok(dailyId);
    const cancelResult = await client.callTool({ name: 'schedule_cancel', arguments: { id: dailyId } });
    assert.notEqual(cancelResult.isError, true, firstText(cancelResult));
    assert.match(firstText(cancelResult), /Cancelled "Daily"/);
    assert.ok(fixture.disarmed.includes(dailyId));

    // Cancel the remaining two.
    for (const name of ['OneShot', 'Thrice']) {
      const id = fixture.armed.find((r) => r.name === name)?.id;
      assert.ok(id);
      await client.callTool({ name: 'schedule_cancel', arguments: { id } });
    }
    const emptyList = await client.callTool({ name: 'schedule_list', arguments: {} });
    assert.match(firstText(emptyList), /No schedules/);

    await client.close();
  });

  it('thread-scope: create with a mismatching threadKey arg errors', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Wrong', cron: '0 9 * * *', prompt: 'p', threadKey: threadBKey },
    });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /does not match/);
    assert.equal(fixture.armed.length, 0);
    await client.close();
  });

  it('thread-scope: cannot cancel a job owned by another thread', async () => {
    // Seed a job on thread B directly in the store.
    const created = await (await import('../scheduler/store')).createScheduleForThread(fixture.store, {
      threadKey: { chatId: -1001234567890, threadId: 22 },
      name: 'BJob',
      spec: { kind: 'cron', cronExpr: '0 9 * * *' },
      prompt: 'p',
      createdBy: 'agent',
      nowMs: Date.now(),
    });
    assert.ok(created.ok);

    // A thread-A-scoped client must not be able to cancel B's job.
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({ name: 'schedule_cancel', arguments: { id: created.record.id } });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /no schedule with id/);
    // Still present (not deleted by the cross-thread attempt).
    assert.ok(fixture.store.getSchedules()[created.record.id]);
    await client.close();
  });

  it('dir-scope: 2 bound threads → create needs threadKey, then works', async () => {
    const directory = '/work/shared';
    fixture.boundThreads.set(directory, [threadAKey, threadBKey]);
    const token = buildSchedulerMcpToken(secret, { kind: 'dir', directory });
    const client = await buildClient(fixture.handle.port, token);

    // No threadKey → ambiguous → error, nothing armed.
    const ambiguous = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Amb', cron: '0 9 * * *', prompt: 'p' },
    });
    assert.equal(ambiguous.isError, true);
    assert.match(firstText(ambiguous), /2 bound threads/);
    assert.equal(fixture.armed.length, 0);

    // With a valid threadKey → works.
    const ok = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Picked', cron: '0 9 * * *', prompt: 'p', threadKey: threadBKey },
    });
    assert.notEqual(ok.isError, true, firstText(ok));
    assert.equal(fixture.armed.length, 1);
    assert.equal(fixture.armed[0].threadKey, threadBKey);
    await client.close();
  });

  it('dir-scope: exactly 1 bound thread is implicit', async () => {
    const directory = '/work/solo';
    fixture.boundThreads.set(directory, [threadAKey]);
    const token = buildSchedulerMcpToken(secret, { kind: 'dir', directory });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Solo', cron: '0 9 * * *', prompt: 'p' },
    });
    assert.notEqual(result.isError, true, firstText(result));
    assert.equal(fixture.armed.length, 1);
    assert.equal(fixture.armed[0].threadKey, threadAKey);
    await client.close();
  });

  it('one-shot with a redundant repeatCount succeeds first-try (live transcript regression)', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const futureIso = new Date(Date.now() + 60 * 60_000).toISOString();
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'OnceTask', onceAt: futureIso, repeatCount: 1, prompt: 'do it once' },
    });
    assert.notEqual(result.isError, true, firstText(result));
    assert.match(firstText(result), /ignored/i);
    const record = fixture.armed.find((r) => r.name === 'OnceTask');
    assert.ok(record);
    assert.equal(record.spec.kind, 'once');
    // No N-times remainingRuns leaked onto the one-shot.
    assert.equal((record.spec as { remainingRuns?: number }).remainingRuns, undefined);
    await client.close();
  });

  it('isPinSilent rides through to the persisted record', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const result = await client.callTool({
      name: 'schedule_create',
      arguments: { name: 'Silent', cron: '0 9 * * *', prompt: 'p', isPinSilent: true },
    });
    assert.notEqual(result.isError, true, firstText(result));
    const record = fixture.armed.find((r) => r.name === 'Silent');
    assert.ok(record);
    assert.equal(record.isPinSilent, true);
    assert.equal(fixture.store.getSchedules()[record.id].isPinSilent, true);
    await client.close();
  });
});
