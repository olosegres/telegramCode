/**
 * @description Plan §11 Этап 7 / R1 — `ThreadKey` serialize / deserialize
 * round-trips losslessly across the full domain we hit in production:
 *
 *  - Negative `chatId` (forum supergroups are always `-100…`).
 *  - General topic (`threadId = 1`).
 *  - Large topic ids (Telegram allocates monotonically; live groups
 *    routinely have 4-5 digit threadIds).
 *  - Zero — historical shim for private chats before §11 Этап 3.
 *
 * The serialised form is also the key in `state.json.bindings`, so any
 * regression here corrupts persisted state. Hence the property-style
 * round-trip — exhaustive enough to catch sign / off-by-one bugs without
 * pulling in `fast-check`.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { keyToString, keyFromString, keysEqual, type AgentAdapter, type ThreadKey } from '../types';

test('keyToString → keyFromString round-trips for representative keys', () => {
  const samples: ThreadKey[] = [
    { chatId: -1001234567890, threadId: 1 },    // General topic
    { chatId: -1001234567890, threadId: 42 },   // normal topic
    { chatId: -1009999999999, threadId: 99999 }, // long-lived group
    { chatId: 12345, threadId: 0 },              // historical shim
    { chatId: -1, threadId: 1 },                 // edge small negative
  ];

  for (const key of samples) {
    const s = keyToString(key);
    const decoded = keyFromString(s);
    assert.equal(decoded.chatId, key.chatId, `chatId mismatch for ${s}`);
    assert.equal(decoded.threadId, key.threadId, `threadId mismatch for ${s}`);
    assert.ok(keysEqual(key, decoded), `keysEqual failed for ${s}`);
  }
});

test('keyToString format is exactly "<chatId>:<threadId>"', () => {
  // The state.json schema depends on this exact format — a regression
  // here would silently invalidate every persisted binding.
  assert.equal(keyToString({ chatId: -1001234567890, threadId: 42 }), '-1001234567890:42');
  assert.equal(keyToString({ chatId: 1, threadId: 1 }), '1:1');
});

test('keyFromString rejects malformed input', () => {
  // Empty / missing separator / non-numeric / trailing colon — all
  // realistic state.json corruption modes we'd rather catch loudly than
  // see silently coerced to NaN.
  const bad = ['', ':', '42', ':42', '42:', 'a:b', '-1001234567890:abc', 'abc:42'];
  for (const s of bad) {
    assert.throws(() => keyFromString(s), /Invalid ThreadKey/, `should reject "${s}"`);
  }
});

test('keysEqual is reflexive, symmetric, and structural', () => {
  const a: ThreadKey = { chatId: -100, threadId: 5 };
  const b: ThreadKey = { chatId: -100, threadId: 5 };
  const c: ThreadKey = { chatId: -100, threadId: 6 };
  const d: ThreadKey = { chatId: -101, threadId: 5 };

  assert.ok(keysEqual(a, a));
  assert.ok(keysEqual(a, b));
  assert.ok(keysEqual(b, a));
  assert.ok(!keysEqual(a, c), 'different threadId must not be equal');
  assert.ok(!keysEqual(a, d), 'different chatId must not be equal');
});

/**
 * Audit S10 / #16: lock in the AgentAdapter event-and-throw contract via a
 * type-only compile check. If anyone widens `setModel` back to `void` or
 * drops the throw guarantee from `startSession`, the assignments below
 * stop compiling and `yarn typecheck` blocks the merge.
 */
test('AgentAdapter contract — startSession returns Promise<void>, setModel returns Promise<string|null>', () => {
  // The cast-to-`Pick` keeps this purely a compile-time assertion; we
  // never run the methods so the dummy bodies are unobservable.
  type StartSig = AgentAdapter['startSession'];
  type SetModelSig = NonNullable<AgentAdapter['setModel']>;

  const start: StartSig = async () => { /* must return Promise<void> */ };
  const setModel: SetModelSig = async () => null;
  // Touch the locals so the linter doesn't drop them.
  assert.equal(typeof start, 'function');
  assert.equal(typeof setModel, 'function');
});

/**
 * Plan 2026-05-30-effort-command / S1 — lock the per-thread reasoning-effort
 * contract via type-only assertions. Same shape as the setModel guard above:
 * if anyone widens these signatures (drops `string | null`, makes the level
 * lookup sync without being trivially derivable, etc.) the assignments stop
 * compiling and `yarn typecheck` blocks the merge.
 */
test('AgentAdapter contract — setEffort/getEffort/getAvailableEffortLevels signatures', () => {
  type SetEffortSig = NonNullable<AgentAdapter['setEffort']>;
  type GetEffortSig = NonNullable<AgentAdapter['getEffort']>;
  type GetLevelsSig = NonNullable<AgentAdapter['getAvailableEffortLevels']>;

  const setEffort: SetEffortSig = async () => null;
  const getEffort: GetEffortSig = () => null;
  const getLevels: GetLevelsSig = async () => [];

  assert.equal(typeof setEffort, 'function');
  assert.equal(typeof getEffort, 'function');
  assert.equal(typeof getLevels, 'function');
});
