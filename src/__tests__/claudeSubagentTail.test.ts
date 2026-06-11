/**
 * @description Sub-agent transcript tail decisions (`/subagent full` on the
 * Claude backend, plan 2026-06-11-subagent-claude-and-progress-flood S3).
 *
 * Load-bearing intent (per `.claude/rules/tests.md`): every rule that keeps
 * the live topic clean is asserted on REAL outcomes, not just "no crash" —
 * the first scan must produce zero reads while still recording offsets (no
 * backlog replay on resume/adopt), a compact-mode tick must advance offsets
 * without asking the caller to read (a later flip to `full` streams only
 * from that moment), a partial line split across two reads must re-pair via
 * the carry, and extraction must keep ONLY assistant `text` blocks (child
 * thinking / tool_use / user / attachment never reach Telegram).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkIsSubagentTranscriptName,
  createSubagentTailState,
  extractAppendedSubagentTexts,
  getSubagentTailReads,
} from '../utils/claudeSubagentTail';

/** Build one transcript JSONL line the way Claude writes it on disk. */
function buildEntryLine(type: string, content: unknown): string {
  return JSON.stringify({ type, isSidechain: true, agentId: 'a1', message: { role: type, content } });
}

const assistantTextLine = (text: string) => buildEntryLine('assistant', [{ type: 'text', text }]);

describe('checkIsSubagentTranscriptName', () => {
  it('accepts agent-<id>.jsonl and rejects meta/json/other files', () => {
    assert.equal(checkIsSubagentTranscriptName('agent-abc123.jsonl'), true);
    assert.equal(checkIsSubagentTranscriptName('agent-abc123.meta.json'), false);
    assert.equal(checkIsSubagentTranscriptName('agent-.jsonl'), false);
    assert.equal(checkIsSubagentTranscriptName('session.jsonl'), false);
  });
});

describe('getSubagentTailReads', () => {
  it('first scan seeds every existing file to EOF and returns NO reads (no backlog replay)', () => {
    const state = createSubagentTailState();
    const reads = getSubagentTailReads(
      state,
      [{ fileName: 'agent-a.jsonl', sizeBytes: 500 }, { fileName: 'agent-b.jsonl', sizeBytes: 0 }],
      'full',
    );
    assert.deepEqual(reads, []);
    assert.equal(state.isFirstScanDone, true);
    // Offsets must sit at EOF: the next grown scan reads ONLY the appended range.
    const grown = getSubagentTailReads(state, [{ fileName: 'agent-a.jsonl', sizeBytes: 620 }], 'full');
    assert.deepEqual(grown, [{ fileName: 'agent-a.jsonl', startOffset: 500, endOffset: 620 }]);
  });

  it('first scan with an empty dir still flips the flag, so later files are not treated as backlog', () => {
    const state = createSubagentTailState();
    assert.deepEqual(getSubagentTailReads(state, [], 'full'), []);
    assert.equal(state.isFirstScanDone, true);
  });

  it('mode != full fast-forwards offsets WITHOUT asking the caller to read', () => {
    const state = createSubagentTailState();
    getSubagentTailReads(state, [{ fileName: 'agent-a.jsonl', sizeBytes: 100 }], 'compact');
    // File grew by 200 bytes while in compact mode — no read, offset jumps.
    const compactReads = getSubagentTailReads(state, [{ fileName: 'agent-a.jsonl', sizeBytes: 300 }], 'compact');
    assert.deepEqual(compactReads, []);
    // Flip to full: only bytes appended AFTER the flip are read.
    const fullReads = getSubagentTailReads(state, [{ fileName: 'agent-a.jsonl', sizeBytes: 450 }], 'full');
    assert.deepEqual(fullReads, [{ fileName: 'agent-a.jsonl', startOffset: 300, endOffset: 450 }]);
  });

  it('a file first seen AFTER the first scan starts at offset 0 in full mode', () => {
    const state = createSubagentTailState();
    getSubagentTailReads(state, [], 'full');
    const reads = getSubagentTailReads(state, [{ fileName: 'agent-new.jsonl', sizeBytes: 42 }], 'full');
    assert.deepEqual(reads, [{ fileName: 'agent-new.jsonl', startOffset: 0, endOffset: 42 }]);
  });

  it('a file first seen after the first scan in compact mode is fast-forwarded, not read', () => {
    const state = createSubagentTailState();
    getSubagentTailReads(state, [], 'compact');
    assert.deepEqual(getSubagentTailReads(state, [{ fileName: 'agent-new.jsonl', sizeBytes: 42 }], 'compact'), []);
    // Its offset must sit at 42 now: flipping to full streams only new bytes.
    assert.deepEqual(getSubagentTailReads(state, [{ fileName: 'agent-new.jsonl', sizeBytes: 50 }], 'full'),
      [{ fileName: 'agent-new.jsonl', startOffset: 42, endOffset: 50 }]);
  });

  it('an unchanged file produces no read; a truncated file re-seeds to its new EOF', () => {
    const state = createSubagentTailState();
    getSubagentTailReads(state, [{ fileName: 'agent-a.jsonl', sizeBytes: 100 }], 'full');
    assert.deepEqual(getSubagentTailReads(state, [{ fileName: 'agent-a.jsonl', sizeBytes: 100 }], 'full'), []);
    // Shrunk below the recorded offset (rewrite) — never replay from 0.
    assert.deepEqual(getSubagentTailReads(state, [{ fileName: 'agent-a.jsonl', sizeBytes: 30 }], 'full'), []);
    assert.deepEqual(getSubagentTailReads(state, [{ fileName: 'agent-a.jsonl', sizeBytes: 45 }], 'full'),
      [{ fileName: 'agent-a.jsonl', startOffset: 30, endOffset: 45 }]);
  });
});

