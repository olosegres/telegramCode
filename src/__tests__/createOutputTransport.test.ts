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
 *    delegates to the bot-owned `finalizeGroupOutput` reconcile (S2 — no longer a
 *    noop), and a `both` group key routes there without double-finalizing the draft.
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
  /** Keys passed to the group-path `finalizeGroupOutput` (S2 delegation). */
  finalizeGroupOutput: ThreadKey[];
}

/**
 * @param supportsDraft  the per-thread draft-streaming gate stub.
 * @param outputsDeltas  whether the thread's adapter emits continuation-less deltas.
 * @param isDmKey  the per-chat discriminator the `both` dispatcher routes on
 *   (a function of the key so `both` can route different keys to different impls).
 */
function createStubDeps(
  supportsDraft: boolean,
  outputsDeltas = false,
  isDmKey: (key: ThreadKey) => boolean = () => false,
): { deps: OutputTransportDeps; calls: RecordedCalls } {
  const calls: RecordedCalls = {
    queueOutput: [],
    sendAgentChunks: [],
    feedDraft: [],
    finalizeDraft: 0,
    finalizeGroupOutput: [],
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
    checkIsDmKey(key) {
      return isDmKey(key);
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
    async finalizeGroupOutput(key) {
      calls.finalizeGroupOutput.push(key);
    },
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

test('group: finalizeInFlight delegates to finalizeGroupOutput (S2 reconcile, not a noop)', async () => {
  const { deps, calls } = createStubDeps(true);
  const transport = createOutputTransport('group', deps);
  await transport.finalizeInFlight(KEY);
  // The group transport no longer noops finalize — it delegates the reconcile to
  // the bot-owned drain so the final answer is force-delivered before teardown.
  assert.deepEqual(calls.finalizeGroupOutput, [KEY], 'group finalize must drive finalizeGroupOutput');
  // The transport itself never sends — the drain (and any redelivery) is the
  // delegate's job; the stub records the call without sending.
  assert.equal(calls.sendAgentChunks.length, 0, 'the transport itself does not send (delegate does)');
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

// ─── both — per-key dispatch (one instance, two surfaces) ────────────────
//
// In `both` the transport is a DISPATCHER: each per-thread call routes by
// `checkIsDmKey(key)` to the DM draft impl or the thin group impl. These tests
// prove a DM key drives the draft channel (NOT queueOutput) AND a group key
// drives queueOutput (NOT the draft channel) — concurrently, from one transport.

const OWNER_ID = 7000001;
const DM_KEY: ThreadKey = { chatId: OWNER_ID, threadId: 0 };
const GROUP_KEY: ThreadKey = { chatId: -1001234567890, threadId: 5 };
const isDmKeyByChatId = (key: ThreadKey): boolean => key.chatId === OWNER_ID;

test('both: a DM key routes deliverOutput to the draft path, not queueOutput', () => {
  const { deps, calls } = createStubDeps(/* supportsDraft */ true, false, isDmKeyByChatId);
  let draftSendAttempted = false;
  deps.callSendMessageDraft = async () => {
    draftSendAttempted = true;
    return undefined;
  };
  const transport = createOutputTransport('both', deps);
  transport.deliverOutput(DM_KEY, 'streaming tail', { isContinuation: false });
  assert.equal(draftSendAttempted, true, 'a DM key must drive the draft channel');
  assert.equal(calls.queueOutput.length, 0, 'a DM key must NOT hit queueOutput');
});

test('both: a group key routes deliverOutput to queueOutput, not the draft path', () => {
  const { deps, calls } = createStubDeps(/* supportsDraft */ true, false, isDmKeyByChatId);
  let draftSendAttempted = false;
  deps.callSendMessageDraft = async () => {
    draftSendAttempted = true;
    return undefined;
  };
  const transport = createOutputTransport('both', deps);
  transport.deliverOutput(GROUP_KEY, 'group line', { isContinuation: true, isFinal: true });
  assert.equal(calls.queueOutput.length, 1, 'a group key must hit queueOutput');
  assert.deepEqual(calls.queueOutput[0], {
    output: 'group line',
    isContinuation: true,
    isFinal: true,
    isComplete: false,
  });
  assert.equal(draftSendAttempted, false, 'a group key must NOT touch the draft channel');
});

test('both: the two surfaces are independent — a DM draft and a group send coexist', () => {
  const { deps, calls } = createStubDeps(/* supportsDraft */ true, false, isDmKeyByChatId);
  let dmDraftSends = 0;
  deps.callSendMessageDraft = async () => {
    dmDraftSends += 1;
    return undefined;
  };
  const transport = createOutputTransport('both', deps);
  transport.deliverOutput(GROUP_KEY, 'group line', { isContinuation: false });
  transport.deliverOutput(DM_KEY, 'dm tail', { isContinuation: false });
  assert.equal(calls.queueOutput.length, 1, 'the group leg used queueOutput once');
  assert.ok(dmDraftSends >= 1, 'the DM leg drove its own draft channel');
});

test('both: checkIsStreaming reports per key — DM draft active, group always false', () => {
  const { deps } = createStubDeps(/* supportsDraft */ true, /* outputsDeltas */ true, isDmKeyByChatId);
  deps.callSendMessageDraft = async () => undefined;
  const transport = createOutputTransport('both', deps);
  assert.equal(transport.checkIsStreaming(GROUP_KEY), false, 'group leg never reports streaming');
  assert.equal(transport.checkIsStreaming(DM_KEY), false, 'no DM draft yet → not streaming');
  transport.deliverOutput(DM_KEY, 'dm delta', { isContinuation: false });
  assert.equal(transport.checkIsStreaming(DM_KEY), true, 'an active DM draft reports streaming');
  assert.equal(transport.checkIsStreaming(GROUP_KEY), false, 'the group leg stays false meanwhile');
});

test('both: finalizeInFlight on a group key delegates to finalizeGroupOutput; disposeThread routes without throwing', async () => {
  const { deps, calls } = createStubDeps(/* supportsDraft */ true, false, isDmKeyByChatId);
  const transport = createOutputTransport('both', deps);
  await transport.finalizeInFlight(GROUP_KEY);
  // A group key routes to the group leg's S2 reconcile — NOT the DM draft and NOT
  // a noop. The dispatcher must not double-finalize: a DM key would finalize its
  // draft instead (covered by the DM tests), a group key only the group drain.
  assert.deepEqual(calls.finalizeGroupOutput, [GROUP_KEY], 'group-key finalize drives the group drain');
  assert.equal(calls.sendAgentChunks.length, 0, 'no draft finalize for a group key');
  assert.doesNotThrow(() => transport.disposeThread(GROUP_KEY));
  assert.doesNotThrow(() => transport.disposeThread(DM_KEY));
});

test('both: finalizeInFlight on a DM key finalizes the draft, NOT the group drain (no double-finalize)', async () => {
  const { deps, calls } = createStubDeps(/* supportsDraft */ true, /* outputsDeltas */ true, isDmKeyByChatId);
  deps.callSendMessageDraft = async () => undefined;
  const transport = createOutputTransport('both', deps);
  // Open a DM draft turn, then finalize it.
  transport.deliverOutput(DM_KEY, 'dm answer', { isContinuation: false });
  await transport.finalizeInFlight(DM_KEY);
  await new Promise((resolve) => setImmediate(resolve));
  // The DM leg finalized its draft to a permanent message; the group drain was
  // never invoked for a DM key (the dispatcher routes per key — no double-finalize).
  assert.equal(calls.finalizeGroupOutput.length, 0, 'a DM key must NOT trigger the group drain');
  assert.deepEqual(calls.sendAgentChunks, [['dm answer']], 'the DM draft finalized to a permanent message');
});
