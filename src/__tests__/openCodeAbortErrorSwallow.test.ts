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
 * The same file covers the error-TEXT contract `getOpenCodeErrorMessage` owes
 * its callers, which is a CREDENTIAL-LEAK boundary: its return value is emitted
 * into a Telegram topic and written to the console log.
 *
 * Load-bearing intent (per `.claude/rules/tests.md`):
 * - an unrecognised payload SHAPE is never rendered — it collapses to the fixed
 *   generic constant. Rendering it as redacted JSON leaked provider keys
 *   through shapes name-based redaction cannot see (escaped nested JSON,
 *   header-pair arrays, unlisted field names, URLs, bare prose values), and
 *   `/connect` PUTs the user's own key, so a rejected-body echo is verbatim;
 * - that suppression must NOT cost the auto-retry: an unrecognised-shape
 *   rate-limit still classifies as `transient`, because the classifier reads a
 *   separate classification-only serialisation of the RAW payload;
 * - the string path (a provider's prose message / HTTP error body) is still
 *   surfaced, so its best-effort redaction must cover value shapes and the
 *   wider field-name set, must be capped, and must stop the value at a
 *   separator — a greedy value swallowed the rest of the JSON object, taking
 *   the `rate_limit_exceeded` marker the retry classifier needs with it.
 *
 * The adapter's private members are reached via runtime bracket access (tests
 * are type-stripped by tsx), same pattern as the other openCode adapter tests.
 *
 * Test case: N/A — TelegramCode has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  OpenCodeAdapter,
  checkIsOpenCodeAbortError,
  getOpenCodeErrorMessage,
  openCodeErrorMessageMaxLength,
} from '../adapters/openCodeAdapter';
import { classifyAgentApiError } from '../apiErrorRetry';
import { keyToString, type AgentApiErrorClass, type ThreadKey } from '../types';

const own = 'ses_own';
const key: ThreadKey = { chatId: -100555, threadId: 7 };
/** The only text an unrecognised payload shape may ever surface. */
const genericErrorMessage = 'OpenCode request failed';

