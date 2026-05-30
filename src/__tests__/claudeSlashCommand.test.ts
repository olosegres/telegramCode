/**
 * @description A bare slash command forwarded to Claude (`/compact`, `/clear`,
 * …) opens the TUI's autocomplete popup, so the adapter must DEFER its Enter
 * until the popup settles — otherwise the Enter accepts the highlight instead
 * of running the command and it silently no-ops. `checkIsBareSlashCommand` is
 * the predicate that gates that deferral; commands WITH an argument already
 * dismissed the popup (the space) and must NOT be treated as bare.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkIsBareSlashCommand } from '../adapters/claudeCliAdapter';

test('bare slash commands are detected (Enter must be deferred)', () => {
  for (const cmd of ['/compact', '/clear', '/context', '/cost', '/help', '  /compact  ']) {
    assert.equal(checkIsBareSlashCommand(cmd), true, `expected ${JSON.stringify(cmd)} to be bare`);
  }
});

test('slash commands WITH an argument are NOT bare (popup already closed)', () => {
  for (const cmd of ['/model sonnet', '/effort high', '/compact keep the API notes']) {
    assert.equal(checkIsBareSlashCommand(cmd), false, `expected ${JSON.stringify(cmd)} to be non-bare`);
  }
});

test('ordinary prose and non-commands are NOT bare', () => {
  for (const txt of ['hello', '', '/', '/123', '/with space', 'do /compact later', 'compact']) {
    assert.equal(checkIsBareSlashCommand(txt), false, `expected ${JSON.stringify(txt)} to be non-bare`);
  }
});
