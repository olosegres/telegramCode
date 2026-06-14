/**
 * @description Streaming-append flush planning (Bug A — overwrite).
 *
 * Bug: OpenCode streams a long reply as incremental tails; the bot edited the
 * SAME Telegram message with ONLY the newest tail each flush, so every edit
 * replaced everything before it and the user could read only the last tail.
 *
 * Fix: a continuation tail is APPENDED to the text already rendered into the
 * last message and the FULL combined text is re-chunked; only when the batch
 * is a real continuation AND the last message is still editable does the first
 * chunk re-edit in place.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`): assert the combined text
 * actually covers `lastMessageText + output` (not just "no crash"), that a
 * mid-word continuation tail joins SEAMLESSLY (no inserted whitespace), and
 * that any blocker (fresh output / forced new message / missing id or text)
 * sends fresh instead of clobbering the previous message.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getOutputFlushPlan, appendPendingOutput } from '../utils/outputFlushPlan';
import { MAX_MESSAGE_LEN, splitMessage } from '../messageSplit';

describe('getOutputFlushPlan', () => {
  it('fresh output (not a continuation) → no edit, chunks = splitMessage(output)', () => {
    const plan = getOutputFlushPlan({
      output: 'A brand new answer.',
      isContinuation: false,
      needsNewMessage: false,
      lastMessageId: 123,
      lastMessageText: 'previous message',
    });
    assert.equal(plan.shouldEditFirstChunk, false);
    assert.deepEqual(plan.chunks, splitMessage('A brand new answer.'));
    // The previous message text must NOT be part of the plan for a fresh output.
    assert.ok(!plan.chunks[0].includes('previous message'));
  });

  it('continuation with an editable last message → edit first chunk; combined text covers lastMessageText + output', () => {
    const plan = getOutputFlushPlan({
      output: ' and the tail.',
      isContinuation: true,
      needsNewMessage: false,
      lastMessageId: 55,
      lastMessageText: 'The head',
    });
    assert.equal(plan.shouldEditFirstChunk, true);
    // Combined, in order, no separator inserted between base and tail.
    assert.equal(plan.chunks.join(''), 'The head and the tail.');
    assert.equal(plan.chunks[0], 'The head and the tail.');
  });

  it('continuation but needsNewMessage forces a break → fresh send, no edit', () => {
    const plan = getOutputFlushPlan({
      output: 'tail',
      isContinuation: true,
      needsNewMessage: true,
      lastMessageId: 55,
      lastMessageText: 'head',
    });
    assert.equal(plan.shouldEditFirstChunk, false);
    assert.deepEqual(plan.chunks, ['tail']);
    assert.ok(!plan.chunks[0].includes('head'));
  });

  it('continuation but no last message id → fresh send, no edit', () => {
    const plan = getOutputFlushPlan({
      output: 'tail',
      isContinuation: true,
      needsNewMessage: false,
      lastMessageId: null,
      lastMessageText: 'head',
    });
    assert.equal(plan.shouldEditFirstChunk, false);
    assert.deepEqual(plan.chunks, ['tail']);
  });

  it('continuation but no last message text → fresh send, no edit', () => {
    const plan = getOutputFlushPlan({
      output: 'tail',
      isContinuation: true,
      needsNewMessage: false,
      lastMessageId: 55,
      lastMessageText: null,
    });
    assert.equal(plan.shouldEditFirstChunk, false);
    assert.deepEqual(plan.chunks, ['tail']);
  });

  it('combined text over the Telegram cap → multiple chunks: first edits, the rest send new', () => {
    // No newlines, so splitMessage cuts at exactly MAX_MESSAGE_LEN.
    const base = 'b'.repeat(3000);
    const tail = 't'.repeat(2000);
    const plan = getOutputFlushPlan({
      output: tail,
      isContinuation: true,
      needsNewMessage: false,
      lastMessageId: 55,
      lastMessageText: base,
    });
    assert.equal(plan.shouldEditFirstChunk, true);
    assert.ok(plan.chunks.length >= 2, 'combined 5000 chars must span multiple chunks');
    // No chunk exceeds the cap.
    for (const chunk of plan.chunks) {
      assert.ok(chunk.length <= MAX_MESSAGE_LEN, `chunk length ${chunk.length} <= ${MAX_MESSAGE_LEN}`);
    }
    // The full combined text is preserved across chunks (each char once).
    assert.equal(plan.chunks.join('').length, base.length + tail.length);
    assert.equal(plan.chunks.join(''), base + tail);
  });
});

describe('appendPendingOutput', () => {
  it('null pending → returns output unchanged (continuation flag ignored)', () => {
    assert.equal(appendPendingOutput(null, 'hello', true), 'hello');
    assert.equal(appendPendingOutput(null, 'hello', false), 'hello');
  });

  it('continuation → raw concat, NO separator: a mid-word tail joins seamlessly', () => {
    // The streamed tail was cut mid-word ("import" + "ant"); a '\n' here would
    // corrupt the word, so continuation must concatenate raw.
    assert.equal(appendPendingOutput('import', 'ant feature', true), 'important feature');
  });

  it('non-continuation → joins with a blank line \\n\\n (distinct logical messages read as paragraphs)', () => {
    assert.equal(appendPendingOutput('first message', 'second message', false), 'first message\n\nsecond message');
  });
});
