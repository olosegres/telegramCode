/**
 * @description The output-trace `recv` middleware records a preview of every
 * incoming message. While a thread is in the pending `/connect` state the next
 * plain text message IS a provider API key, and an inline `/connect <key>`
 * carries the key in its arguments — neither may land in the on-disk trace.
 * `getRecvTracePreview` is the pure decision layer the middleware applies at
 * record time.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  checkIsConnectCommandText,
  getRecvTracePreview,
  redactedConnectCommandPreview,
  redactedConnectKeyPreview,
} from '../utils/recvPreviewRedaction';

const pastedApiKey = 'sk-proj-AbCdEf0123456789';

test('pending-connect thread: pasted key text is fully redacted', () => {
  assert.equal(getRecvTracePreview(pastedApiKey, true), redactedConnectKeyPreview);
  // Leading whitespace must not defeat the redaction.
  assert.equal(getRecvTracePreview(`  ${pastedApiKey}`, true), redactedConnectKeyPreview);
});

test('pending-connect thread: a command text cancels the flow and is not a secret', () => {
  assert.equal(getRecvTracePreview('/status', true), '/status');
});

test('normal thread: plain text preview is unchanged', () => {
  assert.equal(getRecvTracePreview('fix the login bug', false), 'fix the login bug');
  assert.equal(getRecvTracePreview('/status', false), '/status');
});

test('inline /connect arguments are redacted regardless of pending state', () => {
  assert.equal(getRecvTracePreview(`/connect ${pastedApiKey}`, false), redactedConnectCommandPreview);
  assert.equal(
    getRecvTracePreview(`/connect openai ${pastedApiKey}`, true),
    redactedConnectCommandPreview,
  );
  // Bot-mention form used in groups.
  assert.equal(
    getRecvTracePreview(`/connect@some_bot ${pastedApiKey}`, false),
    redactedConnectCommandPreview,
  );
});

test('checkIsConnectCommandText matches only the /connect command itself', () => {
  assert.equal(checkIsConnectCommandText('/connect'), true);
  assert.equal(checkIsConnectCommandText('/connect openai'), true);
  assert.equal(checkIsConnectCommandText('/connect@some_bot'), true);
  assert.equal(checkIsConnectCommandText('/connected'), false);
  assert.equal(checkIsConnectCommandText('tell me about /connect'), false);
});
