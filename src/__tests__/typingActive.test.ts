/**
 * @description S3 typing-active decision: the native typing state persists while
 * output is streaming OR the agent is busy, and clears only when both are false.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkShouldKeepTyping } from '../utils/typingActive';

test('typing keeps showing while output is streaming (even if the agent reads idle)', () => {
  assert.equal(checkShouldKeepTyping({ isOutputStreaming: true, isAdapterBusy: false }), true);
});

test('typing keeps showing while the agent is busy (even with nothing queued)', () => {
  assert.equal(checkShouldKeepTyping({ isOutputStreaming: false, isAdapterBusy: true }), true);
});

test('typing keeps showing while both hold', () => {
  assert.equal(checkShouldKeepTyping({ isOutputStreaming: true, isAdapterBusy: true }), true);
});

test('typing stops ONLY when the topic is truly drained AND idle', () => {
  assert.equal(checkShouldKeepTyping({ isOutputStreaming: false, isAdapterBusy: false }), false);
});
