import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkIsOutputTraceEnabled,
  createTracePreview,
  installCallApiTrace,
  traceAgentEmit,
  traceRecvUpdate,
  type CallApiHost,
} from '../outputTrace';

const threadKey = { chatId: -100123, threadId: 7 };

let tempDataDir: string;
let savedDataDir: string | undefined;
let savedOutputTrace: string | undefined;

function getTraceFilePath(): string {
  return path.join(tempDataDir, 'output-trace.jsonl');
}

function readTraceEntries(): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(getTraceFilePath(), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-trace-test-'));
  savedDataDir = process.env.DATA_DIR;
  savedOutputTrace = process.env.OUTPUT_TRACE;
  process.env.DATA_DIR = tempDataDir;
  process.env.OUTPUT_TRACE = '1';
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDataDir;
  if (savedOutputTrace === undefined) delete process.env.OUTPUT_TRACE;
  else process.env.OUTPUT_TRACE = savedOutputTrace;
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

describe('outputTrace enable flag', () => {
  it('is disabled unless OUTPUT_TRACE=1, and writes nothing when off', () => {
    delete process.env.OUTPUT_TRACE;
    assert.equal(checkIsOutputTraceEnabled(), false);
    traceAgentEmit('output', threadKey, 'should not be written');
    assert.equal(fs.existsSync(getTraceFilePath()), false);
  });
});

describe('traceAgentEmit', () => {
  it('writes one JSONL entry with kind/event/key/len and a truncated preview', () => {
    const longText = 'x'.repeat(500);
    traceAgentEmit('output', threadKey, longText);

    const entries = readTraceEntries();
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.kind, 'emit');
    assert.equal(entry.event, 'output');
    assert.equal(entry.key, '-100123:7');
    assert.equal(entry.len, 500);
    assert.equal((entry.preview as string).length, 121); // 120 chars + ellipsis
    assert.equal(typeof entry.ts, 'string');
  });
});

describe('createTracePreview', () => {
  it('returns short text as-is and truncates long text with an ellipsis', () => {
    assert.equal(createTracePreview('short'), 'short');
    const truncated = createTracePreview('y'.repeat(300));
    assert.equal(truncated, `${'y'.repeat(120)}…`);
  });
});

describe('traceRecvUpdate', () => {
  it('records update fields and computes latencyMs from tgDateSec', () => {
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

    const entries = readTraceEntries();
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.kind, 'recv');
    assert.equal(entry.updateType, 'message');
    assert.equal(entry.updateId, 42);
    assert.equal(entry.preview, '/status');
    const latencyMs = entry.latencyMs as number;
    // ~5s ago, allow generous slack for slow CI.
    assert.ok(latencyMs >= 4000 && latencyMs < 60000, `latencyMs=${latencyMs}`);
  });

  it('omits latencyMs when the update has no own timestamp (callbacks)', () => {
    traceRecvUpdate({ updateType: 'callback_query', updateId: 43, preview: 'effort_high' });
    const entry = readTraceEntries()[0];
    assert.equal('latencyMs' in entry, false);
  });
});

describe('installCallApiTrace', () => {
  it('traces sendTry + sendOk around a successful call and passes the result through', async () => {
    const host: CallApiHost = {
      callApi: async () => ({ message_id: 99 }),
    };
    installCallApiTrace(host);

    const result = await host.callApi('sendMessage', {
      chat_id: -100123,
      message_thread_id: 7,
      text: 'hello world',
    });
    assert.deepEqual(result, { message_id: 99 });

    const entries = readTraceEntries();
    assert.equal(entries.length, 2);
    const [tryEntry, okEntry] = entries;
    assert.equal(tryEntry.kind, 'sendTry');
    assert.equal(tryEntry.method, 'sendMessage');
    assert.equal(tryEntry.chatId, -100123);
    assert.equal(tryEntry.threadId, 7);
    assert.equal(tryEntry.preview, 'hello world');
    assert.equal(okEntry.kind, 'sendOk');
    assert.equal(okEntry.resultMessageId, 99);
    assert.equal(typeof okEntry.durMs, 'number');
  });

  it('traces sendErr with Telegram error details and rethrows', async () => {
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
      host.callApi('sendMessage', { chat_id: -100123, text: 'will fail' }),
      floodError,
    );

    const entries = readTraceEntries();
    assert.equal(entries.length, 2);
    const errEntry = entries[1];
    assert.equal(errEntry.kind, 'sendErr');
    assert.equal(errEntry.errorCode, 429);
    assert.equal(errEntry.description, 'Too Many Requests: retry after 31');
    assert.equal(errEntry.retryAfterSec, 31);
  });

  it('keeps tracing per-attempt: two calls produce two try/outcome pairs', async () => {
    let callCount = 0;
    const host: CallApiHost = {
      callApi: async () => {
        callCount += 1;
        return true;
      },
    };
    installCallApiTrace(host);
    await host.callApi('answerCallbackQuery', { callback_query_id: 'abc' });
    await host.callApi('answerCallbackQuery', { callback_query_id: 'def' });

    assert.equal(callCount, 2);
    const entries = readTraceEntries();
    assert.equal(entries.length, 4);
    assert.equal(entries[0].callbackQueryId, 'abc');
    assert.equal(entries[2].callbackQueryId, 'def');
  });
});

describe('trace file rotation', () => {
  it('rolls an oversized trace file to .1 before appending', () => {
    const filePath = getTraceFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // One byte over the 10 MB cap.
    fs.writeFileSync(filePath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));

    traceAgentEmit('output', threadKey, 'after rotation');

    assert.ok(fs.existsSync(`${filePath}.1`), 'rotated backup should exist');
    const entries = readTraceEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].preview, 'after rotation');
  });
});
