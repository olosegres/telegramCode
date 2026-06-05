import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkIsThreadTraced,
  checkIsTracingActive,
  configureTraceWriterForTests,
  createTracePreview,
  flushTraceBufferSyncOnExit,
  getTraceConfig,
  installCallApiTrace,
  setTraceConfig,
  traceAgentEmit,
  traceRecvUpdate,
  type CallApiHost,
  type TraceWriterDeps,
} from '../outputTrace';

const threadKey = { chatId: -100123, threadId: 7 };
const threadKeyStr = '-100123:7';

let tempDataDir: string;
let savedDataDir: string | undefined;
let restoreWriter: (() => void) | null = null;

/**
 * @description A fake fs+timer for the trace writer. The timer callback is
 * captured (not scheduled on the real loop) so a test can fire flushes
 * deterministically via {@link fireFlushTimer}. Appends accumulate into
 * {@link appendedSync}/`appendedAsync` so tests can assert order + payload.
 */
interface FakeWriter {
  deps: TraceWriterDeps;
  /** Concatenated bytes the writer has appended (async + sync), in order. */
  written: string;
  /** Number of async appendFile calls — proves batching (one per flush). */
  asyncAppendCount: number;
  /** Pending file size returned by getFileSize (drives rotation). */
  fileSize: number | null;
  /** Renames performed (rotation). */
  renames: Array<{ from: string; to: string }>;
  /** Fire the most recently armed flush timer, if any. */
  fireFlushTimer(): void;
  /** Resolve when the in-flight async flush settles. */
  settle(): Promise<void>;
}

/** Yield to the macrotask queue so all pending writer microtasks drain. */
function drainTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createFakeWriter(): FakeWriter {
  let pendingTimer: (() => void) | null = null;
  const w: FakeWriter = {
    written: '',
    asyncAppendCount: 0,
    fileSize: null,
    renames: [],
    deps: {
      appendFile: async (_filePath, data) => {
        w.asyncAppendCount += 1;
        w.written += data;
      },
      appendFileSync: (_filePath, data) => {
        w.written += data;
      },
      mkdir: async () => {},
      getFileSize: async () => w.fileSize,
      rename: async (from, to) => {
        w.renames.push({ from, to });
        w.fileSize = null;
      },
      setTimer: (callback) => {
        pendingTimer = callback;
        return 1;
      },
      clearTimer: () => {
        pendingTimer = null;
      },
    },
    fireFlushTimer: () => {
      const cb = pendingTimer;
      pendingTimer = null;
      cb?.();
    },
    settle: async () => {
      // A flush has several internal awaits (mkdir → stat → appendFile) and may
      // re-arm itself; drain a few macrotask ticks so the whole chain settles.
      for (let i = 0; i < 5; i++) await drainTick();
    },
  };
  return w;
}

function parseLines(raw: string): Array<Record<string, unknown>> {
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

beforeEach(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-trace-test-'));
  savedDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDataDir;
  // Default: this thread traced, async writer mocked. Individual tests override.
  setTraceConfig({ allThreads: false, threadKeys: [threadKeyStr] });
});

