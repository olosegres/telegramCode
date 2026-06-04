/**
 * @description Resume context block must be posted ONLY on the explicit user
 * resume (`/sessions` pick) — never on the silent resume paths.
 *
 * Bug (user-caught live, 2026-06-04): the "↩️ Resumed — last N messages"
 * block was emitted unconditionally inside `resumeSessionInner`, which also
 * runs on `reattachExistingSessions` (EVERY bot restart, i.e. every hot
 * rebuild) and on opencode crash-recovery — so every rebuild spammed every
 * active topic with a context block.
 *
 * Fix: `ResumeSessionOptions.isWithRecentContext`, set only by the bot's
 * explicit-resume call site (`resumeSessionByIndex`).
 *
 * These tests drive the real `resumeSessionInner` with the harness style of
 * `openCodeCrashResume.test.ts` (fetch health stub, OPENCODE_BIN
 * short-circuit, private members via bracket access). Load-bearing: the
 * default (silent) resume must not even request the message history, and the
 * explicit resume must emit the rendered block.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

const key: ThreadKey = { chatId: -100778, threadId: 8 };
const sessionId = 'ses_resume_ctx_8';
const workDir = '/tmp/work-resume-ctx';
const healthPath = '/global/health';
const contextHeaderMark = '↩️';

let originalFetch: typeof fetch;
let originalOpencodeBin: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalOpencodeBin = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = '/usr/bin/true';
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith(healthPath)) {
      return new Response('ok', { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpencodeBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = originalOpencodeBin;
});

function createAdapter(): {
  adapter: OpenCodeAdapter;
  outputs: string[];
  messageHistoryRequests: string[];
} {
  const adapter = new OpenCodeAdapter();

  const messageHistoryRequests: string[] = [];
  adapter['apiRequest'] = (async (method: string, urlPath: string) => {
    if (method === 'GET' && urlPath === `/session/${sessionId}`) {
      return { id: sessionId };
    }
    if (method === 'GET' && urlPath === `/session/${sessionId}/message`) {
      messageHistoryRequests.push(urlPath);
      return [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'how do I deploy?' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'run the deploy script' }] },
      ];
    }
    if (urlPath.endsWith('/abort')) {
      return undefined;
    }
    throw new Error(`unexpected apiRequest in test: ${method} ${urlPath}`);
  }) as OpenCodeAdapter['apiRequest'];

  // Keep resume off the real network: no SSE stream, no /config model lookup.
  adapter['connectSse'] = (() => {}) as OpenCodeAdapter['connectSse'];
  adapter['fetchModelInfo'] = (async () => {}) as OpenCodeAdapter['fetchModelInfo'];

  const outputs: string[] = [];
  adapter.on('output', (_key: ThreadKey, text: string) => {
    outputs.push(text);
  });
  return { adapter, outputs, messageHistoryRequests };
}

describe('OpenCode resume context block gating', () => {
  it('silent resume (re-attach / crash-recovery — no options) emits NO context block and never reads history', async () => {
    const { adapter, outputs, messageHistoryRequests } = createAdapter();

    await adapter['resumeSessionInner'](key, workDir, sessionId);

    const session = adapter['sessions'].get(keyToString(key));
    assert.ok(session, 'session must be resumed');
    assert.equal(session.isActive, true, 'resumed session must be active');

    // Load-bearing for the user-reported spam: no block, and not even the
    // history request that would build it.
    const contextBlocks = outputs.filter((text) => text.includes(contextHeaderMark));
    assert.deepEqual(contextBlocks, [], `silent resume must not post the context block, got: ${JSON.stringify(outputs)}`);
    assert.deepEqual(messageHistoryRequests, [], 'silent resume must not request message history');
  });

  it('explicit resume (isWithRecentContext) posts the rendered last-N block', async () => {
    const { adapter, outputs, messageHistoryRequests } = createAdapter();

    await adapter['resumeSessionInner'](key, workDir, sessionId, { isWithRecentContext: true });

    assert.deepEqual(messageHistoryRequests, [`/session/${sessionId}/message`], 'explicit resume reads the history once');
    const contextBlocks = outputs.filter((text) => text.includes(contextHeaderMark));
    assert.equal(contextBlocks.length, 1, `explicit resume must post exactly one context block, got: ${JSON.stringify(outputs)}`);
    assert.ok(contextBlocks[0].includes('how do I deploy?'), 'block must contain the user turn');
    assert.ok(contextBlocks[0].includes('run the deploy script'), 'block must contain the assistant turn');
  });
});
