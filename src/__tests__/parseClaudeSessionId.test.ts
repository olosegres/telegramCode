/**
 * @description Unit coverage for `parseClaudeSessionIdFromCommand` —
 * the pure helper that pulls `--session-id <uuid>` out of a claude
 * command line. Used by the reattach reconciliation path (when
 * `state.json` lost track of which agent owns a live tmux session, the
 * bot recovers the UUID directly from `pane_start_command` instead of
 * killing the user's work as an "orphan"). See plan
 * `agent/tasks/actual/2026-05-15-fix-adapter-desync.md` S4.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseClaudeSessionIdFromCommand } from '../adapters/claudeCliAdapter';

const realUuid = '1dbdf91f-ff38-4e8a-9324-eb32ff06ed9b';

test('extracts UUID from single-quoted argv (production shape)', () => {
  // Mirrors what `new-session ... <shell-command>` actually stores in
  // `pane_start_command` after the bot single-quotes every argv element.
  const cmd =
    "'/home/user/.nvm/versions/node/v22.22.1/bin/claude'" +
    " '--dangerously-skip-permissions'" +
    ` '--session-id' '${realUuid}'`;
  assert.equal(parseClaudeSessionIdFromCommand(cmd), realUuid);
});

test('extracts UUID from bare-space argv', () => {
  const cmd = `/usr/local/bin/claude --dangerously-skip-permissions --session-id ${realUuid}`;
  assert.equal(parseClaudeSessionIdFromCommand(cmd), realUuid);
});

test('extracts UUID from `--session-id=uuid` form', () => {
  const cmd = `claude --session-id=${realUuid}`;
  assert.equal(parseClaudeSessionIdFromCommand(cmd), realUuid);
});

test('extracts UUID from double-quoted form', () => {
  const cmd = `claude --session-id "${realUuid}"`;
  assert.equal(parseClaudeSessionIdFromCommand(cmd), realUuid);
});

test('lowercases an upper-case UUID so downstream consumers see canonical form', () => {
  const upper = realUuid.toUpperCase();
  const cmd = `claude --session-id ${upper}`;
  assert.equal(parseClaudeSessionIdFromCommand(cmd), realUuid);
});

test('extracts UUID even when other flags follow', () => {
  const cmd =
    `claude --dangerously-skip-permissions --session-id ${realUuid}` +
    ` --mcp-config /tmp/foo.json --mcp-config /tmp/bar.json`;
  assert.equal(parseClaudeSessionIdFromCommand(cmd), realUuid);
});

test('returns null when the flag is absent', () => {
  const cmd = `claude --dangerously-skip-permissions --resume some-other-flag`;
  assert.equal(parseClaudeSessionIdFromCommand(cmd), null);
});

test('returns null on empty input', () => {
  assert.equal(parseClaudeSessionIdFromCommand(''), null);
});

test('returns null on garbage (non-UUID) after the flag', () => {
  // 35 hex chars + dashes — looks UUID-shaped but is one char short.
  const cmd = `claude --session-id 1dbdf91f-ff38-4e8a-9324-eb32ff06ed9`;
  assert.equal(parseClaudeSessionIdFromCommand(cmd), null);
});

test('refuses to truncate a 37-char hex tail to the first 36 chars', () => {
  // Defence-in-depth: production input is our own `pane_start_command`,
  // but the lookahead anchor refuses to silently shave the trailing hex
  // and pass an invalid garbage string back as "valid UUID".
  const cmd = `claude --session-id ${realUuid}9`; // 37 hex chars, no terminator
  assert.equal(parseClaudeSessionIdFromCommand(cmd), null);
});

test('returns null on a non-hex string of the right length', () => {
  // Same shape as a UUID but with non-hex characters mixed in.
  const cmd = `claude --session-id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`;
  assert.equal(parseClaudeSessionIdFromCommand(cmd), null);
});

test('does not match unrelated `session-id` substrings (no leading --)', () => {
  // Defence-in-depth: a comment or log line containing "session-id <uuid>"
  // shouldn't be mistaken for the flag.
  const cmd = `# previous session-id ${realUuid} archived, fresh start`;
  assert.equal(parseClaudeSessionIdFromCommand(cmd), null);
});
