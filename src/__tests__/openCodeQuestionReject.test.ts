/**
 * @description An ABANDONED OpenCode question must be CLOSED on the server, not
 * just hidden in Telegram — otherwise `restoreOpenQuestion` (`GET /question` on
 * every reattach) keeps re-finding it and re-posting the stale question after a
 * restart (the live bug, topic 688, 2026-07-01).
 *
 * Two seams are guarded here:
 *
 *  1. The adapter method `rejectQuestion` (S1): with a stubbed `apiRequest` and a
 *     pending question set via `handleQuestionAsked`, it POSTs exactly once to
 *     `/question/:id/reject?directory=…` with an empty body and clears the
 *     session's `pendingQuestion`; it fires NOTHING when no question is pending or
 *     the session is inactive. This is the "exactly once when pending, never when
 *     none" gate the plan (S4) calls for — the abandon/teardown callers just
 *     invoke it, so this method is where the fire/no-fire decision actually lives.
 *
 *  2. The bot-side WIRING (S2 + S3): `cancelPendingQuestionAndForward` (abandon-
 *     by-prompt, S2) and the three teardown initiators (`releaseThreadSession` =
 *     /new, the `/quit` command, `unbindThread` = leaving the folder, all S3) must
 *     call `rejectQuestion` while the session is still active, before the session
 *     is stopped/released. These live in the side-effecting `bot.ts` entrypoint
 *     (Telegram + I/O deps), so — exactly like `voiceQuestionCancelWiring.test.ts`
 *     — the seam is locked with a source-scan of the isolated function bodies
 *     rather than by booting the whole bot. The live server round-trip is already
 *     proven (the two zombie questions were rejected → `GET /question` empty, no
 *     nudge), so this guards the wiring, not the HTTP.
 *
 * Adapter-test harness style mirrors `openCodeQuestionReply.test.ts`: session
 * injected into the private map, `apiRequest` stubbed, private handlers driven
 * via bracket access.
 */

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OpenCodeAdapter } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

const key: ThreadKey = { chatId: -100779, threadId: 42 };
const sessionId = 'ses_reject_owner_42';
const requestId = 'que_reject_1';
const owningDirectory = '/home/user/src/overview';

function createAdapterWithSession(): {
  adapter: OpenCodeAdapter;
  apiCalls: Array<{ method: string; urlPath: string; body: unknown }>;
} {
  const adapter = new OpenCodeAdapter();
  const session = {
    key,
    sessionId,
    workDir: '/tmp/work-reject',
    isActive: true,
    currentResponseText: '',
    lastEmittedLength: 0,
    outputTimer: null,
    isModelInfoShown: true,
    modelOverride: null,
    currentModelLabel: null,
    partTypes: new Map(),
    statusDebounceTimer: null,
    pendingStatus: null,
    pendingQuestion: null,
    effortLevel: null,
    isBusy: false,
    isCompacting: false,
    busyChildSessionIds: new Set(),
    sseController: null,
    reconnectTimer: null,
    sseStallTimer: null,
    isAutoNamePending: false,
  };
  adapter['sessions'].set(keyToString(key), session);

  const apiCalls: Array<{ method: string; urlPath: string; body: unknown }> = [];
  adapter['apiRequest'] = (async (method: string, urlPath: string, body?: unknown) => {
    apiCalls.push({ method, urlPath, body });
    return undefined;
  }) as OpenCodeAdapter['apiRequest'];

  return { adapter, apiCalls };
}

const questionProperties = {
  id: requestId,
  sessionID: sessionId,
  questions: [
    {
      question: 'Which one?',
      header: 'Pick',
      options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
    },
  ],
};

