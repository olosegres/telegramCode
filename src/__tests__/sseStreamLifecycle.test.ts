/**
 * @description Pure decision logic for the OpenCode adapter's per-directory SSE
 * streams (plan 2026-06-05 S5). These functions decide WHEN a directory's
 * single shared stream opens (first active session appears) and closes (last
 * one goes away). Each case below proves one rule so a regression fails loudly;
 * the adapter wiring that consumes them is exercised separately in
 * `openCodeSseStreamLifecycle.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countActiveSessionsForDirectory,
  getSseStreamTransition,
  getWantedStreamDirectories,
  type DirectoryBoundSession,
} from '../utils/sseStreamLifecycle';

const dirA = '/work/projectA';
const dirB = '/work/projectB';

// getSseStreamTransition — the open/close edge detector.

test('zero → one active session opens the stream', () => {
  assert.equal(getSseStreamTransition(0, 1), 'open');
});

test('one → zero active sessions closes the stream', () => {
  assert.equal(getSseStreamTransition(1, 0), 'close');
});

test('one → two (a sibling joins) is a no-op — stream already open', () => {
  assert.equal(getSseStreamTransition(1, 2), 'none');
});

test('two → one (a sibling leaves, one remains) is a no-op — stream stays open', () => {
  assert.equal(getSseStreamTransition(2, 1), 'none');
});

test('zero → zero is a no-op', () => {
  assert.equal(getSseStreamTransition(0, 0), 'none');
});

// countActiveSessionsForDirectory — the reference count streams key on.

test('counts only ACTIVE sessions bound to the directory', () => {
  const sessions: DirectoryBoundSession[] = [
    { workDir: dirA, isActive: true },
    { workDir: dirA, isActive: true },
    { workDir: dirA, isActive: false }, // inactive — not counted
    { workDir: dirB, isActive: true }, // other dir — not counted
  ];
  assert.equal(countActiveSessionsForDirectory(sessions, dirA), 2);
  assert.equal(countActiveSessionsForDirectory(sessions, dirB), 1);
  assert.equal(countActiveSessionsForDirectory(sessions, '/work/none'), 0);
});

test('an empty session list counts zero for any directory', () => {
  assert.equal(countActiveSessionsForDirectory([], dirA), 0);
});

// getWantedStreamDirectories — the set of dirs that should have a live stream.

test('wanted set holds exactly the directories with an active session, de-duplicated', () => {
  const sessions: DirectoryBoundSession[] = [
    { workDir: dirA, isActive: true },
    { workDir: dirA, isActive: true }, // same dir, two threads — one entry
    { workDir: dirB, isActive: false }, // inactive — excluded
  ];
  const wanted = getWantedStreamDirectories(sessions);
  assert.deepEqual([...wanted].sort(), [dirA]);
  assert.equal(wanted.has(dirB), false);
});

test('wanted set is empty when no session is active', () => {
  const sessions: DirectoryBoundSession[] = [
    { workDir: dirA, isActive: false },
    { workDir: dirB, isActive: false },
  ];
  assert.equal(getWantedStreamDirectories(sessions).size, 0);
});
