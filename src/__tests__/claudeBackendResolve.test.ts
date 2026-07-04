/**
 * @description Unit tests for Claude Code backend resolution: json-stream is the
 * DEFAULT, and a thread can hold an explicit tmux-scrape pick that is honoured.
 * Covers getDefaultAdapterName / checkIsClaudeBackend / resolveClaudeBackendName
 * (the /claude_mode per-topic switch + default-json-stream behavior).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getDefaultAdapterName,
  checkIsClaudeBackend,
  resolveClaudeBackendName,
  setThreadAdapter,
} from '../adapters/createAdapter';
import { claudeJsonStreamAdapterName } from '../adapters/claudeJsonStreamAdapter';
import type { ThreadKey } from '../types';

const key = (threadId: number): ThreadKey => ({ chatId: -100, threadId });

test('default adapter is json-stream Claude (DEFAULT_AGENT unset)', () => {
  delete process.env.DEFAULT_AGENT;
  assert.equal(getDefaultAdapterName(), claudeJsonStreamAdapterName);
});

test('checkIsClaudeBackend: both Claude backends true, others false', () => {
  assert.equal(checkIsClaudeBackend('claude'), true);
  assert.equal(checkIsClaudeBackend(claudeJsonStreamAdapterName), true);
  assert.equal(checkIsClaudeBackend('opencode'), false);
  assert.equal(checkIsClaudeBackend('terminal'), false);
});

test('resolveClaudeBackendName: no pick → json-stream default', () => {
  assert.equal(resolveClaudeBackendName(key(1)), claudeJsonStreamAdapterName);
});

test('resolveClaudeBackendName: an explicit tmux pick is honoured', () => {
  const k = key(2);
  setThreadAdapter(k, 'claude');
  assert.equal(resolveClaudeBackendName(k), 'claude');
});

test('resolveClaudeBackendName: an explicit json-stream pick is kept', () => {
  const k = key(3);
  setThreadAdapter(k, claudeJsonStreamAdapterName);
  assert.equal(resolveClaudeBackendName(k), claudeJsonStreamAdapterName);
});

test('resolveClaudeBackendName: a non-Claude pick falls to the json-stream default', () => {
  const k = key(4);
  setThreadAdapter(k, 'opencode');
  assert.equal(resolveClaudeBackendName(k), claudeJsonStreamAdapterName);
});
