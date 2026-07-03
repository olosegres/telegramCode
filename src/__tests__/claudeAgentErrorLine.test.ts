/**
 * @description Unit tests for {@link ../adapters/claudeCliAdapter#getClaudeAgentErrorLine}
 * (plan S2) — the pure detector that finds a terminal provider / logged-out error
 * row in a scraped Claude pane WITHOUT false-firing on the agent's own answer
 * prose. A live 401 / logout is not inducible on demand (documented in
 * CLAUDE.md), so these REAL scraped line samples are the load-bearing proof.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getClaudeAgentErrorLine } from '../adapters/claudeCliAdapter';
import { classifyAgentApiError } from '../apiErrorRetry';
import { getNewPaneContent } from '../utils/paneDiff';

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

// A TOOL result (Bash/Read/Grep) is rendered by the TUI UNDER a `⎿` marker, so a
// row starting with `⎿` that merely QUOTES an auth phrase deeper in the line must
// NOT fire — case (c) anchors the phrase to the row start. These are the exact
// live samples the agent tripped while grepping the bot's own logs/source in
// topic 434 (2026-07-03).
test('NEGATIVE: a `⎿` tool-result row QUOTING the auth phrase deeper in the line → null', () => {
  // grep of the console log printing an old detection line under a Bash `⎿`.
  const grepEcho =
    '⎿  bot-console-2026070322.log:224:[Claude] API error detected: Not logged in · Please run /login';
  assert.equal(getClaudeAgentErrorLine(grepEcho), null);
  // a Read of apiErrorRetry.ts source whose comment lists the phrases.
  const sourceEcho = '⎿  67: * @description The auth phrases (please run /login, not logged in).';
  assert.equal(getClaudeAgentErrorLine(sourceEcho), null);
  // a real third-party CLI ("not logged in") under a `⎿` tool result.
  const ghEcho = '⎿  gh: not logged in to github.com. Run: gh auth login';
  assert.equal(getClaudeAgentErrorLine(ghEcho), null);
});

test('POSITIVE still holds: a real auth row LEADS with the phrase → detected', () => {
  assert.equal(
    getClaudeAgentErrorLine('⎿  Not logged in · Please run /login'),
    '⎿  Not logged in · Please run /login',
  );
  assert.equal(
    getClaudeAgentErrorLine('⎿  Please run /login · API Error: 401 Invalid authentication credentials'),
    '⎿  Please run /login · API Error: 401 Invalid authentication credentials',
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

// Regression for the topic-434 re-pin loop (live 2026-07-03): the logged-out
// `⎿ … /login` row lingers in the pane scrollback long after the user re-logs
// in. `handleAutoLifecycle` must detect it on the NEW pane delta, so the row
// fires `apiError('auth')` ONCE (first render) — not on every later redraw,
// which re-pinned "logged out, run /login" after a successful login. This walks
// the real set-diff (getNewPaneContent) that feeds the detector.
test('fire-once: a persistent logged-out row is NEW only on first appearance', () => {
  const paneBefore = ['● Working on it…', '❯ '].join('\n');
  const paneWithError = [
    '● Working on it…',
    '⎿  Not logged in · Please run /login',
    '❯ ',
  ].join('\n');

  // Poll 1 — the row first renders: it IS in the delta → detected + classified.
  const firstDelta = getNewPaneContent(paneBefore, paneWithError).text;
  const firstLine = getClaudeAgentErrorLine(firstDelta);
  assert.ok(firstLine !== null, 'first appearance must be detected');
  assert.deepEqual(classifyAgentApiError(firstLine, fixedNow), { kind: 'auth' });

  // Poll 2 — the login menu redraws while the SAME stale row still sits on the
  // pane. The set-diff yields only the new menu lines; the row is NOT new, so
  // the detector returns null and `apiError('auth')` does NOT re-fire.
  const paneLoginMenu = [
    '● Working on it…',
    '⎿  Not logged in · Please run /login',
    'Login',
    'Claude Code can be used with your Claude subscription…',
    '1. Subscription',
    '❯ ',
  ].join('\n');
  const secondDelta = getNewPaneContent(paneWithError, paneLoginMenu).text;
  assert.equal(
    getClaudeAgentErrorLine(secondDelta),
    null,
    'a stale logout row must not re-fire on a later redraw',
  );
});
