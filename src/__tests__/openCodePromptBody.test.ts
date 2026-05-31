import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildPromptBody } from '../adapters/openCodeAdapter';

test('buildPromptBody: rides the chosen effort as variant on the prompt body', () => {
  const body = buildPromptBody('hi', null, 'high');
  assert.equal(body.variant, 'high');
  assert.deepEqual(body.parts, [{ type: 'text', text: 'hi' }]);
});

test('buildPromptBody: omits variant entirely when no effort level is set', () => {
  const body = buildPromptBody('hi', null, null);
  assert.equal('variant' in body, false);
});

test('buildPromptBody: carries model override and variant in parallel', () => {
  const body = buildPromptBody(
    'hi',
    { providerID: 'anthropic', modelID: 'claude-opus-4-8' },
    'xhigh',
  );
  assert.deepEqual(body.model, { modelID: 'claude-opus-4-8', providerID: 'anthropic' });
  assert.equal(body.variant, 'xhigh');
});

test('buildPromptBody: omits model when there is no override', () => {
  const body = buildPromptBody('hi', null, 'low');
  assert.equal('model' in body, false);
});
