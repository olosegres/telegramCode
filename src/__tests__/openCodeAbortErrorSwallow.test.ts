/**
 * @description A bot-issued abort must not surface as "OpenCode error: Aborted".
 *
 * Live repro (test topic 9085, 2026-08-14): cancelling a pending question sends
 * `POST /session/:id/abort` (the SIGINT), whose `session.error` "Aborted" used
 * to relay a bogus "OpenCode error: Aborted" — the OpenCode-side twin of the
 * json-stream "Claude error: API error" (both are the abort WE issued, not a
 * real provider error). An "Aborted" `session.error` has no other source in
 * OpenCode (the user cannot abort otherwise), so it is swallowed; a real error
 * still surfaces + classifies.
 *
 * The adapter's private members are reached via runtime bracket access (tests
 * are type-stripped by tsx), same pattern as the other openCode adapter tests.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { OpenCodeAdapter, checkIsOpenCodeAbortError } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

const own = 'ses_own';
const key: ThreadKey = { chatId: -100555, threadId: 7 };

function createAdapterWithSession(): { adapter: OpenCodeAdapter; outputs: string[] } {
  const adapter = new OpenCodeAdapter();
  // handleSessionError reads only `isActive` + `sessionId`; a partial session is
  // enough (runtime-only, tsx strips the type).
  adapter['sessions'].set(keyToString(key), { key, sessionId: own, isActive: true });
  const outputs: string[] = [];
  adapter.on('output', (_k: ThreadKey, text: string) => outputs.push(text));
  return { adapter, outputs };
}

// ── pure predicate ──

test('checkIsOpenCodeAbortError: matches the bare "Aborted" word (any case / padding)', () => {
  assert.equal(checkIsOpenCodeAbortError('Aborted'), true);
  assert.equal(checkIsOpenCodeAbortError('aborted'), true);
  assert.equal(checkIsOpenCodeAbortError('  ABORTED  '), true);
});

test('checkIsOpenCodeAbortError: does NOT match a real error that merely quotes the word', () => {
  assert.equal(checkIsOpenCodeAbortError('Request aborted by upstream after 30s'), false);
  assert.equal(checkIsOpenCodeAbortError('rate limited, try again'), false);
  assert.equal(checkIsOpenCodeAbortError(''), false);
});

// ── adapter behaviour ──

test('a bot-issued abort (session.error "Aborted") is swallowed, not surfaced', () => {
  const { adapter, outputs } = createAdapterWithSession();
  adapter['handleSessionError'](key, own, { error: { message: 'Aborted' } });
  assert.deepEqual(outputs, [], 'the abort must not reach the topic as an "OpenCode error"');
});

test('a genuine session.error still surfaces as "OpenCode error: <msg>"', () => {
  const { adapter, outputs } = createAdapterWithSession();
  adapter['handleSessionError'](key, own, { error: { message: 'Invalid authentication credentials' } });
  assert.deepEqual(outputs, ['OpenCode error: Invalid authentication credentials']);
});

test('the aborted turn\'s assistant message.error "Aborted" is ALSO swallowed', () => {
  // The abort surfaces on TWO channels — `session.error` (above) AND the aborted
  // assistant message's `info.error`. Both must be swallowed or the topic still
  // gets a bogus "Error: Aborted" (live 2026-08-14).
  const { adapter, outputs } = createAdapterWithSession();
  adapter['handleMessageUpdate'](key, { info: { sessionID: own, role: 'assistant', error: { message: 'Aborted' } } });
  assert.deepEqual(outputs, [], 'the abort must not reach the topic as a message error either');
});

test('a genuine assistant message.error still surfaces as "Error: <msg>"', () => {
  const { adapter, outputs } = createAdapterWithSession();
  adapter['handleMessageUpdate'](key, { info: { sessionID: own, role: 'assistant', error: { message: 'context window exceeded' } } });
  assert.deepEqual(outputs, ['Error: context window exceeded']);
});
