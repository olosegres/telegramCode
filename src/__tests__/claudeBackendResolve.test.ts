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
  parseClaudeBackendArg,
  getClaudeModeAction,
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

// ── /claude_mode decision (live bug 2026-07-06, topic 9085) ─────────────────
//
// With DEFAULT_AGENT=claude in the operator env, a NO-pick thread's
// threadAdapterName is 'claude' (the legacy fallback) while the EFFECTIVE
// Claude backend (what `/claude` would start) is json-stream. The old handler
// compared the requested backend against threadAdapterName, so the first
// `/claude_mode tmux` replied "already tmux-scrape" without persisting.

test('parseClaudeBackendArg: json aliases → json-stream, tmux aliases → claude, else null', () => {
  for (const alias of ['json', 'jsonstream', 'json-stream', 'stream']) {
    assert.equal(parseClaudeBackendArg(alias), claudeJsonStreamAdapterName, alias);
  }
  for (const alias of ['tmux', 'scrape', 'terminal', 'classic']) {
    assert.equal(parseClaudeBackendArg(alias), 'claude', alias);
  }
  assert.equal(parseClaudeBackendArg(''), null);
  assert.equal(parseClaudeBackendArg('bogus'), null);
});

test('getClaudeModeAction: fresh thread under DEFAULT_AGENT=claude + tmux request → SWITCH (the bug)', () => {
  const action = getClaudeModeAction({
    threadAdapterName: 'claude', // no pick; legacy DEFAULT_AGENT fallback
    effectiveBackendName: claudeJsonStreamAdapterName, // what /claude would start
    requestedBackendName: 'claude',
  });
  assert.deepEqual(action, { kind: 'switch', backendName: 'claude' });
});

test('getClaudeModeAction: fresh thread + json request → already (json IS the effective default)', () => {
  const action = getClaudeModeAction({
    threadAdapterName: claudeJsonStreamAdapterName,
    effectiveBackendName: claudeJsonStreamAdapterName,
    requestedBackendName: claudeJsonStreamAdapterName,
  });
  assert.deepEqual(action, { kind: 'already', backendName: claudeJsonStreamAdapterName });
});

test('getClaudeModeAction: explicit tmux pick + tmux request → already; + json request → switch', () => {
  const base = { threadAdapterName: 'claude', effectiveBackendName: 'claude' };
  assert.deepEqual(
    getClaudeModeAction({ ...base, requestedBackendName: 'claude' }),
    { kind: 'already', backendName: 'claude' },
  );
  assert.deepEqual(
    getClaudeModeAction({ ...base, requestedBackendName: claudeJsonStreamAdapterName }),
    { kind: 'switch', backendName: claudeJsonStreamAdapterName },
  );
});

test('getClaudeModeAction: opencode/terminal topics are gated to notClaude', () => {
  for (const name of ['opencode', 'terminal']) {
    const action = getClaudeModeAction({
      threadAdapterName: name,
      effectiveBackendName: claudeJsonStreamAdapterName,
      requestedBackendName: 'claude',
    });
    assert.deepEqual(action, { kind: 'notClaude' }, name);
  }
});

test('getClaudeModeAction: bare command → picker with the EFFECTIVE backend as current (✓ target)', () => {
  // Fresh thread under DEFAULT_AGENT=claude: the picker's ✓ must sit on
  // json-stream (what /claude would open), not on the legacy fallback name.
  const action = getClaudeModeAction({
    threadAdapterName: 'claude',
    effectiveBackendName: claudeJsonStreamAdapterName,
    requestedBackendName: null,
  });
  assert.deepEqual(action, { kind: 'picker', currentBackendName: claudeJsonStreamAdapterName });
});
