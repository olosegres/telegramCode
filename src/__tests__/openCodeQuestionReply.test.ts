/**
 * @description Question/permission replies must target the project INSTANCE
 * that owns the request — not the serve-cwd default instance.
 *
 * Bug (user-caught live, 2026-06-04, twice): opencode multiplexes one project
 * instance per directory, and pending questions/permissions live in
 * in-memory PER-INSTANCE state. The bot replied to
 * `POST /question/:id/reply` without any `?directory=`, so the server
 * resolved its serve-cwd default instance, found no such request there, and
 * returned 404 `QuestionNotFoundError` — while the question stayed pending
 * (and the agent blocked) in its own instance. Sessions land in whatever
 * instance was the serve default at their creation, so any topic whose
 * session lives outside the current serve cwd could never answer a question.
 * Permission auto-approves failed the same way, but silently (console-only)
 * — the agent then hangs on the permission forever.
 *
 * Fix: the `/global/event` envelope carries the owning instance's
 * `directory`; it is captured per pending question and appended to the reply
 * path via `buildDirectoryScopedPath`.
 *
 * Harness style mirrors `openCodeResumeModel.test.ts`: session injected into
 * the private map, `apiRequest` stubbed, private handlers driven via bracket
 * access.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAdapter, buildDirectoryScopedPath } from '../adapters/openCodeAdapter';
import { keyToString, type ThreadKey } from '../types';

const key: ThreadKey = { chatId: -100779, threadId: 9 };
const sessionId = 'ses_question_owner_9';
const requestId = 'que_abc123';
const owningDirectory = '/home/user/src/otherProject';

function createAdapterWithSession(): {
  adapter: OpenCodeAdapter;
  apiCalls: Array<{ method: string; urlPath: string; body: unknown }>;
} {
  const adapter = new OpenCodeAdapter();
  const session = {
    key,
    sessionId,
    workDir: '/tmp/work-question',
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

describe('buildDirectoryScopedPath', () => {
  it('appends an URL-encoded ?directory= when the instance is known', () => {
    assert.equal(
      buildDirectoryScopedPath('/question/que_1/reply', '/home/u/my project'),
      '/question/que_1/reply?directory=%2Fhome%2Fu%2Fmy%20project',
    );
  });

  it('returns the bare path when no directory is known (per-instance /event mode)', () => {
    assert.equal(buildDirectoryScopedPath('/question/que_1/reply', undefined), '/question/que_1/reply');
  });
});

describe('question reply targets the owning instance', () => {
  it('reply carries the directory captured from the question.asked envelope', () => {
    const { adapter, apiCalls } = createAdapterWithSession();

    adapter['handleQuestionAsked'](key, questionProperties, owningDirectory);
    const session = adapter['sessions'].get(keyToString(key));
    assert.equal(session.pendingQuestion?.requestId, requestId);
    assert.equal(session.pendingQuestion?.directory, owningDirectory);

    adapter.answerQuestion(key, [['A']]);

    // Load-bearing: pre-fix the path had no ?directory= and the reply hit the
    // wrong instance (404 QuestionNotFoundError in the topic).
    assert.equal(apiCalls.length, 1);
    assert.equal(
      apiCalls[0].urlPath,
      `/question/${requestId}/reply?directory=${encodeURIComponent(owningDirectory)}`,
    );
    assert.deepEqual(apiCalls[0].body, { answers: [['A']] });
  });

  it('reply stays unscoped when the event had no envelope directory', () => {
    const { adapter, apiCalls } = createAdapterWithSession();

    adapter['handleQuestionAsked'](key, questionProperties, undefined);
    adapter.answerQuestion(key, [['B']]);

    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0].urlPath, `/question/${requestId}/reply`);
  });
});

describe('permission auto-approve targets the owning instance', () => {
  it('approve carries the directory from the permission.asked envelope', () => {
    const { adapter, apiCalls } = createAdapterWithSession();

    adapter['handlePermissionAsked'](key, { id: 'perm_1', sessionID: sessionId }, owningDirectory);

    assert.equal(apiCalls.length, 1);
    assert.equal(
      apiCalls[0].urlPath,
      `/permission/perm_1/reply?directory=${encodeURIComponent(owningDirectory)}`,
    );
    assert.deepEqual(apiCalls[0].body, { reply: 'always' });
  });
});
