/**
 * @description Unit coverage for `readClaudeReattachTranscript` — the pure,
 * combined Claude side of the reattach recap. ONE `fs.readFileSync` derives BOTH
 * the missed-message count (renderable `assistant` turns appended after byte
 * `offset` — the seen-watermark) AND the last-N turns of the WHOLE session (the
 * recap body), so the transcript is read once. `fs.readFileSync` handles short
 * reads internally, so a large `[offset, EOF)` tail never undercounts.
 *
 * Fixtures are shaped like real Claude transcripts (same schema as
 * `claudeRecentTurns.test.ts`). The offset is computed as the exact UTF-8 byte
 * length of the "already seen" prefix so the byte-slice tail is exercised, not
 * faked.
 *
 * Test case: N/A — telegramCode has no Jira tracker. TODO: add a test-case key
 * if one is ever created.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readClaudeReattachTranscript } from '../adapters/claudeCliAdapter';
import type { RecentTurn } from '../types';

function serialize(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

const seen = [
  { type: 'user', message: { role: 'user', content: 'old prompt' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer (already seen)' }] } },
];
const missed = [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'missed answer 1' }] } },
  // Meta + tool-only assistant + a user turn must NOT count toward "agent messages".
  { type: 'summary', summary: 'a branch summary', leafUuid: 'whatever' },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
  { type: 'user', message: { role: 'user', content: 'mid prompt' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'missed answer 2' }] } },
];

// The last 3 renderable turns of the WHOLE session (whatever the offset is):
// assistant "missed answer 1" → user "mid prompt" → assistant "missed answer 2".
const expectedLastTurns: RecentTurn[] = [
  { role: 'assistant', text: 'missed answer 1' },
  { role: 'user', text: 'mid prompt' },
  { role: 'assistant', text: 'missed answer 2' },
];

const limit = 3;

describe('readClaudeReattachTranscript', () => {
  let dir: string;
  const seenText = serialize(seen);
  const offset = Buffer.byteLength(seenText, 'utf-8');

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reattach-recap-'));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts only assistant turns with text appended after the offset AND returns the last turns of the whole file', () => {
    const filePath = path.join(dir, 'mixed.jsonl');
    fs.writeFileSync(filePath, seenText + serialize(missed));
    const { missedCount, turns } = readClaudeReattachTranscript(filePath, offset, limit);
    // missed answer 1 + missed answer 2; the summary, the tool-only assistant
    // and the user turn do not count.
    assert.equal(missedCount, 2);
    assert.deepEqual(turns, expectedLastTurns);
  });

  it('returns missedCount 0 at EOF but the turn body stays the last-3 of the whole session', () => {
    const filePath = path.join(dir, 'at-eof.jsonl');
    fs.writeFileSync(filePath, seenText + serialize(missed));
    const wholeSize = Buffer.byteLength(seenText + serialize(missed), 'utf-8');
    const { missedCount, turns } = readClaudeReattachTranscript(filePath, wholeSize, limit);
    assert.equal(missedCount, 0, 'nothing appended since the watermark');
    // Offset near/at EOF must NOT shrink the body — it is the last-3 of the
    // WHOLE session, not just the (empty) missed region.
    assert.deepEqual(turns, expectedLastTurns);
  });

  it('counts every assistant turn in the file when offset is 0', () => {
    const filePath = path.join(dir, 'from-zero.jsonl');
    fs.writeFileSync(filePath, seenText + serialize(missed));
    const { missedCount, turns } = readClaudeReattachTranscript(filePath, 0, limit);
    // old answer + missed answer 1 + missed answer 2 = 3.
    assert.equal(missedCount, 3);
    assert.deepEqual(turns, expectedLastTurns);
  });

  it('returns missedCount 0 when the offset is past EOF (transcript truncated / rewritten smaller)', () => {
    const filePath = path.join(dir, 'shrunk.jsonl');
    fs.writeFileSync(filePath, seenText);
    const { missedCount, turns } = readClaudeReattachTranscript(filePath, 10_000_000, limit);
    assert.equal(missedCount, 0);
    // Body falls back to the whole (short) file's turns.
    assert.deepEqual(turns, [
      { role: 'user', text: 'old prompt' },
      { role: 'assistant', text: 'old answer (already seen)' },
    ]);
  });

  it('tolerates a torn leading line (offset landing mid-record) and counts the rest', () => {
    const filePath = path.join(dir, 'torn.jsonl');
    fs.writeFileSync(filePath, seenText + serialize(missed));
    // Start 5 bytes BEFORE the real line boundary: the first (torn) line fails
    // to parse and is skipped, but the two missed answers still count.
    const { missedCount } = readClaudeReattachTranscript(filePath, offset - 5, limit);
    assert.equal(missedCount, 2);
  });

  it('returns an empty recap for a missing file', () => {
    const result = readClaudeReattachTranscript(path.join(dir, 'nope.jsonl'), 0, limit);
    assert.deepEqual(result, { missedCount: 0, turns: [] });
  });
});
