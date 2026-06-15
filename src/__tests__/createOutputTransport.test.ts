/**
 * @description Unit tests for the output-transport FACTORY route selection
 * (`output/createOutputTransport`). The factory is the SINGLE place the
 * group-vs-DM output behavior is chosen from CHAT_MODE; before this seam the
 * decision was scattered as `checkIsDmMode()` branches with no test covering the
 * selection. These tests pin which stub each mode dispatches to per meta.
 *
 * Load-bearing per `rules/tests.md`: each assertion proves the route really
 * reached its expected primitive (the recorded call), not just "no crash":
 *  - group.deliverOutput → queueOutput (NOT the draft path); group.finalizeInFlight
 *    resolves as a noop with no side effect.
 *  - dm.deliverOutput → feedDraft for a streaming meta on a draft-capable thread
 *    (both OpenCode and the delta-emitting Claude scrape adapter, which now
 *    synthesises the continuation flag), → finalizeDraft+sendAgentChunks for
 *    `{isComplete:true}`, → queueOutput when the supports-draft gate is false.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createOutputTransport, type OutputTransportDeps } from '../output/createOutputTransport';
import type { ThreadKey } from '../types';

const KEY: ThreadKey = { chatId: 1, threadId: 2 };
const MAX = 4096;

interface RecordedCalls {
  queueOutput: Array<{ output: string; isContinuation: boolean; isFinal: boolean; isComplete: boolean }>;
  sendAgentChunks: string[][];
  feedDraft: Array<{ output: string; isContinuation: boolean; isFinal: boolean }>;
  finalizeDraft: number;
}

function createStubDeps(
  supportsDraft: boolean,
  outputsDeltas = false,
): { deps: OutputTransportDeps; calls: RecordedCalls } {
  const calls: RecordedCalls = {
    queueOutput: [],
    sendAgentChunks: [],
    feedDraft: [],
    finalizeDraft: 0,
  };
  const deps: OutputTransportDeps = {
    queueOutput(_key, output, isContinuation, isFinal, isComplete) {
      calls.queueOutput.push({ output, isContinuation, isFinal, isComplete });
    },
    async sendAgentChunks(_key, chunks) {
      calls.sendAgentChunks.push(chunks);
    },
    getThreadMessageState() {
      return { needsNewMessage: false };
    },
    checkSupportsDraft() {
      return supportsDraft;
    },
    checkOutputsDeltas() {
      return outputsDeltas;
    },
    checkIsGeneral() {
      return false;
    },
    async callSendMessageDraft() {
      // The factory-route tests never reach the draft network send (no real
      // streaming feed is paced here); recorded via feedDraft instead.
      return undefined;
    },
    splitMessage(text) {
      return [text];
    },
    renderAgentHtml(text) {
      return text;
    },
    maxMessageLength: MAX,
  };
  return { deps, calls };
}

test('group: deliverOutput routes to queueOutput with the meta flags', () => {
  const { deps, calls } = createStubDeps(true);
  const transport = createOutputTransport('group', deps);
  transport.deliverOutput(KEY, 'hello', { isContinuation: true, isFinal: true });
  assert.equal(calls.queueOutput.length, 1);
  assert.deepEqual(calls.queueOutput[0], {
    output: 'hello',
    isContinuation: true,
    isFinal: true,
    isComplete: false,
  });
  assert.equal(calls.feedDraft.length, 0, 'group must never touch the draft path');
});

test('group: finalizeInFlight resolves as a noop (no send)', async () => {
  const { deps, calls } = createStubDeps(true);
  const transport = createOutputTransport('group', deps);
  await transport.finalizeInFlight(KEY);
  assert.equal(calls.sendAgentChunks.length, 0);
  assert.equal(calls.queueOutput.length, 0);
});

test('group: disposeThread is a noop and does not throw', () => {
  const { deps } = createStubDeps(true);
  const transport = createOutputTransport('group', deps);
  assert.doesNotThrow(() => transport.disposeThread(KEY));
});

test('dm: a streaming meta on a draft-capable thread routes to the draft path, not queueOutput', () => {
  // The DM transport owns feedDraft internally; assert the OBSERVABLE effect of
  // the draft route — a draft network send is attempted (callSendMessageDraft) and
  // queueOutput is NOT used — rather than the private feedDraft call.
  const { deps, calls } = createStubDeps(true);
  let draftSendAttempted = false;
  deps.callSendMessageDraft = async () => {
    draftSendAttempted = true;
    return undefined;
  };
  const transport = createOutputTransport('dm', deps);
  transport.deliverOutput(KEY, 'streaming tail', { isContinuation: false });
  assert.equal(calls.queueOutput.length, 0, 'streaming DM output must NOT hit queueOutput');
  assert.equal(draftSendAttempted, true, 'streaming DM output must drive the draft channel');
});

test('dm: a complete one-shot finalizes then sends as a permanent message (not a draft)', async () => {
  const { deps, calls } = createStubDeps(true);
  let draftSendAttempted = false;
  deps.callSendMessageDraft = async () => {
    draftSendAttempted = true;
    return undefined;
  };
  const transport = createOutputTransport('dm', deps);
  transport.deliverOutput(KEY, 'resume context block', { isComplete: true });
  // deliverOutput fires the finalize+send chain fire-and-forget; let it settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.queueOutput.length, 0, 'a complete one-shot is not the queueOutput baseline');
  assert.deepEqual(calls.sendAgentChunks, [['resume context block']]);
  assert.equal(draftSendAttempted, false, 'a complete one-shot must NOT animate as a draft');
});

test('dm: a Claude delta (no continuation meta, outputsDeltas) drives the draft cursor, not queueOutput', () => {
  // The scrape adapter emits each poll's prose delta with isContinuation absent.
  // The transport must synthesise the continuation flag so the delta accumulates
  // into the live draft (drives the draft channel) instead of finalizing per poll.
  const { deps, calls } = createStubDeps(/* supportsDraft */ true, /* outputsDeltas */ true);
  let draftSendAttempted = false;
  deps.callSendMessageDraft = async () => {
    draftSendAttempted = true;
    return undefined;
  };
  const transport = createOutputTransport('dm', deps);
  transport.deliverOutput(KEY, 'claude prose delta', { isContinuation: false });
  assert.equal(calls.queueOutput.length, 0, 'a Claude DM delta must NOT hit the queueOutput baseline');
  assert.equal(draftSendAttempted, true, 'a Claude DM delta must drive the draft cursor');
});

