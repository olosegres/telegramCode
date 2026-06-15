/**
 * @description Round-trip + rejection tests for the parameterized tmux
 * session-name codec (`utils/tmuxSessionName`), shared by the Claude (`claude-`)
 * and terminal (`term-`) backends. The careful negative-chatId handling and the
 * strict per-half regex were previously Claude-private; these tests pin the
 * shared contract so a foreign tmux session can never be mis-adopted as ours.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildTmuxSessionName, parseTmuxSessionName } from '../utils/tmuxSessionName';

test('tmuxSessionName: build/parse round-trips a positive key', () => {
  const key = { chatId: 12345, threadId: 67 };
  const name = buildTmuxSessionName('term', key);
  assert.equal(name, 'term-12345-67');
  assert.deepEqual(parseTmuxSessionName('term', name), key);
});

test('tmuxSessionName: round-trips a negative (forum supergroup) chatId', () => {
  const key = { chatId: -1001111111111, threadId: 434 };
  const name = buildTmuxSessionName('term', key);
  assert.equal(name, 'term--1001111111111-434');
  assert.deepEqual(parseTmuxSessionName('term', name), key);
});

test('tmuxSessionName: round-trips the claude prefix too (parity with the wrappers)', () => {
  const key = { chatId: -1001234, threadId: 42 };
  assert.equal(buildTmuxSessionName('claude', key), 'claude--1001234-42');
  assert.deepEqual(parseTmuxSessionName('claude', 'claude--1001234-42'), key);
});

test('tmuxSessionName: rejects a name owned by a different prefix', () => {
  // A claude session must not parse under the terminal prefix and vice-versa.
  assert.equal(parseTmuxSessionName('term', 'claude-12345-67'), null);
  assert.equal(parseTmuxSessionName('claude', 'term-12345-67'), null);
});

test('tmuxSessionName: rejects a foreign session sharing no prefix', () => {
  assert.equal(parseTmuxSessionName('term', 'my-dev-shell'), null);
  assert.equal(parseTmuxSessionName('term', 'term'), null);
  assert.equal(parseTmuxSessionName('term', 'term-'), null);
});

test('tmuxSessionName: rejects non-numeric / loosely-numeric halves', () => {
  // `Number(...)` would accept these; the strict per-half regex must not.
  assert.equal(parseTmuxSessionName('term', 'term-1e5-7'), null);
  assert.equal(parseTmuxSessionName('term', 'term-0x10-7'), null);
  assert.equal(parseTmuxSessionName('term', 'term-1.5-7'), null);
  assert.equal(parseTmuxSessionName('term', 'term-12345-1.0'), null);
  assert.equal(parseTmuxSessionName('term', 'term-12345-abc'), null);
  // A negative THREAD id is not allowed (threadId is always non-negative).
  assert.equal(parseTmuxSessionName('term', 'term-12345--7'), null);
});
