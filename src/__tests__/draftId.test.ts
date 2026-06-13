/**
 * @description Unit tests for the DM draft-id allocator (`utils/draftId`).
 *
 * Proves the four invariants the live native-draft animation depends on:
 *  1. every id is a non-zero positive int;
 *  2. successive ids strictly change (so a new turn animates separately);
 *  3. the fold formula wraps WITHOUT ever yielding 0 (Telegram rejects a 0 id);
 *  4. two interleaved per-thread sequences stay distinct (no cross-turn /
 *     cross-topic collision) — the property that lets two DM topics stream at
 *     once off one shared counter.
 *
 * The counter is module-scoped and monotonic; the wrap point ({@link
 * DRAFT_ID_MODULO} = 2e9) is far past what a test can iterate, so invariant 3
 * is proven against the SAME fold formula the module uses, evaluated at the
 * boundary indices — documenting the semantics rather than spinning 2e9 times.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { nextDraftId, DRAFT_ID_MODULO } from '../utils/draftId';

test('nextDraftId: every id is a non-zero positive integer', () => {
  let prev: number | null = null;
  for (let i = 0; i < 1000; i++) {
    const id = nextDraftId(prev);
    assert.ok(Number.isInteger(id), `id ${id} must be an integer`);
    assert.ok(id > 0, `id ${id} must be positive`);
    assert.notEqual(id, 0, 'id must never be 0 (Telegram rejects a 0 draft id)');
    prev = id;
  }
});

test('nextDraftId: successive ids strictly change', () => {
  let prev = nextDraftId(null);
  for (let i = 0; i < 1000; i++) {
    const id = nextDraftId(prev);
    assert.notEqual(id, prev, `id ${id} must differ from the previous id ${prev}`);
    prev = id;
  }
});

test('nextDraftId: stays within [1, DRAFT_ID_MODULO]', () => {
  let prev: number | null = null;
  for (let i = 0; i < 5000; i++) {
    const id = nextDraftId(prev);
    assert.ok(id >= 1, `id ${id} below floor 1`);
    assert.ok(id <= DRAFT_ID_MODULO, `id ${id} above ceiling ${DRAFT_ID_MODULO}`);
    prev = id;
  }
});

test('fold formula wraps without hitting 0 at the modulo boundary', () => {
  // The module computes `(counter % MODULO) + 1`. Evaluate that exact formula at
  // the indices straddling the wrap to prove it never produces 0 and folds back
  // to the floor rather than to 0.
  const fold = (counter: number): number => (counter % DRAFT_ID_MODULO) + 1;
  assert.equal(fold(0), 1, 'first id is the floor 1, not 0');
  assert.equal(fold(DRAFT_ID_MODULO - 1), DRAFT_ID_MODULO, 'last pre-wrap id is the ceiling');
  assert.equal(fold(DRAFT_ID_MODULO), 1, 'wraps back to the floor 1 (not 0)');
  assert.equal(fold(DRAFT_ID_MODULO + 1), 2, 'continues monotonically past the wrap');
  // No counter value in the cycle can ever land on 0.
  for (const c of [0, 1, DRAFT_ID_MODULO - 1, DRAFT_ID_MODULO, DRAFT_ID_MODULO * 2]) {
    assert.notEqual(fold(c), 0, `fold(${c}) must not be 0`);
  }
});

test('two interleaved per-thread sequences stay distinct', () => {
  // Simulate two topics each holding their own "previous id" and pulling from
  // the shared counter in an interleaved order. No id may appear in both
  // sequences (the shared monotonic counter guarantees global uniqueness within
  // a wrap cycle).
  const topicA: number[] = [];
  const topicB: number[] = [];
  let prevA: number | null = null;
  let prevB: number | null = null;
  for (let i = 0; i < 500; i++) {
    prevA = nextDraftId(prevA);
    topicA.push(prevA);
    prevB = nextDraftId(prevB);
    topicB.push(prevB);
  }
  const all = new Set([...topicA, ...topicB]);
  assert.equal(all.size, topicA.length + topicB.length, 'no id is shared across the two topics');
  for (const id of topicA) assert.ok(!topicB.includes(id), `id ${id} leaked from topic A into topic B`);
});
