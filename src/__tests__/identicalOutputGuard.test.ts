/**
 * @description The per-thread identical-output backstop (S2, flood 2026-06-16):
 * a Claude topic emitted one box-drawing table ~500 byte-identical times. This
 * guard caps a runaway of byte-identical LARGE permanent outputs regardless of
 * which emit path produced them — defense-in-depth behind the table-emit
 * root-cause fix.
 *
 * Load-bearing assertions (in tradeoff order):
 *  - a byte-identical LARGE output within the window is SUPPRESSED;
 *  - DIFFERENT text passes (never a fuzzy match — a genuine change always emits);
 *  - text < identicalOutputMinChars passes (short answers repeat legitimately);
 *  - an identical output OUTSIDE the time window passes (a deliberate re-print
 *    minutes apart is not a flood);
 *  - per-thread isolation: an identical output in another thread does not
 *    suppress this thread's first send;
 *  - reset clears a thread's history (session boundary).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createIdenticalOutputGuard,
  checkIsIdenticalOutputRepeat,
  recordRecentOutput,
  identicalOutputMinChars,
  identicalOutputWindowMs,
  identicalOutputWindowSize,
} from '../utils/identicalOutputGuard';

/** A LARGE block (≥ min chars) — the only kind the guard acts on. */
const largeBlock = 'X'.repeat(identicalOutputMinChars + 50);
const otherLargeBlock = 'Y'.repeat(identicalOutputMinChars + 50);
const threadA = '-100:9085';
const threadB = '-100:1487';

// ─── stateful guard (the wiring contract) ────────────────────────────────────

test('guard: a byte-identical large output within the window is suppressed', () => {
  const guard = createIdenticalOutputGuard();
  const now = 1_000_000;
  assert.equal(guard.checkAndRecord(threadA, largeBlock, now), false, 'first send passes + is recorded');
  assert.equal(guard.checkAndRecord(threadA, largeBlock, now + 12_000), true, 'identical repeat suppressed');
  assert.equal(guard.checkAndRecord(threadA, largeBlock, now + 24_000), true, 'still suppressed within window');
});

test('guard: different text always passes', () => {
  const guard = createIdenticalOutputGuard();
  const now = 1_000_000;
  assert.equal(guard.checkAndRecord(threadA, largeBlock, now), false);
  assert.equal(guard.checkAndRecord(threadA, otherLargeBlock, now + 1_000), false, 'different block emits');
});

test('guard: a short output is never guarded (passes even when repeated)', () => {
  const guard = createIdenticalOutputGuard();
  const shortBlock = 'done';
  assert.ok(shortBlock.length < identicalOutputMinChars);
  const now = 1_000_000;
  assert.equal(guard.checkAndRecord(threadA, shortBlock, now), false);
  assert.equal(guard.checkAndRecord(threadA, shortBlock, now + 1_000), false, 'repeated short answer still passes');
  assert.equal(guard.checkAndRecord(threadA, shortBlock, now + 2_000), false);
});

test('guard: an identical output outside the time window passes', () => {
  const guard = createIdenticalOutputGuard();
  const now = 1_000_000;
  assert.equal(guard.checkAndRecord(threadA, largeBlock, now), false);
  assert.equal(
    guard.checkAndRecord(threadA, largeBlock, now + identicalOutputWindowMs + 1),
    false,
    'an identical re-print after the window aged out is not a flood',
  );
});

test('guard: per-thread isolation — another thread does not suppress this one', () => {
  const guard = createIdenticalOutputGuard();
  const now = 1_000_000;
  assert.equal(guard.checkAndRecord(threadA, largeBlock, now), false);
  assert.equal(
    guard.checkAndRecord(threadB, largeBlock, now + 1_000),
    false,
    'the same text in another thread is a first send there',
  );
});

test('guard: reset clears a thread history (session boundary)', () => {
  const guard = createIdenticalOutputGuard();
  const now = 1_000_000;
  assert.equal(guard.checkAndRecord(threadA, largeBlock, now), false);
  assert.equal(guard.checkAndRecord(threadA, largeBlock, now + 1_000), true);
  guard.reset(threadA);
  assert.equal(guard.checkAndRecord(threadA, largeBlock, now + 2_000), false, 'after reset the repeat is a fresh send');
});

test('guard: only the last N outputs are remembered (window size eviction)', () => {
  const guard = createIdenticalOutputGuard();
  const now = 1_000_000;
  // Send the target, then push identicalOutputWindowSize distinct large blocks
  // so the target evicts; a later identical target is then a fresh send.
  assert.equal(guard.checkAndRecord(threadA, largeBlock, now), false);
  for (let n = 0; n < identicalOutputWindowSize; n += 1) {
    guard.checkAndRecord(threadA, `${'Z'.repeat(identicalOutputMinChars)}-${n}`, now + n + 1);
  }
  assert.equal(
    guard.checkAndRecord(threadA, largeBlock, now + 100),
    false,
    'the target evicted past the window size → a fresh send',
  );
});

// ─── pure helpers (used by the guard) ────────────────────────────────────────

test('checkIsIdenticalOutputRepeat: matches an in-window identical record', () => {
  const now = 5_000;
  const history = [{ text: largeBlock, sentAtMs: now - 10_000 }];
  assert.equal(checkIsIdenticalOutputRepeat(largeBlock, history, now), true);
});

test('checkIsIdenticalOutputRepeat: a short candidate is never a repeat', () => {
  const now = 5_000;
  const short = 'hi';
  const history = [{ text: short, sentAtMs: now - 1_000 }];
  assert.equal(checkIsIdenticalOutputRepeat(short, history, now), false);
});

test('checkIsIdenticalOutputRepeat: an aged-out record does not match', () => {
  const now = 1_000_000;
  const history = [{ text: largeBlock, sentAtMs: now - identicalOutputWindowMs - 1 }];
  assert.equal(checkIsIdenticalOutputRepeat(largeBlock, history, now), false);
});

test('recordRecentOutput: a short output is not recorded (would only waste a slot)', () => {
  const next = recordRecentOutput([], 'tiny', 1_000);
  assert.deepEqual(next, []);
});

test('recordRecentOutput: keeps only the last identicalOutputWindowSize records, newest last', () => {
  let history: ReturnType<typeof recordRecentOutput> = [];
  for (let n = 0; n < identicalOutputWindowSize + 3; n += 1) {
    history = recordRecentOutput(history, `${largeBlock}-${n}`, n);
  }
  assert.equal(history.length, identicalOutputWindowSize);
  assert.equal(history[history.length - 1].text, `${largeBlock}-${identicalOutputWindowSize + 2}`, 'newest last');
  assert.equal(history[0].text, `${largeBlock}-3`, 'oldest kept is the (size+3 - size)=3rd');
});
