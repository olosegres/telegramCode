/**
 * @description Unit coverage for the discrete-message send service behind the
 * `send_messages_to_user` MCP tool: each input string is delivered as its OWN
 * message (never merged), an over-long input is split defensively, blank inputs
 * are skipped, a target-resolution failure short-circuits, and cancellation
 * stops between messages.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createSendMessagesToThread,
  type SendMessagesToThreadDeps,
} from '../utils/messageSendService';

interface Recorder {
  sent: string[];
  targets: string[];
}

function createService(
  overrides: Partial<SendMessagesToThreadDeps<string>> = {},
): { service: ReturnType<typeof createSendMessagesToThread<string>>; recorder: Recorder } {
  const recorder: Recorder = { sent: [], targets: [] };
  const service = createSendMessagesToThread<string>({
    resolveTarget: (threadKey) => ({ ok: true, target: threadKey }),
    sendChunk: async (target, chunk) => {
      recorder.targets.push(target);
      recorder.sent.push(chunk);
      return true;
    },
    maxMessageLength: 10,
    measureRendered: (chunk) => chunk.length,
    ...overrides,
  });
  return { service, recorder };
}

test('sends each input string as its own message, in order', async () => {
  const { service, recorder } = createService();
  const result = await service('-100:1', { messages: ['first', 'second', 'third'] });
  assert.deepEqual(recorder.sent, ['first', 'second', 'third']);
  assert.deepEqual(recorder.targets, ['-100:1', '-100:1', '-100:1']);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.summary, 'Delivered 3 messages to the topic.');
});

test('never merges two distinct short inputs into one message', async () => {
  const { service, recorder } = createService();
  await service('-100:1', { messages: ['a', 'b'] });
  // Both are far under the cap, yet stay separate — the anti-glue guarantee.
  assert.equal(recorder.sent.length, 2);
});

test('splits a single over-long input into multiple messages', async () => {
  const { service, recorder } = createService();
  // 25 chars, cap 10 → three chunks (10 / 10 / 5), all delivered separately.
  const long = 'x'.repeat(25);
  const result = await service('-100:1', { messages: [long] });
  assert.equal(recorder.sent.length, 3);
  assert.equal(recorder.sent.join(''), long);
  assert.equal(result.ok && result.summary, 'Delivered 3 messages to the topic.');
});

test('skips a blank (whitespace-only) input without posting an empty bubble', async () => {
  const { service, recorder } = createService();
  const result = await service('-100:1', { messages: ['real', '   ', 'also real'] });
  assert.deepEqual(recorder.sent, ['real', 'also real']);
  assert.equal(result.ok && result.summary, 'Delivered 2 messages to the topic.');
});

test('singular summary for a single delivered message', async () => {
  const { service } = createService();
  const result = await service('-100:1', { messages: ['solo'] });
  assert.equal(result.ok && result.summary, 'Delivered 1 message to the topic.');
});

test('total send failure returns an error, not a false success', async () => {
  const { service } = createService({ sendChunk: async () => false });
  const result = await service('-100:1', { messages: ['a', 'b'] });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : '', /Failed to deliver any message/);
});

test('partial send failure stays ok but reports the landed/attempted split', async () => {
  let calls = 0;
  const { service } = createService({
    // First message lands, second fails.
    sendChunk: async () => {
      calls += 1;
      return calls === 1;
    },
  });
  const result = await service('-100:1', { messages: ['a', 'b'] });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.summary, 'Delivered 1 of 2 messages to the topic (1 failed to send).');
});

test('a target-resolution failure short-circuits before any send', async () => {
  const { service, recorder } = createService({
    resolveTarget: () => ({ ok: false, error: 'invalid threadKey "bad"' }),
  });
  const result = await service('bad', { messages: ['x', 'y'] });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, 'invalid threadKey "bad"');
  assert.equal(recorder.sent.length, 0);
});

test('an already-aborted signal delivers nothing', async () => {
  const { service, recorder } = createService();
  const controller = new AbortController();
  controller.abort();
  const result = await service('-100:1', { messages: ['x', 'y'], signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, 'cancelled after delivering 0 message(s)');
  assert.equal(recorder.sent.length, 0);
});

test('cancellation between messages stops further delivery', async () => {
  const controller = new AbortController();
  const recorder: Recorder = { sent: [], targets: [] };
  const service = createSendMessagesToThread<string>({
    resolveTarget: (threadKey) => ({ ok: true, target: threadKey }),
    sendChunk: async (_target, chunk) => {
      recorder.sent.push(chunk);
      // Abort right after the first message lands; the loop must stop before the second.
      controller.abort();
      return true;
    },
    maxMessageLength: 10,
    measureRendered: (chunk) => chunk.length,
  });
  const result = await service('-100:1', {
    messages: ['first', 'second'],
    signal: controller.signal,
  });
  assert.deepEqual(recorder.sent, ['first']);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, 'cancelled after delivering 1 message(s)');
});
