/**
 * @description B4 — OpenCode must not duplicate the full response text.
 *
 * Bug: `handleTextDelta` accumulates `currentResponseText` and, after a 500ms
 * debounce, emitted the WHOLE accumulated text as an `output` event;
 * `flushOutput` (on `session.idle` / message-finish) re-emitted the same full
 * text. When the gap between the last delta and idle exceeded the debounce,
 * the full response reached Telegram twice.
 *
 * Fix: track `lastEmittedLength` and emit only the unsent tail in both places.
 *
 * These tests drive the REAL adapter event path: synthesized SSE JSON is fed
 * through `handleSseData` (the same entry the live `/global/event` reader
 * uses), `output` events (text + `meta`) are captured off the adapter
 * EventEmitter, and the 500ms debounce is advanced with `node:test` mock timers.
 *
 * Bot merge semantics (see `bot.ts` `queueOutput` / `appendPendingOutput`):
 * the FIRST tail of a response is a standalone `output`; every later tail
 * carries `meta.isContinuation === true` and the bot CONCATENATES it raw (no
 * separator) onto the message it is already rendering — so the tails
 * reconstruct the full response exactly once, with no inserted whitespace that
 * would corrupt a mid-word cut.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type OutputEventMeta, type ThreadKey } from '../types';

const sseOutputBatchMs = 500;
const ownSessionId = 'ses_own';
const key: ThreadKey = { chatId: -100123, threadId: 42 };

/** Build a minimal-but-complete live session and inject it into the adapter. */
function createAdapterWithSession(): {
  adapter: OpenCodeAdapter;
  outputs: string[];
  metas: (OutputEventMeta | undefined)[];
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
    isModelInfoShown: true,
    modelOverride: null,
    currentModelLabel: 'anthropic/claude',
    partTypes: new Map(),
    statusDebounceTimer: null,
    pendingStatus: null,
    pendingQuestion: null,
    effortLevel: null,
    isBusy: true,
    isCompacting: false,
    busyChildSessionIds: new Set(),
    sseController: null,
    reconnectTimer: null,
    sseStallTimer: null,
  };
  // sessions / handleSseData are private; tests are excluded from tsconfig and
  // run via tsx (type-stripping), so bracket access is runtime-only and does
  // not affect `yarn typecheck`.
  adapter['sessions'].set(keyToString(key), session);

  const outputs: string[] = [];
  const metas: (OutputEventMeta | undefined)[] = [];
  adapter.on('output', (_key: ThreadKey, text: string, meta?: OutputEventMeta) => {
    outputs.push(text);
    metas.push(meta);
  });
  return { adapter, outputs, metas };
}

/** Feed one `message.part.delta` text event through the real SSE dispatcher. */
function feedTextDelta(adapter: OpenCodeAdapter, delta: string): void {
  adapter['handleSseData'](
    key,
    JSON.stringify({
      type: 'message.part.delta',
      properties: { sessionID: ownSessionId, messageID: 'msg_1', partID: 'prt_1', field: 'text', delta },
    }),
  );
}

/** Feed a `session.idle` event (the second emit site, via flushOutput). */
function feedSessionIdle(adapter: OpenCodeAdapter): void {
  adapter['handleSseData'](
    key,
    JSON.stringify({
      type: 'session.idle',
      properties: { sessionID: ownSessionId },
    }),
  );
}

describe('OpenCode output dedup (B4)', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('deltas then idle within the debounce window → ONE emit with the full text', () => {
    const { adapter, outputs } = createAdapterWithSession();

    feedTextDelta(adapter, 'Hello ');
    feedTextDelta(adapter, 'world');
    // idle arrives BEFORE the 500ms debounce fires → flushOutput emits, and the
    // pending debounce (cancelled by flushOutput) must not produce a 2nd emit.
    feedSessionIdle(adapter);
    mock.timers.tick(sseOutputBatchMs + 50);

    assert.deepEqual(outputs, ['Hello world']);
  });

  it('debounce fires (emit #1), MORE deltas, idle → emit #2 is ONLY the new tail with isContinuation; raw concat == full text once', () => {
    const { adapter, outputs, metas } = createAdapterWithSession();

    feedTextDelta(adapter, 'First paragraph. ');
    // Debounce fires → emit #1 carries the text so far (first tail, not a continuation).
    mock.timers.tick(sseOutputBatchMs + 1);
    assert.deepEqual(outputs, ['First paragraph. ']);
    assert.equal(metas[0]?.isContinuation, false, 'first tail of a response is NOT a continuation');

    feedTextDelta(adapter, 'Second paragraph.');
    feedSessionIdle(adapter);
    mock.timers.tick(sseOutputBatchMs + 1);

    // emit #2 must be ONLY the new tail, never the whole accumulated text.
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0], 'First paragraph. ');
    assert.equal(outputs[1], 'Second paragraph.');

    // emit #2 is a continuation → the bot appends it RAW (no separator).
    assert.equal(metas[1]?.isContinuation, true, 'a later tail of the same response IS a continuation');

    // Raw concat (bot's append semantics) reconstructs the full response —
    // each paragraph exactly once, with no inserted separator.
    assert.equal(outputs.join(''), 'First paragraph. Second paragraph.');
    assert.equal(outputs.filter(chunk => chunk.includes('First paragraph')).length, 1);
    assert.equal(outputs.filter(chunk => chunk.includes('Second paragraph')).length, 1);
  });

  it('debounce fires, NO more deltas, idle → NO second emit (the duplicate case)', () => {
    const { adapter, outputs } = createAdapterWithSession();

    feedTextDelta(adapter, 'Only paragraph, fully streamed before idle.');
    // Debounce fires first (the common case: step-finish bookkeeping delays
    // session.idle past the 500ms window) → emit #1 = the whole text.
    mock.timers.tick(sseOutputBatchMs + 1);
    assert.deepEqual(outputs, ['Only paragraph, fully streamed before idle.']);

    // idle arrives later with NO new deltas. On the buggy code flushOutput
    // re-emitted the same full text → a 2nd identical emit. With the fix the
    // tail is empty, so nothing is emitted.
    feedSessionIdle(adapter);

    assert.equal(outputs.length, 1, 'flushOutput must not re-emit already-sent text');
  });

  it('a fresh prompt resets the emit cursor so the next response streams from scratch', () => {
    const { adapter, outputs } = createAdapterWithSession();

    feedTextDelta(adapter, 'Answer one.');
    mock.timers.tick(sseOutputBatchMs + 1);
    feedSessionIdle(adapter);
    assert.deepEqual(outputs, ['Answer one.']);

    // Simulate the prompt-send reset (sendPromptAsync zeroes both fields).
    const session = adapter['sessions'].get(keyToString(key));
    session.currentResponseText = '';
    session.lastEmittedLength = 0;

    feedTextDelta(adapter, 'Answer two.');
    mock.timers.tick(sseOutputBatchMs + 1);
    assert.deepEqual(outputs, ['Answer one.', 'Answer two.']);
  });
});