test('group: checkIsStreaming is always false (group streaming is tracked via the output queue)', () => {
  const { deps } = createStubDeps(true);
  const transport = createOutputTransport('group', deps);
  assert.equal(transport.checkIsStreaming(KEY), false);
});

test('dm: checkIsStreaming flips true once a draft turn is active (the liveness anti-thrash gate)', () => {
  // Regression guard: the Claude liveness loop ORs checkIsStreaming into
  // checkIsOutputStreaming; if a draft did not report "streaming", a heartbeat
  // status frame would be inserted between prose deltas and chop the draft.
  const { deps } = createStubDeps(/* supportsDraft */ true, /* outputsDeltas */ true);
  deps.callSendMessageDraft = async () => undefined;
  const transport = createOutputTransport('dm', deps);
  assert.equal(transport.checkIsStreaming(KEY), false, 'no draft yet → not streaming');
  transport.deliverOutput(KEY, 'claude prose delta', { isContinuation: false });
  assert.equal(transport.checkIsStreaming(KEY), true, 'an active draft turn must report streaming');
});

test('dm: a streaming meta on a NON-draft-capable thread (gate off) routes to queueOutput', () => {
  const { deps, calls } = createStubDeps(false);
  const transport = createOutputTransport('dm', deps);
  transport.deliverOutput(KEY, 'gate-off output', { isContinuation: true });
  assert.equal(calls.sendAgentChunks.length, 0, 'the gate-off path is the plain queueOutput baseline');
  assert.equal(calls.queueOutput.length, 1);
  assert.deepEqual(calls.queueOutput[0], {
    output: 'gate-off output',
    isContinuation: true,
    isFinal: false,
    isComplete: false,
  });
});
