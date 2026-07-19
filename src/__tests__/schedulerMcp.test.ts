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
 *     thread-scope create with a mismatching threadKey arg errors.
 *
 * The end-to-end test uses a REAL StateStore (state.test.ts fake-HOME idiom) and
 * fake armJob/disarmJob capturing calls, so the assertions are load-bearing:
 * a broken token verify, scope resolution, or tool handler fails the round-trip.
 */

import { test, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StateStore } from '../state';
import { keyToString, type ThreadKey } from '../types';
import {
  buildSchedulerMcpToken,
  verifySchedulerMcpToken,
  buildSpecFromCreateArgs,
  resolveTargetThreadKey,
  createSchedulerMcpServer,
  serializeSchedulerScope,
  parseSchedulerScope,
  getSchedulerMcpPort,
  defaultSchedulerMcpPort,
  type SchedulerScope,
  type SchedulerMcpHandle,
  type SchedulerMcpDeps,
} from '../scheduler/mcpSurface';
import type { ScheduleRecord } from '../scheduler/types';

const secret = 'a'.repeat(64);
const threadAKey = keyToString({ chatId: -1001234567890, threadId: 11 });
const threadBKey = keyToString({ chatId: -1001234567890, threadId: 22 });
const nowMs = new Date(2026, 5, 6, 10, 0, 0).getTime();

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
  it('defaults when unset / invalid, reads a valid value', () => {
    delete process.env.SCHEDULER_MCP_PORT;
    assert.equal(getSchedulerMcpPort(), defaultSchedulerMcpPort);
    process.env.SCHEDULER_MCP_PORT = 'nope';
    assert.equal(getSchedulerMcpPort(), defaultSchedulerMcpPort);
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
}

async function buildClient(port: number, token: string | null): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

/** First text content block of a tool result. */
function firstText(result: { content: unknown }): string {
  const content = result.content as { type: string; text?: string }[];
  const block = content.find((c) => c.type === 'text');
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

    const deps: SchedulerMcpDeps = {
      store,
      armJob: (record) => armed.push(record),
      disarmJob: (jobId) => disarmed.push(jobId),
      getThreadsForDirectory: (directory) => boundThreads.get(directory) ?? [],
      getThreadAdapterName: () => 'claude',
      getSecret: async () => secret,
      port: 0,
    };
    const handle = createSchedulerMcpServer(deps);
    await handle.start();
    return { handle, store, armed, disarmed, boundThreads };
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

  it('rejects a connection with no token', async () => {
    await assert.rejects(buildClient(fixture.handle.port, null));
  });

  it('rejects a connection with an invalid token', async () => {
    await assert.rejects(buildClient(fixture.handle.port, 'garbage.token'));
  });

  it('reports connect-time server instructions on initialize', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const instructions = client.getInstructions();
    assert.ok(instructions, 'server should report instructions on initialize');
    // Use-case pointer, not recipe repetition: names the tools + the fresh-session caveat.
    assert.match(instructions, /schedule_create/);
    assert.match(instructions, /send_file_to_user/);
    assert.match(instructions, /fresh session/);
  });

  it('exposes the file-send tool under its agent-facing name send_file_to_user', async () => {
    const token = buildSchedulerMcpToken(secret, { kind: 'thread', threadKey: threadAKey });
    const client = await buildClient(fixture.handle.port, token);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('send_file_to_user'), 'file-send tool should be listed as send_file_to_user');
    assert.ok(!toolNames.includes('send_file'), 'the old send_file name must not be exposed anymore');
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
