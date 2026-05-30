/**
 * @description Plan §2026-05-30 tg-startup-prompt-buffer — prompts typed while
 * an agent session is booting must be (a) recognised as "buffer, don't drop",
 * (b) replayed in arrival order once ready, and (c) discarded on a failed
 * start. These load-bearing assertions guard the actual user-visible promise:
 * "I won't have to retype the message I sent during startup."
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { StartupPromptBuffer } from '../startupPromptBuffer';

const KEY_A = '100:1';
const KEY_B = '100:2';

test('not starting by default → text is not buffered', () => {
  const buffer = new StartupPromptBuffer();
  assert.equal(buffer.checkIsStarting(KEY_A), false);
});

test('markStarting opens the window; drain closes it', () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  assert.equal(buffer.checkIsStarting(KEY_A), true);
  buffer.drainPrompts(KEY_A);
  assert.equal(buffer.checkIsStarting(KEY_A), false);
});

test('prompts replay in FIFO arrival order', () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'first');
  buffer.addPrompt(KEY_A, 'second');
  buffer.addPrompt(KEY_A, 'third');
  assert.deepEqual(buffer.drainPrompts(KEY_A), ['first', 'second', 'third']);
});

test('drain clears the buffer — a second drain yields nothing (no double-send)', () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'only');
  assert.deepEqual(buffer.drainPrompts(KEY_A), ['only']);
  assert.deepEqual(buffer.drainPrompts(KEY_A), []);
});

test('addPrompt reports first-of-window once, then false (ack only once)', () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  assert.equal(buffer.addPrompt(KEY_A, 'a'), true);
  assert.equal(buffer.addPrompt(KEY_A, 'b'), false);
  assert.equal(buffer.addPrompt(KEY_A, 'c'), false);
});

test('a fresh startup window acks again after a drain', () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  assert.equal(buffer.addPrompt(KEY_A, 'a'), true);
  buffer.drainPrompts(KEY_A);

  buffer.markStarting(KEY_A);
  assert.equal(buffer.addPrompt(KEY_A, 'b'), true);
});

test('discard drops buffered prompts and closes the window (failed start)', () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  buffer.addPrompt(KEY_A, 'lost');
  buffer.discardPrompts(KEY_A);
  assert.equal(buffer.checkIsStarting(KEY_A), false);
  assert.deepEqual(buffer.drainPrompts(KEY_A), []);
});

test('threads are isolated — one thread\'s buffer never leaks into another', () => {
  const buffer = new StartupPromptBuffer();
  buffer.markStarting(KEY_A);
  buffer.markStarting(KEY_B);
  buffer.addPrompt(KEY_A, 'a-only');
  buffer.addPrompt(KEY_B, 'b-only');

  assert.deepEqual(buffer.drainPrompts(KEY_A), ['a-only']);
  // B untouched by A's drain.
  assert.equal(buffer.checkIsStarting(KEY_B), true);
  assert.deepEqual(buffer.drainPrompts(KEY_B), ['b-only']);
});
