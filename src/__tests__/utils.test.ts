/**
 * @description In groups, Telegram appends `@botusername` to slash commands
 * (`/compact` → `/compact@my_bot`). We forward un-owned slash commands verbatim
 * to the agent CLI, which doesn't recognise the suffix — so it must be stripped
 * BEFORE forwarding (the /compact bug). `stripCommandBotMention` does exactly
 * that, and only that — ordinary text and mid-text `@`s must survive.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { stripCommandBotMention } from '../utils';

test('strips @botusername from a bare command', () => {
  assert.equal(stripCommandBotMention('/compact@mybot_telegramcode_bot'), '/compact');
  assert.equal(stripCommandBotMention('/help@some_bot'), '/help');
});

test('strips the mention but preserves arguments', () => {
  assert.equal(
    stripCommandBotMention('/compact@my_bot keep the API notes'),
    '/compact keep the API notes',
  );
});

test('leaves a command without a mention untouched', () => {
  assert.equal(stripCommandBotMention('/compact'), '/compact');
  assert.equal(stripCommandBotMention('/model sonnet'), '/model sonnet');
});

test('does not touch ordinary text or mid-text @mentions', () => {
  assert.equal(stripCommandBotMention('hello world'), 'hello world');
  assert.equal(stripCommandBotMention('email me @ foo please'), 'email me @ foo please');
  assert.equal(stripCommandBotMention('ping @someone about it'), 'ping @someone about it');
  // A mention not glued to a leading command token is left alone.
  assert.equal(stripCommandBotMention('do /compact@bot later'), 'do /compact@bot later');
});

test('only strips the FIRST token mention, not later ones', () => {
  assert.equal(stripCommandBotMention('/say@bot hi @other'), '/say hi @other');
});