function createAdapterWithSession(): {
  adapter: OpenCodeAdapter;
  outputs: string[];
  apiErrors: AgentApiErrorClass[];
} {
  const adapter = new OpenCodeAdapter();
  // handleSessionError reads only `isActive` + `sessionId`; a partial session is
  // enough (runtime-only, tsx strips the type).
  adapter['sessions'].set(keyToString(key), { key, sessionId: own, isActive: true });
  const outputs: string[] = [];
  adapter.on('output', (_k: ThreadKey, text: string) => outputs.push(text));
  const apiErrors: AgentApiErrorClass[] = [];
  adapter.on('apiError', (_k: ThreadKey, apiError: AgentApiErrorClass) => apiErrors.push(apiError));
  return { adapter, outputs, apiErrors };
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

test('getOpenCodeErrorMessage redacts credential values in the readable message shapes', () => {
  assert.equal(
    getOpenCodeErrorMessage({ data: { message: 'Provider rejected Authorization: Bearer provider-secret' } }),
    'Provider rejected Authorization: [redacted]',
  );
  assert.equal(getOpenCodeErrorMessage('token=provider-secret'), 'token=[redacted]');
  assert.doesNotMatch(getOpenCodeErrorMessage({ apiKey: 'provider-secret' }), /provider-secret/);

  // Nothing readable to render → the generic constant is the only fallback.
  assert.equal(getOpenCodeErrorMessage({}), genericErrorMessage);
  const circularError: { self?: object } = {};
  circularError.self = circularError;
  assert.equal(getOpenCodeErrorMessage(circularError), genericErrorMessage);
});

/**
 * Payload shapes an independent security review verified were leaking when an
 * unrecognised shape was rendered as redacted JSON. Every `secrets` entry is a
 * value that must NEVER appear in text the bot surfaces or logs.
 */
const leakingPayloadShapes: { shape: string; payload: unknown; secrets: string[] }[] = [
  {
    shape: 'escaped-quote nested JSON in a response body',
    payload: { data: { responseBody: '{"api_key":"sk-ant-api03-leakedvalue"}' } },
    secrets: ['sk-ant-api03-leakedvalue'],
  },
  {
    shape: 'header pair array',
    payload: { headers: [['x-api-key', 'sk-live-leakedvalue']] },
    secrets: ['sk-live-leakedvalue'],
  },
  {
    shape: 'name/value header objects',
    payload: [{ name: 'x-api-key', value: 'sk-live-leakedvalue' }],
    secrets: ['sk-live-leakedvalue'],
  },
  {
    shape: 'field names outside the redaction list',
    payload: {
      apiToken: 'leaked-api-token',
      authToken: 'leaked-auth-token',
      private_key: 'leaked-private-key',
      cookie: 'leaked-cookie',
      pwd: 'leaked-pwd',
      key: 'leaked-bare-key',
    },
    secrets: ['leaked-api-token', 'leaked-auth-token', 'leaked-private-key', 'leaked-cookie', 'leaked-pwd', 'leaked-bare-key'],
  },
  {
    shape: 'token in a URL query string',
    payload: { requestUrl: 'https://api.provider.test/v1/chat?api_key=sk-live-leakedvalue' },
    secrets: ['sk-live-leakedvalue'],
  },
  {
    shape: 'credential in URL userinfo',
    payload: { upstream: 'https://user:leaked-password@api.provider.test/v1' },
    secrets: ['leaked-password'],
  },
  {
    shape: 'bare credential in prose with no field name',
    payload: { detail: '401 invalid credential sk-ant-api03-leakedvalue' },
    secrets: ['sk-ant-api03-leakedvalue'],
  },
  {
    shape: 'echo of the rejected /connect body',
    payload: { rejectedBody: { type: 'api', key: 'sk-ant-api03-leakedvalue' } },
    secrets: ['sk-ant-api03-leakedvalue'],
  },
];

test('an unrecognised payload shape is never rendered — every known leaking shape yields the constant', () => {
  for (const { shape, payload, secrets } of leakingPayloadShapes) {
    const surfaced = getOpenCodeErrorMessage(payload);
    assert.equal(surfaced, genericErrorMessage, `${shape} must not be rendered into surfaced text`);
    for (const secret of secrets) {
      assert.ok(!surfaced.includes(secret), `${shape} leaked ${secret}`);
    }
  }
});

test('an unrecognised-shape rate-limit still auto-retries while its text stays out of the topic', () => {
  // The retry classifier reads a classification-ONLY serialisation of the raw
  // payload, so suppressing the rendered text costs no auto-retry. Before that
  // split, feeding the classifier the constant silently cancelled the retry of a
  // real rate limit — and rendering the payload to keep the retry leaked keys.
  const { adapter, outputs, apiErrors } = createAdapterWithSession();
  const payload = {
    providerFailure: {
      status: 429,
      detail: 'rate limited by upstream, retry later',
      apiKey: 'provider-secret-value',
    },
  };

  adapter['handleSessionError'](key, own, { error: payload });

  assert.deepEqual(apiErrors, [{ kind: 'transient' }], 'the unrecognised-shape rate limit must still arm the retry');
  assert.deepEqual(outputs, [`OpenCode error: ${genericErrorMessage}`]);
  for (const payloadValue of ['provider-secret-value', 'rate limited by upstream', '429', 'providerFailure']) {
    assert.ok(!outputs[0].includes(payloadValue), `surfaced text must not carry the payload value ${payloadValue}`);
  }
});

test('an unrecognised-shape message error surfaces the constant too', () => {
  const { adapter, outputs } = createAdapterWithSession();
  adapter['handleMessageUpdate'](key, {
    info: { sessionID: own, role: 'assistant', error: { rejectedBody: { type: 'api', key: 'sk-ant-api03-leakedvalue' } } },
  });

  assert.deepEqual(outputs, [`Error: ${genericErrorMessage}`]);
});

test('the string path redacts each leaking shape best-effort, since it IS surfaced', () => {
  // An HTTP error-response body reaches the user verbatim (minus redaction), so
  // the value-shape pass must catch credentials the field-name rule cannot see.
  const redactedStrings: { shape: string; text: string; secrets: string[] }[] = [
    { shape: 'escaped nested JSON', text: '{"data":{"responseBody":"{\\"api_key\\":\\"sk-ant-api03-leakedvalue\\"}"}}', secrets: ['sk-ant-api03-leakedvalue'] },
    { shape: 'header pair array', text: '{"headers":[["x-api-key","sk-live-leakedvalue"]]}', secrets: ['sk-live-leakedvalue'] },
    { shape: 'name/value header objects', text: '[{"name":"x-api-key","value":"sk-live-leakedvalue"}]', secrets: ['sk-live-leakedvalue'] },
    { shape: 'apiToken field', text: 'apiToken=leaked-api-token', secrets: ['leaked-api-token'] },
    { shape: 'authToken field', text: 'authToken: leaked-auth-token', secrets: ['leaked-auth-token'] },
    { shape: 'private_key field', text: '{"private_key":"leaked-private-key"}', secrets: ['leaked-private-key'] },
    { shape: 'cookie field', text: 'Cookie: leaked-cookie', secrets: ['leaked-cookie'] },
    { shape: 'pwd field', text: 'pwd=leaked-pwd', secrets: ['leaked-pwd'] },
    { shape: 'bare key field', text: '{"key":"leaked-bare-key"}', secrets: ['leaked-bare-key'] },
    { shape: 'client_secret field', text: 'client_secret=leaked-client-secret', secrets: ['leaked-client-secret'] },
    { shape: 'signature field', text: 'signature=leaked-signature', secrets: ['leaked-signature'] },
    { shape: 'token in a URL query string', text: 'GET https://api.provider.test/v1/chat?api_key=sk-live-leakedvalue failed', secrets: ['sk-live-leakedvalue'] },
    { shape: 'credential in URL userinfo', text: 'proxy https://user:leaked-password@api.provider.test/v1 refused', secrets: ['leaked-password'] },
    { shape: 'bare credential in prose', text: '401 invalid credential sk-ant-api03-leakedvalue', secrets: ['sk-ant-api03-leakedvalue'] },
    { shape: 'github token in prose', text: 'rejected token ghp_leakedvalue0123456789', secrets: ['ghp_leakedvalue0123456789'] },
    { shape: 'google api key in prose', text: 'rejected AIzaLeakedValue0123456789 by upstream', secrets: ['AIzaLeakedValue0123456789'] },
    { shape: 'JWT in prose', text: 'bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.leakedsignature', secrets: ['eyJhbGciOiJIUzI1NiJ9', 'leakedsignature'] },
  ];

  for (const { shape, text, secrets } of redactedStrings) {
    const surfaced = getOpenCodeErrorMessage(text);
    for (const secret of secrets) {
      assert.ok(!surfaced.includes(secret), `${shape} leaked ${secret} through the string path: ${surfaced}`);
    }
    assert.ok(surfaced.includes('[redacted]'), `${shape} must be marked as redacted, got: ${surfaced}`);
  }
});

test('a redacted value stops at the JSON separator so the rate-limit marker survives', () => {
  // A greedy value alternation ran to the next whitespace and swallowed the rest
  // of the object — here everything up to "retry later", taking both the 429 and
  // the "rate limited" phrase `classifyAgentApiError` needs to arm the retry.
  const surfaced = getOpenCodeErrorMessage(
    '{"providerError":{"token":null,"status":429,"reason":"rate limited, retry later"}}',
  );

  assert.ok(surfaced.includes('rate limited'), `the classifiable marker must survive redaction: ${surfaced}`);
  assert.ok(surfaced.includes('429'), `the classifiable status must survive redaction: ${surfaced}`);
  assert.ok(!surfaced.includes('null'), `the token value must still be redacted: ${surfaced}`);
  assert.deepEqual(classifyAgentApiError(surfaced, Date.now()), { kind: 'transient' });
});

test('the surfaced string path is capped so a dumped provider response cannot flood the topic', () => {
  const surfaced = getOpenCodeErrorMessage('x'.repeat(openCodeErrorMessageMaxLength * 2));

  assert.equal(surfaced.length, openCodeErrorMessageMaxLength);
});

test('apiRequest redacts a provider HTTP error body before callers can log or relay it', async () => {
  const adapter = new OpenCodeAdapter();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('Authorization: Bearer provider-secret', { status: 401 })) as typeof fetch;
  try {
    let requestError: Error | null = null;
    try {
      await adapter['apiRequest']('GET', '/provider/auth');
    } catch (error) {
      if (error instanceof Error) requestError = error;
    }

    assert.ok(requestError, 'the rejected HTTP response must throw');
    assert.match(requestError.message, /Authorization: \[redacted\]/);
    assert.doesNotMatch(requestError.message, /provider-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
