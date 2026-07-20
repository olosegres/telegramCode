/**
 * @description External-process transport of the json-stream adapter (plan
 * 2026-07-05-jsonstream-restart-isolation, S2): exit detection via the
 * wrapper's pid/exitcode files, the final stdout drain, and the busy-state
 * reconstruction from replayed events.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - a poll tick that finds the exitcode file must FIRST drain the bytes claude
 *   flushed at exit (the final `result` still reaches the topic) and only then
 *   emit `closed` with the REAL wrapper-reported code — losing the last flush
 *   is exactly the "final answer discarded" bug class;
 * - an explicit stop converges through the same finalize but emits `stopped`;
 * - `textDelta`/`result` alone reconstruct `isBusy` (an ADOPTED session has no
 *   `sendInput` to set it), and the persisted tail offset lands on the line
 *   boundary so a restart replays nothing twice.
 *
 * The adapter's private members are reached via runtime bracket access (tests
 * are type-stripped by tsx), same pattern as claudeJsonStreamWatermarkAdvance.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeJsonStreamAdapter } from '../adapters/claudeJsonStreamAdapter';
import { ClaudeStreamLineReader } from '../utils/claudeStreamJson';
import { busyIdleWatchdogMs } from '../utils/jsonStreamBusyWatchdog';
import {
  createStdoutTailState,
  getJsonStreamSessionPaths,
} from '../utils/jsonStreamHost';
import { keyToString, type JsonStreamTailOffset, type ThreadKey } from '../types';

// A key no live thread uses — cleanup paths derived from it are guaranteed no-ops.
const key: ThreadKey = { chatId: -100999777, threadId: 55 };

/** A pid that is certainly dead: a reaped short-lived child of ours. */
function getDeadPid(): number {
  const child = spawnSync('true');
  return child.pid ?? 1;
}

function createSessionInDir(adapter: ClaudeJsonStreamAdapter, dir: string) {
  const paths = getJsonStreamSessionPaths(dir);
  const session = {
    key,
    workDir: '/tmp/jsonstream-transport-work',
    sessionId: 'sess-transport',
    pid: getDeadPid(),
    paths,
    fifoFd: -1, // closeFifo tolerates an invalid fd (EBADF swallowed)
    stdinWriteChain: Promise.resolve(),
    tail: createStdoutTailState(0),
    pollTimer: null,
    pollDelayMs: 300,
    unchangedStreak: 0,
    isOversizeWarned: false,
    lastPersistedTailOffset: 0,
    reader: new ClaudeStreamLineReader(),
    isActive: true,
    isStopping: false,
    isRespawning: false,
    isBusy: false,
    lastStdoutActivityAt: Date.now(),
    outstandingToolUseIds: new Set<string>(),
    model: null,
    effort: null,
    currentResponseText: '',
    emittedLength: 0,
    outputTimer: null,
    reasoningText: '',
    reasoningStartedAt: null,
    reasoningTimer: null,
    reasoningActive: false,
    toolNamesById: new Map(),
    questionToolUseIds: new Set(),
    subagentActive: false,
    childResponseText: '',
    childEmittedLength: 0,
    childOutputTimer: null,
    pendingInitResolve: null,
    initRequestId: null,
    pendingQuestion: null,
    apiErrorFired: false,
    lastWatermarkOffset: -1,
  };
  adapter['sessions'].set(keyToString(key), session);
  return session;
}

const resultLine =
  JSON.stringify({ type: 'result', is_error: false, result: 'final answer' }) + '\n';
const textDeltaLine =
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }) + '\n';

