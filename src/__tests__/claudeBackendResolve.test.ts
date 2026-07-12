/**
 * @description Unit tests for Claude Code backend resolution: tmux-scrape is
 * the DEFAULT (temporarily — json-stream cannot host `/login` yet; see plan
 * 2026-07-11-jsonstream-login-outofband-auth), and a thread can hold an
 * explicit json-stream pick that is honoured.
 * Covers getDefaultClaudeBackendName / checkIsClaudeBackend / resolveClaudeBackendName
 * / getThreadAdapterNameRaw (the /claude_mode per-topic switch + default-backend
 * behavior; the default is confined to the Claude-backend resolver — a no-pick
 * thread's raw name stays `undefined`, never silently 'claude').
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getDefaultClaudeBackendName,
  checkIsClaudeBackend,
  resolveClaudeBackendName,
  getThreadAdapterNameRaw,
  setThreadAdapter,
  parseClaudeBackendArg,
  getClaudeModeAction,
} from '../adapters/createAdapter';
import { claudeJsonStreamAdapterName } from '../adapters/claudeJsonStreamAdapter';
import type { ThreadKey } from '../types';

const key = (threadId: number): ThreadKey => ({ chatId: -100, threadId });

test('default Claude backend is tmux-scrape', () => {
  assert.equal(getDefaultClaudeBackendName(), 'claude');
});

test('getThreadAdapterNameRaw: no pick → undefined (never silently the default agent)', () => {
  assert.equal(getThreadAdapterNameRaw(key(20)), undefined);
});

test('getThreadAdapterNameRaw: an explicit pick is returned verbatim (any backend)', () => {
  const oc = key(21);
  setThreadAdapter(oc, 'opencode');
  assert.equal(getThreadAdapterNameRaw(oc), 'opencode');
  const js = key(22);
  setThreadAdapter(js, claudeJsonStreamAdapterName);
  assert.equal(getThreadAdapterNameRaw(js), claudeJsonStreamAdapterName);
});

test('checkIsClaudeBackend: both Claude backends true, others false', () => {
  assert.equal(checkIsClaudeBackend('claude'), true);
  assert.equal(checkIsClaudeBackend(claudeJsonStreamAdapterName), true);
  assert.equal(checkIsClaudeBackend('opencode'), false);
  assert.equal(checkIsClaudeBackend('terminal'), false);
});

test('resolveClaudeBackendName: no pick → tmux-scrape default', () => {
  assert.equal(resolveClaudeBackendName(key(1)), 'claude');
});

test('resolveClaudeBackendName: an explicit tmux pick is kept', () => {
  const k = key(2);
  setThreadAdapter(k, 'claude');
  assert.equal(resolveClaudeBackendName(k), 'claude');
});

test('resolveClaudeBackendName: an explicit json-stream pick is honoured', () => {
  const k = key(3);
  setThreadAdapter(k, claudeJsonStreamAdapterName);
  assert.equal(resolveClaudeBackendName(k), claudeJsonStreamAdapterName);
});

test('resolveClaudeBackendName: a non-Claude pick falls to the tmux-scrape default', () => {
  const k = key(4);
  setThreadAdapter(k, 'opencode');
  assert.equal(resolveClaudeBackendName(k), 'claude');
});

// ── /claude_mode decision (live bug 2026-07-06, topic 9085) ─────────────────
//
// Historic shape: under the retired env-forced default, a NO-pick thread's
// threadAdapterName could DISAGREE with the EFFECTIVE Claude backend (what
// `/claude` would start). The old handler compared the requested backend
// against threadAdapterName, so the first `/claude_mode` switch replied
// "already" without persisting. getClaudeModeAction takes both resolutions
// as inputs, so the decision stays correct even if they ever diverge again.

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

test('getClaudeModeAction: thread name disagreeing with effective backend + that backend requested → SWITCH (the bug)', () => {
  const action = getClaudeModeAction({
    threadAdapterName: 'claude', // no pick; legacy env-forced fallback
    effectiveBackendName: claudeJsonStreamAdapterName, // what /claude would start
    requestedBackendName: 'claude',
  });
  assert.deepEqual(action, { kind: 'switch', backendName: 'claude' });
});

test('getClaudeModeAction: fresh thread + tmux request → already (tmux IS the effective default)', () => {
  const action = getClaudeModeAction({
    threadAdapterName: 'claude',
    effectiveBackendName: 'claude',
    requestedBackendName: 'claude',
  });
  assert.deepEqual(action, { kind: 'already', backendName: 'claude' });
});

test('getClaudeModeAction: explicit json-stream pick + json request → already; + tmux request → switch', () => {
  const base = {
    threadAdapterName: claudeJsonStreamAdapterName,
    effectiveBackendName: claudeJsonStreamAdapterName,
  };
  assert.deepEqual(
    getClaudeModeAction({ ...base, requestedBackendName: claudeJsonStreamAdapterName }),
    { kind: 'already', backendName: claudeJsonStreamAdapterName },
  );
  assert.deepEqual(
    getClaudeModeAction({ ...base, requestedBackendName: 'claude' }),
    { kind: 'switch', backendName: 'claude' },
  );
});

test('getClaudeModeAction: opencode/terminal topics are gated to notClaude', () => {
  for (const name of ['opencode', 'terminal']) {
    const action = getClaudeModeAction({
      threadAdapterName: name,
      effectiveBackendName: 'claude',
      requestedBackendName: 'claude',
    });
    assert.deepEqual(action, { kind: 'notClaude' }, name);
  }
});

test('getClaudeModeAction: bare command → picker with the EFFECTIVE backend as current (✓ target)', () => {
  // The picker's ✓ must sit on the EFFECTIVE backend (what /claude would
  // open), not on the raw thread name.
  const action = getClaudeModeAction({
    threadAdapterName: 'claude',
    effectiveBackendName: claudeJsonStreamAdapterName,
    requestedBackendName: null,
  });
  assert.deepEqual(action, { kind: 'picker', currentBackendName: claudeJsonStreamAdapterName });
});
