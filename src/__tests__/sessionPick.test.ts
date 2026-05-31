import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSessionPickAction } from '../sessionPick';

// `checkSessionPickAction(text, listLength)` is the pure router behind the
// `/sessions` number-reply picker. It NEVER touches state — it only decides:
//   cancel | select(index) | invalid | passthrough
// Each branch below proves a distinct rule so a regression in any one of the
// four outcomes fails loudly (no vacuous "returned to initial" assertions).

const threeSessions = 3;

test('"0" cancels the picker', () => {
  assert.deepEqual(checkSessionPickAction('0', threeSessions), { kind: 'cancel' });
});

test('a valid number selects the 0-based index (1 → 0)', () => {
  assert.deepEqual(checkSessionPickAction('1', threeSessions), { kind: 'select', index: 0 });
});

test('a valid number selects the 0-based index (2 → 1)', () => {
  assert.deepEqual(checkSessionPickAction('2', threeSessions), { kind: 'select', index: 1 });
});

test('the last in-range number selects the last index (len → len-1)', () => {
  assert.deepEqual(checkSessionPickAction('3', threeSessions), { kind: 'select', index: 2 });
});

test('a number above the range is invalid (caller stays armed)', () => {
  assert.deepEqual(checkSessionPickAction('9', threeSessions), { kind: 'invalid' });
});

test('the number just past the end is invalid (len+1)', () => {
  assert.deepEqual(checkSessionPickAction('4', threeSessions), { kind: 'invalid' });
});

test('any number is invalid when the list is empty (len 0)', () => {
  // "1" with nothing shown must NOT select index 0 — it has to be rejected.
  assert.deepEqual(checkSessionPickAction('1', 0), { kind: 'invalid' });
});

test('non-numeric text passes through to normal handling', () => {
  assert.deepEqual(checkSessionPickAction('hi there', threeSessions), { kind: 'passthrough' });
});

test('a number embedded in text is NOT a bare number → passthrough', () => {
  assert.deepEqual(checkSessionPickAction('resume 2 please', threeSessions), { kind: 'passthrough' });
});

test('surrounding whitespace on a bare number is tolerated', () => {
  assert.deepEqual(checkSessionPickAction('  3 ', threeSessions), { kind: 'select', index: 2 });
});

test('empty text passes through', () => {
  assert.deepEqual(checkSessionPickAction('', threeSessions), { kind: 'passthrough' });
});

test('"0" cancels even when the list is empty', () => {
  assert.deepEqual(checkSessionPickAction('0', 0), { kind: 'cancel' });
});