describe('extractAppendedSubagentTexts', () => {
  /** Seed a state past the first scan with one known empty file. */
  function createStateWithFile(fileName: string) {
    const state = createSubagentTailState();
    getSubagentTailReads(state, [{ fileName, sizeBytes: 0 }], 'full');
    return state;
  }

  it('extracts assistant text blocks in order; drops thinking/tool_use blocks and user/attachment entries', () => {
    const state = createStateWithFile('agent-a.jsonl');
    const appended = [
      buildEntryLine('user', [{ type: 'text', text: 'user prompt — never rendered' }]),
      buildEntryLine('assistant', [
        { type: 'thinking', thinking: 'secret chain of thought' },
        { type: 'text', text: 'first answer block' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        { type: 'text', text: 'second answer block' },
      ]),
      buildEntryLine('attachment', [{ type: 'text', text: 'attachment — never rendered' }]),
      assistantTextLine('next turn'),
      '',
    ].join('\n');
    const texts = extractAppendedSubagentTexts(state, 'agent-a.jsonl', appended);
    assert.deepEqual(texts, ['first answer block', 'second answer block', 'next turn']);
  });

  it('carries a partial line across two reads and re-pairs it', () => {
    const state = createStateWithFile('agent-a.jsonl');
    const fullLine = assistantTextLine('split across reads');
    const cutAt = Math.floor(fullLine.length / 2);
    // First read ends mid-line: nothing complete yet, the tail is carried.
    assert.deepEqual(extractAppendedSubagentTexts(state, 'agent-a.jsonl', fullLine.slice(0, cutAt)), []);
    // Second read completes the line (+ newline): the re-paired JSON parses.
    const texts = extractAppendedSubagentTexts(state, 'agent-a.jsonl', `${fullLine.slice(cutAt)}\n`);
    assert.deepEqual(texts, ['split across reads']);
  });

  it('a malformed JSON line is skipped without losing subsequent lines', () => {
    const state = createStateWithFile('agent-a.jsonl');
    const appended = `{torn write, not JSON\n${assistantTextLine('survives the bad line')}\n`;
    const texts = extractAppendedSubagentTexts(state, 'agent-a.jsonl', appended);
    assert.deepEqual(texts, ['survives the bad line']);
  });

  it('returns nothing for a file the planner never registered', () => {
    const state = createSubagentTailState();
    assert.deepEqual(extractAppendedSubagentTexts(state, 'agent-ghost.jsonl', `${assistantTextLine('x')}\n`), []);
  });

  it('whitespace-only text blocks are dropped (nothing to render)', () => {
    const state = createStateWithFile('agent-a.jsonl');
    const appended = `${buildEntryLine('assistant', [{ type: 'text', text: '   ' }])}\n`;
    assert.deepEqual(extractAppendedSubagentTexts(state, 'agent-a.jsonl', appended), []);
  });
});