describe('json-stream external transport — exit detection', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drains the final flush, then emits closed with the wrapper-reported code', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-exit-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    // Claude flushed a final result and exited; the wrapper recorded code 3.
    fs.writeFileSync(session.paths.stdoutFile, resultLine);
    fs.writeFileSync(session.paths.exitCodeFile, '3\n');

    const outputs: string[] = [];
    const closedKeys: ThreadKey[] = [];
    const tailWrites: JsonStreamTailOffset[] = [];
    adapter.on('output', (_k: ThreadKey, text: string) => outputs.push(text));
    adapter.on('closed', (k: ThreadKey) => closedKeys.push(k));
    adapter.setJsonStreamTailWriter((_k, tail) => tailWrites.push(tail));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      adapter['pollTailTick'](session);
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(outputs, ['final answer'], 'the exit-flushed result still reaches the topic');
    assert.deepEqual(closedKeys, [key], 'unexpected external exit emits closed');
    assert.ok(warnings.some((w) => w.includes('code=3')), `real exit code surfaces in the log: ${warnings}`);
    assert.equal(adapter['sessions'].size, 0, 'the session is deregistered');
    assert.equal(fs.existsSync(dir), false, 'the host dir is removed');
    // The tail offset persisted at the line boundary (== the whole result line).
    assert.deepEqual(tailWrites, [{ sessionId: 'sess-transport', offsetBytes: Buffer.byteLength(resultLine) }]);
  });

  it('an explicit stop converges through the same finalize but emits stopped', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-stop-'));
    const adapter = new ClaudeJsonStreamAdapter();
    createSessionInDir(adapter, dir);

    const events: string[] = [];
    adapter.on('stopped', () => events.push('stopped'));
    adapter.on('closed', () => events.push('closed'));
    await adapter['stopSessionInternal'](key);

    assert.deepEqual(events, ['stopped'], 'explicit stop must not read as an unexpected close');
    assert.equal(adapter['sessions'].size, 0);
    assert.equal(fs.existsSync(dir), false, 'the host dir is removed on stop');
  });

  it('holds the tail offset back while answer text sits in the batch, releases it on flush', () => {
    // Live seam-loss repro (2026-07-05, topic 9085): lines consumed into the
    // 350ms answer batch died with the killed bot while the persisted offset
    // had already moved past them — the adopting bot skipped them on replay
    // ("216–221 missing"). The offset must persist only once the batched text
    // has actually been emitted.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-defer-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    fs.writeFileSync(session.paths.stdoutFile, textDeltaLine);
    const tailWrites: JsonStreamTailOffset[] = [];
    adapter.setJsonStreamTailWriter((_k, tail) => tailWrites.push(tail));

    assert.equal(adapter['drainStdoutTail'](session), true, 'the delta line is consumed');
    assert.deepEqual(tailWrites, [], 'un-emitted batched text must hold the offset back');

    adapter['flushAnswer'](session, false);
    assert.deepEqual(
      tailWrites,
      [{ sessionId: 'sess-transport', offsetBytes: Buffer.byteLength(textDeltaLine) }],
      'the flush releases the boundary at the consumed line',
    );
  });

  it('reconstructs isBusy from replayed events (adopt has no sendInput)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-busy-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);

    adapter['onStdout'](session, textDeltaLine);
    assert.equal(session.isBusy, true, 'a replayed mid-turn delta marks the session busy');
    adapter['onStdout'](session, resultLine);
    assert.equal(session.isBusy, false, 'the replayed result clears it');
  });
});

// tool_use assistant line (a normal, non-sub-agent tool) + its tool_result.
const toolUseLine =
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } }) + '\n';
const toolResultLine =
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } }) + '\n';

describe('json-stream idle watchdog — the stuck-busy / hung-typing backstop', () => {
  let dir: string;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('clears a busy session gone silent with nothing in flight (a missed terminal result)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-wd-clear-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    // A delta arrived (busy=true) but the terminal `result` never did.
    adapter['onStdout'](session, textDeltaLine);
    adapter['flushAnswer'](session, false); // drain the batch (no un-emitted text)
    assert.equal(session.isBusy, true);
    // stdout has been silent past the threshold.
    session.lastStdoutActivityAt = Date.now() - busyIdleWatchdogMs - 1000;

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    try {
      adapter['maybeClearBusyOnIdle'](session);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(session.isBusy, false, 'the stuck busy flag is cleared → typing indicator can stop');
    assert.ok(warnings.some((w) => w.includes('watchdog')), `the clear is logged: ${warnings}`);
  });

  it('does NOT clear while a tool is still outstanding (a long silent Bash is legitimately busy)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-wd-tool-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    // A tool_use started but its tool_result has not come back yet.
    adapter['onStdout'](session, toolUseLine);
    assert.equal(session.isBusy, true);
    assert.equal(session.outstandingToolUseIds.size, 1, 'the tool is tracked as in flight');
    session.lastStdoutActivityAt = Date.now() - busyIdleWatchdogMs - 1000;

    adapter['maybeClearBusyOnIdle'](session);
    assert.equal(session.isBusy, true, 'an outstanding tool vetoes the idle clear');

    // Once the tool returns, the outstanding set drains and the watchdog may fire.
    adapter['onStdout'](session, toolResultLine);
    assert.equal(session.outstandingToolUseIds.size, 0, 'the returned tool leaves the in-flight set');
    session.lastStdoutActivityAt = Date.now() - busyIdleWatchdogMs - 1000;
    adapter['maybeClearBusyOnIdle'](session);
    assert.equal(session.isBusy, false, 'with no tool outstanding the stuck busy clears');
  });

  it('an explicit interrupt clears isBusy immediately (an aborted turn may emit no result)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstream-wd-int-'));
    const adapter = new ClaudeJsonStreamAdapter();
    const session = createSessionInDir(adapter, dir);
    adapter['onStdout'](session, toolUseLine); // busy, one tool outstanding
    assert.equal(session.isBusy, true);

    adapter.sendEscape(session.key); // → sendInterrupt
    assert.equal(session.isBusy, false, 'interrupt drops busy without waiting on a result');
    assert.equal(session.outstandingToolUseIds.size, 0, 'interrupt clears the in-flight tool set');
  });
});