describe('rejectQuestion closes an abandoned question on the owning instance', () => {
  it('fires exactly one reject POST (directory-scoped, empty body) and clears pendingQuestion', () => {
    const { adapter, apiCalls } = createAdapterWithSession();

    adapter['handleQuestionAsked'](key, questionProperties, owningDirectory);
    const session = adapter['sessions'].get(keyToString(key));
    assert.equal(session.pendingQuestion?.requestId, requestId);

    adapter.rejectQuestion(key);

    // Load-bearing: pre-fix nothing was sent, so the question lingered "open" on
    // the server and reattach re-surfaced it.
    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0].method, 'POST');
    assert.equal(
      apiCalls[0].urlPath,
      `/question/${requestId}/reject?directory=${encodeURIComponent(owningDirectory)}`,
    );
    assert.deepEqual(apiCalls[0].body, {});
    // The pending question is cleared locally too, so a late button tap can't
    // then try to reply to a request we just rejected.
    assert.equal(session.pendingQuestion, null);
  });

  it('reject stays unscoped when the question had no envelope directory', () => {
    const { adapter, apiCalls } = createAdapterWithSession();

    adapter['handleQuestionAsked'](key, questionProperties, undefined);
    adapter.rejectQuestion(key);

    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0].urlPath, `/question/${requestId}/reject`);
  });

  it('fires NOTHING when no question is pending', () => {
    const { adapter, apiCalls } = createAdapterWithSession();

    // No handleQuestionAsked → session.pendingQuestion stays null.
    adapter.rejectQuestion(key);

    assert.equal(apiCalls.length, 0);
  });

  it('fires NOTHING when the session is inactive', () => {
    const { adapter, apiCalls } = createAdapterWithSession();
    adapter['handleQuestionAsked'](key, questionProperties, owningDirectory);
    adapter['sessions'].get(keyToString(key)).isActive = false;

    adapter.rejectQuestion(key);

    assert.equal(apiCalls.length, 0);
  });
});

// ── Bot-side wiring: source-scan the isolated function bodies ──

const botSource = fs.readFileSync(path.join(__dirname, '..', 'bot.ts'), 'utf8');

/**
 * Isolate a top-level function/command body starting at `startMarker` up to the
 * next top-level declaration, so an assertion can't be satisfied by an unrelated
 * `rejectQuestion` call elsewhere in `bot.ts`.
 */
function sliceBody(startMarker: string): string {
  const startIdx = botSource.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `${startMarker} must exist in bot.ts`);
  const after = botSource.slice(startIdx + startMarker.length);
  const nextDeclMatch = after.search(/\n(?:async function |function |command\()/);
  return after.slice(0, nextDeclMatch === -1 ? undefined : nextDeclMatch);
}

const rejectCallRe = /\.rejectQuestion\?\.\(\s*(?:key|bKey)\s*\)/;

test('S2: cancelPendingQuestionAndForward rejects the question before the SIGINT', () => {
  const body = sliceBody('async function cancelPendingQuestionAndForward');
  assert.match(body, rejectCallRe, 'abandon-by-prompt must reject the question server-side');
  // Order matters: reject while the session is still live, before the SIGINT
  // kills the turn.
  const rejectIdx = body.search(rejectCallRe);
  const sigintIdx = body.indexOf("sendSignal(key, 'SIGINT')");
  assert.notEqual(sigintIdx, -1, 'the SIGINT must still be present');
  assert.ok(rejectIdx < sigintIdx, 'reject must run BEFORE the SIGINT');
});

test('S3: releaseThreadSession (/new) rejects before stopping the adapters', () => {
  const body = sliceBody('async function releaseThreadSession');
  assert.match(body, rejectCallRe, '/new must reject a pending question before release');
  const rejectIdx = body.search(rejectCallRe);
  const stopIdx = body.indexOf('stopAllAdaptersFor(key)');
  assert.ok(rejectIdx !== -1 && stopIdx !== -1 && rejectIdx < stopIdx, 'reject must run BEFORE stopAllAdaptersFor');
});

test('S3: the /quit command rejects before the session teardown', () => {
  const body = sliceBody("command(['quit', 'q']");
  assert.match(body, rejectCallRe, '/quit must reject a pending question before teardown');
  // Order parity with the other two teardown tests: reject must precede BOTH
  // teardown branches (Claude double-SIGINT, OpenCode stopSession). The earlier
  // `stopAllAdaptersFor(key, otherAdapters)` only stops OTHER adapters, so the
  // primary adapter holding the question is still active at the reject.
  const rejectIdx = body.search(rejectCallRe);
  const sigintIdx = body.indexOf("sendSignal(key, 'SIGINT')");
  const stopIdx = body.indexOf('adapter.stopSession(key)');
  assert.ok(sigintIdx !== -1 && rejectIdx < sigintIdx, 'reject must run BEFORE the Claude SIGINT teardown');
  assert.ok(stopIdx !== -1 && rejectIdx < stopIdx, 'reject must run BEFORE the OpenCode stopSession teardown');
});

test('S3: unbindThread (leaving the folder) rejects before stopSession', () => {
  const body = sliceBody('async function unbindThread');
  assert.match(body, rejectCallRe, 'leaving the folder must reject a pending question before stopSession');
  const rejectIdx = body.search(rejectCallRe);
  const stopIdx = body.indexOf('adapter.stopSession(key)');
  assert.ok(rejectIdx !== -1 && stopIdx !== -1 && rejectIdx < stopIdx, 'reject must run BEFORE stopSession');
});
