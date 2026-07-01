/**
 * @description Unit tests for {@link ../adapters/claudeCliAdapter#getClaudeAgentErrorLine}
 * (plan S2) — the pure detector that finds a terminal provider / logged-out error
 * row in a scraped Claude pane WITHOUT false-firing on the agent's own answer
 * prose. A live 401 / logout is not inducible on demand (documented in
 * CLAUDE.md), so these REAL scraped line samples are the load-bearing proof.
 *
 * Test case: <unknown — ask user>
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getClaudeAgentErrorLine } from '../adapters/claudeCliAdapter';
import { classifyAgentApiError } from '../apiErrorRetry';

const fixedNow = Date.parse('2026-07-01T10:00:00.000Z');

test('detect (a): `API Error:` at line start → the line', () => {
  const line = 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';
  assert.equal(getClaudeAgentErrorLine(line), line);
});

test('detect (a): leading whitespace before `API Error:` still matches', () => {
  assert.equal(getClaudeAgentErrorLine('   API Error: 500 upstream'), '   API Error: 500 upstream');
});

test('detect (b): `⎿ … · API Error: 429` → the line (the old start-anchored gate missed this)', () => {
  const line = '⎿  overloaded · API Error: 429';
  assert.equal(getClaudeAgentErrorLine(line), line);
});

test('detect (c): `⎿  Not logged in · Please run /login` → the line', () => {
  const line = '⎿  Not logged in · Please run /login';
  assert.equal(getClaudeAgentErrorLine(line), line);
});

test('detect (c): mixed `⎿  Please run /login · API Error: 401 …` → the line', () => {
  const line = '⎿  Please run /login · API Error: 401 Invalid authentication credentials';
  assert.equal(getClaudeAgentErrorLine(line), line);
});

test('detect: finds the error row inside a full multi-line pane', () => {
  const pane = [
    '● Here is what I found in the code:',
    'The auth module reads a token from disk.',
    '⎿  Not logged in · Please run /login',
    '❯ ',
  ].join('\n');
  assert.equal(getClaudeAgentErrorLine(pane), '⎿  Not logged in · Please run /login');
});

test('NEGATIVE: agent prose quoting "not logged in" mid-sentence (no ⎿) → null', () => {
  const pane = [
    '● To reproduce: the user said they were not logged in yesterday,',
    'so the request failed. Run /login to fix it.',
    '❯ ',
  ].join('\n');
  assert.equal(getClaudeAgentErrorLine(pane), null);
});

test('NEGATIVE: prose with "API Error:" quoted mid-line (not at start, no ⎿) → null', () => {
  assert.equal(
    getClaudeAgentErrorLine('I saw an API Error: earlier but it recovered on its own'),
    null,
  );
});

test('end-to-end: a detected auth row classifies to auth (the whole Claude logged-out path)', () => {
  const line = getClaudeAgentErrorLine('⎿  Not logged in · Please run /login');
  assert.ok(line !== null);
  assert.deepEqual(classifyAgentApiError(line, fixedNow), { kind: 'auth' });
});

test('end-to-end: a detected `⎿ … 429` row classifies to transient', () => {
  const line = getClaudeAgentErrorLine('⎿  overloaded · API Error: 429');
  assert.ok(line !== null);
  assert.deepEqual(classifyAgentApiError(line, fixedNow), { kind: 'transient' });
});
