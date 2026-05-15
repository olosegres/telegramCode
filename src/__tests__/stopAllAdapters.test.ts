/**
 * @description Unit coverage for `stopAllAdaptersFor` — the sweep helper
 * that gates `/stop`, `/quit`, and `/stop-all` from being silently
 * no-ops when state and reality disagree.
 *
 * Why it matters: `/claude` then `/opencode` used to leave the claude
 * tmux session alive (the old `switchThreadAdapter` didn't stop the
 * previous adapter). `/stop` then only stopped the adapter the in-memory
 * map pointed at, so the live claude session survived and kept polling.
 * `stopAllAdaptersFor` walks every known adapter and stops whichever has
 * an active session for the key, immune to that drift. See plan
 * `agent/tasks/actual/2026-05-15-fix-adapter-desync.md` S3.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { stopAllAdaptersFor, type AdapterSweepTarget } from '../adapters/createAdapter';
import type { ThreadKey } from '../types';

const key: ThreadKey = { chatId: -1001234567890, threadId: 42 };

interface FakeAdapter extends AdapterSweepTarget {
  active: boolean;
  stopCalls: number;
}

function createFakeAdapter(name: string, label: string, active: boolean): FakeAdapter {
  const f: FakeAdapter = {
    name,
    label,
    active,
    stopCalls: 0,
    checkIsActive: () => f.active,
    stopSession: () => {
      f.stopCalls += 1;
      f.active = false;
    },
  };
  return f;
}

test('stops every adapter that has an active session for the key', () => {
  const claude = createFakeAdapter('claude', 'Claude Code', true);
  const opencode = createFakeAdapter('opencode', 'OpenCode', true);
  const resolver = (name: string) => {
    if (name === 'claude') return claude;
    if (name === 'opencode') return opencode;
    throw new Error(`unknown adapter ${name}`);
  };

  const { stopped, attempted } = stopAllAdaptersFor(key, resolver, ['claude', 'opencode']);

  assert.deepEqual(stopped.slice().sort(), ['Claude Code', 'OpenCode']);
  assert.equal(attempted, 2);
  assert.equal(claude.stopCalls, 1);
  assert.equal(opencode.stopCalls, 1);
  assert.equal(claude.active, false);
  assert.equal(opencode.active, false);
});

test('skips adapters whose checkIsActive returns false (no needless stopSession)', () => {
  const claude = createFakeAdapter('claude', 'Claude Code', true);
  const opencode = createFakeAdapter('opencode', 'OpenCode', false);
  const resolver = (name: string) => (name === 'claude' ? claude : opencode);

  const { stopped, attempted } = stopAllAdaptersFor(key, resolver, ['claude', 'opencode']);

  assert.deepEqual(stopped, ['Claude Code']);
  assert.equal(attempted, 1);
  assert.equal(claude.stopCalls, 1);
  assert.equal(opencode.stopCalls, 0);
});

test('returns empty result when nothing is active (used by /stop "No agent running" branch)', () => {
  const claude = createFakeAdapter('claude', 'Claude Code', false);
  const opencode = createFakeAdapter('opencode', 'OpenCode', false);
  const resolver = (name: string) => (name === 'claude' ? claude : opencode);

  const { stopped, attempted } = stopAllAdaptersFor(key, resolver, ['claude', 'opencode']);

  assert.deepEqual(stopped, []);
  assert.equal(attempted, 0);
  assert.equal(claude.stopCalls, 0);
  assert.equal(opencode.stopCalls, 0);
});

test('silently skips adapter names that fail to resolve', () => {
  const claude = createFakeAdapter('claude', 'Claude Code', true);
  const resolver = (name: string) => {
    if (name === 'claude') return claude;
    throw new Error(`Unknown adapter: ${name}`);
  };

  // 'opencode' is unknown to the resolver — must not throw, must not
  // skip 'claude' just because the loop hit a bad name first.
  const { stopped, attempted } = stopAllAdaptersFor(key, resolver, ['opencode', 'claude']);

  assert.deepEqual(stopped, ['Claude Code']);
  assert.equal(attempted, 1);
  assert.equal(claude.stopCalls, 1);
});

test('attempted counts throwing stops too (so /stop-all renders partial failure)', () => {
  // The first adapter throws; the helper must still try the second one.
  // attempted reflects how many adapters we *tried* to stop — used by
  // /stop-all to print "stopped 1 of 2" when one throw was swallowed.
  const throwingClaude: AdapterSweepTarget = {
    name: 'claude',
    label: 'Claude Code',
    checkIsActive: () => true,
    stopSession: () => { throw new Error('tmux kill-session failed'); },
  };
  const opencode = createFakeAdapter('opencode', 'OpenCode', true);
  const resolver = (name: string) => (name === 'claude' ? throwingClaude : opencode);

  const { stopped, attempted } = stopAllAdaptersFor(key, resolver, ['claude', 'opencode']);

  // claude failed silently (logged), opencode still got stopped.
  assert.deepEqual(stopped, ['OpenCode']);
  assert.equal(attempted, 2);
  assert.equal(opencode.stopCalls, 1);
  assert.equal(opencode.active, false);
});

test('respects the adapter-name order passed in', () => {
  // Used by the bot to enumerate adapters in a stable order so the
  // user-facing reply (which lists stopped labels) is deterministic.
  const claude = createFakeAdapter('claude', 'Claude Code', true);
  const opencode = createFakeAdapter('opencode', 'OpenCode', true);
  const resolver = (name: string) => (name === 'claude' ? claude : opencode);

  const a = stopAllAdaptersFor(key, resolver, ['opencode', 'claude']);
  // Reset for second sweep.
  claude.active = true; opencode.active = true;
  const b = stopAllAdaptersFor(key, resolver, ['claude', 'opencode']);

  assert.deepEqual(a.stopped, ['OpenCode', 'Claude Code']);
  assert.deepEqual(b.stopped, ['Claude Code', 'OpenCode']);
});
