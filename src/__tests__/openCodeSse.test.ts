import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normaliseOpenCodeSseEvent } from '../adapters/openCodeAdapter';

test('OpenCode SSE: accepts direct /event envelope', () => {
  assert.deepEqual(
    normaliseOpenCodeSseEvent({
      type: 'message.part.delta',
      properties: { sessionID: 'ses_1', delta: 'ok' },
    }),
    { type: 'message.part.delta', properties: { sessionID: 'ses_1', delta: 'ok' } },
  );
});

test('OpenCode SSE: unwraps /global/event payload envelope and keeps the instance directory', () => {
  assert.deepEqual(
    normaliseOpenCodeSseEvent({
      directory: '/home/user/src/someProject',
      project: 'abc',
      payload: {
        id: 'evt_1',
        type: 'message.updated',
        properties: { info: { sessionID: 'ses_1', role: 'assistant' } },
      },
    }),
    {
      type: 'message.updated',
      properties: { info: { sessionID: 'ses_1', role: 'assistant' } },
      // The envelope's directory names the owning project instance — replies
      // to instance-local requests (questions/permissions) must carry it.
      directory: '/home/user/src/someProject',
    },
  );
});

test('OpenCode SSE: direct /event envelope has no directory field', () => {
  const normalised = normaliseOpenCodeSseEvent({
    type: 'question.asked',
    properties: { id: 'que_1', sessionID: 'ses_1', questions: [] },
  });
  assert.ok(normalised);
  assert.equal('directory' in normalised, false);
});

test('OpenCode SSE: invalid envelopes are ignored', () => {
  assert.equal(normaliseOpenCodeSseEvent(null), null);
  assert.equal(normaliseOpenCodeSseEvent({ payload: {} }), null);
});