afterEach(() => {
  if (restoreWriter) {
    restoreWriter();
    restoreWriter = null;
  }
  setTraceConfig({ allThreads: false, threadKeys: [] });
  if (savedDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDataDir;
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

describe('trace toggle (setTraceConfig / getTraceConfig)', () => {
  it('is OFF by default → checkIsTracingActive false, hooks write nothing', () => {
    setTraceConfig({ allThreads: false, threadKeys: [] });
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);
    assert.equal(checkIsTracingActive(), false);
    traceAgentEmit('output', threadKey, 'should not be written');
    fake.fireFlushTimer();
    assert.equal(fake.written, '');
  });

  it('per-thread set: only the traced thread records', () => {
    setTraceConfig({ allThreads: false, threadKeys: [threadKeyStr] });
    assert.equal(checkIsThreadTraced(threadKey), true);
    assert.equal(checkIsThreadTraced({ chatId: -100123, threadId: 8 }), false);
  });

  it('all-flag traces every thread', () => {
    setTraceConfig({ allThreads: true, threadKeys: [] });
    assert.equal(checkIsTracingActive(), true);
    assert.equal(checkIsThreadTraced({ chatId: -999, threadId: 42 }), true);
  });

  it('getTraceConfig reflects the seeded config', () => {
    setTraceConfig({ allThreads: true, threadKeys: [threadKeyStr] });
    assert.deepEqual(getTraceConfig(), { allThreads: true, threadKeys: [threadKeyStr] });
  });
});

describe('createTracePreview — surrogate-safe truncation', () => {
  it('returns short text as-is and truncates long ASCII with an ellipsis', () => {
    assert.equal(createTracePreview('short'), 'short');
    const truncated = createTracePreview('y'.repeat(300));
    assert.equal(truncated, `${'y'.repeat(120)}…`);
  });

  it('does not split a surrogate pair at the 120-char boundary', () => {
    // 119 ASCII chars, then an emoji (a surrogate PAIR) starting at index 119
    // so its high half lands at index 119 and its low half at index 120 — a
    // naive slice(0,120) would keep only the high half (a lone surrogate).
    const text = `${'a'.repeat(119)}😀${'b'.repeat(100)}`;
    const preview = createTracePreview(text);
    // The preview must be valid: re-encoding round-trips with no replacement char.
    assert.ok(!preview.includes('�'), 'no replacement char');
    // The trailing high surrogate was dropped → preview is 119 'a' + ellipsis.
    assert.equal(preview, `${'a'.repeat(119)}…`);
    // Proof it is lone-surrogate-free: JSON round-trips and re-parses identically.
    assert.equal(JSON.parse(JSON.stringify(preview)), preview);
  });

  it('keeps a whole emoji when the pair sits fully inside the window', () => {
    const text = `${'a'.repeat(100)}😀${'b'.repeat(100)}`;
    const preview = createTracePreview(text);
    assert.ok(preview.includes('😀'), 'whole emoji preserved');
    assert.equal(JSON.parse(JSON.stringify(preview)), preview);
  });
});

describe('buffered writer — order, threshold, rotation, exit-flush', () => {
  it('preserves append order across two flushes (timer-driven)', async () => {
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);

    traceAgentEmit('output', threadKey, 'first');
    traceAgentEmit('output', threadKey, 'second');
    fake.fireFlushTimer();
    await fake.settle();

    traceAgentEmit('output', threadKey, 'third');
    fake.fireFlushTimer();
    await fake.settle();

    const lines = parseLines(fake.written);
    assert.deepEqual(lines.map((l) => l.preview), ['first', 'second', 'third']);
    // Two flushes batched: 2 lines then 1 line → exactly two async appends.
    assert.equal(fake.asyncAppendCount, 2);
  });

  it('flushes early once the buffer reaches the entry threshold (no timer)', async () => {
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);

    // 200 entries = traceFlushMaxEntries → the 200th push triggers a flush
    // WITHOUT the timer ever firing.
    for (let i = 0; i < 200; i++) traceAgentEmit('output', threadKey, `n${i}`);
    await fake.settle();

    const lines = parseLines(fake.written);
    assert.equal(lines.length, 200);
    assert.equal(lines[0].preview, 'n0');
    assert.equal(lines[199].preview, 'n199');
    assert.equal(fake.asyncAppendCount, 1, 'threshold flush is one batched append');
  });

  it('rotates the trace file to .1 when it exceeds the cap, before appending', async () => {
    const fake = createFakeWriter();
    fake.fileSize = 10 * 1024 * 1024 + 1; // one byte over the 10MB cap
    restoreWriter = configureTraceWriterForTests(fake.deps);

    traceAgentEmit('output', threadKey, 'after rotation');
    fake.fireFlushTimer();
    await fake.settle();

    assert.equal(fake.renames.length, 1, 'one rotation happened');
    assert.ok(fake.renames[0].to.endsWith('.1'), 'rotated to .1');
    const lines = parseLines(fake.written);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].preview, 'after rotation');
  });

  it('exit hook flushes the remaining buffer synchronously', () => {
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);

    traceAgentEmit('output', threadKey, 'unflushed');
    // No timer fired → still buffered. The exit hook must drain it.
    assert.equal(fake.written, '');
    flushTraceBufferSyncOnExit();
    const lines = parseLines(fake.written);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].preview, 'unflushed');
  });
});

