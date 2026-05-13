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

test('OpenCode SSE: unwraps /global/event payload envelope', () => {
  assert.deepEqual(
    normaliseOpenCodeSseEvent({
      directory: 'global',
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
    },
  );
});

test('OpenCode SSE: invalid envelopes are ignored', () => {
  assert.equal(normaliseOpenCodeSseEvent(null), null);
  assert.equal(normaliseOpenCodeSseEvent({ payload: {} }), null);
});