describe('traceRecvUpdate — thread filtering', () => {
  it('records the traced thread and computes latencyMs', async () => {
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);
    const nowSec = Math.floor(Date.now() / 1000);

    traceRecvUpdate({
      updateType: 'message',
      updateId: 42,
      fromId: 7000001,
      chatId: -100123,
      threadId: 7,
      preview: '/status',
      tgDateSec: nowSec - 5,
    });
    fake.fireFlushTimer();
    await fake.settle();

    const entry = parseLines(fake.written)[0];
    assert.equal(entry.kind, 'recv');
    assert.equal(entry.updateId, 42);
    assert.equal(entry.preview, '/status');
    const latencyMs = entry.latencyMs as number;
    assert.ok(latencyMs >= 4000 && latencyMs < 60000, `latencyMs=${latencyMs}`);
  });

  it('drops an update for an untraced thread', async () => {
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);

    traceRecvUpdate({ updateType: 'message', updateId: 1, chatId: -100123, threadId: 999, preview: 'x' });
    fake.fireFlushTimer();
    await fake.settle();
    assert.equal(fake.written, '');
  });

  it('maps a thread-less message to the General topic (threadId 1) for filtering', async () => {
    setTraceConfig({ allThreads: false, threadKeys: ['-100123:1'] });
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);

    traceRecvUpdate({ updateType: 'message', updateId: 2, chatId: -100123, preview: 'general' });
    fake.fireFlushTimer();
    await fake.settle();
    assert.equal(parseLines(fake.written).length, 1);
  });

  it('omits latencyMs when the update has no own timestamp (callbacks)', async () => {
    setTraceConfig({ allThreads: true, threadKeys: [] });
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);

    traceRecvUpdate({ updateType: 'callback_query', updateId: 43, chatId: -100123, threadId: 7, preview: 'effort_high' });
    fake.fireFlushTimer();
    await fake.settle();
    const entry = parseLines(fake.written)[0];
    assert.equal('latencyMs' in entry, false);
  });
});

describe('installCallApiTrace — send-path filtering', () => {
  it('does not trace when tracing is off', async () => {
    setTraceConfig({ allThreads: false, threadKeys: [] });
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);
    const host: CallApiHost = { callApi: async () => ({ message_id: 1 }) };
    installCallApiTrace(host);

    await host.callApi('sendMessage', { chat_id: -100123, message_thread_id: 7, text: 'hi' });
    fake.fireFlushTimer();
    await fake.settle();
    assert.equal(fake.written, '');
  });

  it('traces sendTry + sendOk for a traced thread and passes the result through', async () => {
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);
    const host: CallApiHost = { callApi: async () => ({ message_id: 99 }) };
    installCallApiTrace(host);

    const result = await host.callApi('sendMessage', {
      chat_id: -100123,
      message_thread_id: 7,
      text: 'hello world',
    });
    assert.deepEqual(result, { message_id: 99 });
    fake.fireFlushTimer();
    await fake.settle();

    const [tryEntry, okEntry] = parseLines(fake.written);
    assert.equal(tryEntry.kind, 'sendTry');
    assert.equal(tryEntry.chatId, -100123);
    assert.equal(tryEntry.threadId, 7);
    assert.equal(tryEntry.preview, 'hello world');
    assert.equal(okEntry.kind, 'sendOk');
    assert.equal(okEntry.resultMessageId, 99);
    assert.equal(typeof okEntry.durMs, 'number');
  });

  it('drops a send for a thread that is not traced', async () => {
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);
    const host: CallApiHost = { callApi: async () => true };
    installCallApiTrace(host);

    await host.callApi('sendMessage', { chat_id: -100123, message_thread_id: 999, text: 'nope' });
    fake.fireFlushTimer();
    await fake.settle();
    assert.equal(fake.written, '');
  });

  it('records a no-thread-id call (editMessageText) whenever ANY tracing is active', async () => {
    // Only thread 7 is traced (set, not all-flag). An edit payload carries no
    // chat_id / thread id — over-inclusion: it is still recorded.
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);
    const host: CallApiHost = { callApi: async () => ({ message_id: 5 }) };
    installCallApiTrace(host);

    await host.callApi('editMessageText', { message_id: 5, text: 'edited' });
    fake.fireFlushTimer();
    await fake.settle();

    const lines = parseLines(fake.written);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].kind, 'sendTry');
    assert.equal(lines[0].method, 'editMessageText');
    assert.equal(lines[0].messageId, 5);
  });

  it('traces sendErr with Telegram 429 details and rethrows', async () => {
    const fake = createFakeWriter();
    restoreWriter = configureTraceWriterForTests(fake.deps);
    const floodError = Object.assign(new Error('429: Too Many Requests'), {
      response: {
        error_code: 429,
        description: 'Too Many Requests: retry after 31',
        parameters: { retry_after: 31 },
      },
    });
    const host: CallApiHost = {
      callApi: async () => {
        throw floodError;
      },
    };
    installCallApiTrace(host);

    await assert.rejects(
      host.callApi('sendMessage', { chat_id: -100123, message_thread_id: 7, text: 'will fail' }),
      floodError,
    );
    fake.fireFlushTimer();
    await fake.settle();

    const errEntry = parseLines(fake.written)[1];
    assert.equal(errEntry.kind, 'sendErr');
    assert.equal(errEntry.errorCode, 429);
    assert.equal(errEntry.retryAfterSec, 31);
  });
});
