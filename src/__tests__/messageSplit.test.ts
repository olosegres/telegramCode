/**
 * @description S4 — fence-aware chunk splitting. A tool diff/output (now fenced
 * by the Claude adapter) can exceed a Telegram message; cut mid-fence, one
 * chunk has an unclosed ```` ``` ```` and the next an orphan closer, so
 * `renderAgentHtml` renders literal backticks instead of a `<pre>`. The
 * load-bearing property: EVERY produced chunk has a balanced (even) count of
 * line-start fences, so each renders as valid HTML on its own.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  splitMessage,
  rebalanceFences,
  RENDERED_CHUNK_CAP,
  TELEGRAM_HARD_LIMIT,
  MAX_MESSAGE_LEN,
} from '../messageSplit';
import { renderAgentHtml } from '../renderAgentHtml';

const countFences = (text: string): number => (text.match(/^\s*```/gm) ?? []).length;

test('splitMessage: short text is a single untouched chunk', () => {
  assert.deepEqual(splitMessage('hello world'), ['hello world']);
});

test('splitMessage: a balanced fence that fits in one chunk is untouched', () => {
  const text = '```\ncode line\n```';
  assert.deepEqual(splitMessage(text), [text]);
});

test('splitMessage: long non-fenced text splits with no fences introduced', () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const chunks = splitMessage(text, 40);
  assert.ok(chunks.length > 1, 'should split');
  for (const chunk of chunks) assert.equal(countFences(chunk), 0);
});

test('splitMessage: a fence split across chunks is balanced in every chunk', () => {
  const body = Array.from({ length: 30 }, (_, i) => `code row number ${i}`).join('\n');
  const text = `\`\`\`\n${body}\n\`\`\``;
  const chunks = splitMessage(text, 60);
  assert.ok(chunks.length > 1, 'long fenced block should split');
  for (const chunk of chunks) {
    assert.equal(countFences(chunk) % 2, 0, `unbalanced fences in chunk: ${JSON.stringify(chunk)}`);
  }
});

test('rebalanceFences: closes an open fence and reopens it in the next chunk', () => {
  const out = rebalanceFences(['```\nopened', 'closed\n```']);
  assert.equal(out[0], '```\nopened\n```');
  assert.equal(out[1], '```\nclosed\n```');
  for (const chunk of out) assert.equal(countFences(chunk) % 2, 0);
});

test('rebalanceFences: carries an open fence across a fully-interior chunk', () => {
  // Middle chunk has no fence of its own but sits inside an open fence — it
  // must be reopened and reclosed so it renders as code on its own.
  const out = rebalanceFences(['```\nstart', 'middle', 'end\n```']);
  assert.equal(out[1], '```\nmiddle\n```');
  for (const chunk of out) assert.equal(countFences(chunk) % 2, 0);
});

test('rebalanceFences: text without fences is returned unchanged', () => {
  assert.deepEqual(rebalanceFences(['plain a', 'plain b']), ['plain a', 'plain b']);
});

// --- Render-aware splitting (optional `measureRendered`) ---

test('splitMessage: without measureRendered output is byte-identical to legacy', () => {
  // Lock back-compat: the render-aware code path must not perturb the
  // source-length splitting when no measure is supplied.
  const legacySplit = (text: string, maxLen: number): string[] => {
    if (text.length <= maxLen) return [text];
    const parts: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) { parts.push(remaining); break; }
      let cutAt = maxLen;
      const lastNewline = remaining.lastIndexOf('\n', maxLen);
      if (lastNewline > maxLen * 0.5) cutAt = lastNewline;
      parts.push(remaining.slice(0, cutAt));
      remaining = remaining.slice(cutAt).replace(/^\n/, '');
    }
    return rebalanceFences(parts);
  };
  const samples = [
    'hello world',
    Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'),
    `\`\`\`\n${Array.from({ length: 30 }, (_, i) => `code row number ${i}`).join('\n')}\n\`\`\``,
    'a'.repeat(9000),
    `< & > ${'word '.repeat(2000)}`,
  ];
  for (const maxLen of [40, 60, MAX_MESSAGE_LEN]) {
    for (const sample of samples) {
      assert.deepEqual(splitMessage(sample, maxLen), legacySplit(sample, maxLen));
    }
  }
});

test('splitMessage: inflating measure splits a source-fitting chunk under the rendered cap', () => {
  // A measure that doubles length simulates heavy HTML-escaping. The source
  // fits MAX_MESSAGE_LEN, but its rendered (×2) size is over RENDERED_CHUNK_CAP,
  // so it must be split until EVERY chunk's measured length fits.
  const inflate = (chunk: string): number => chunk.length * 2;
  const text = Array.from({ length: 250 }, (_, i) => `line number ${i}`).join('\n');
  assert.ok(text.length <= MAX_MESSAGE_LEN, 'fixture must fit the source cap');
  assert.ok(inflate(text) > RENDERED_CHUNK_CAP, 'fixture must overflow the rendered cap');

  const chunks = splitMessage(text, MAX_MESSAGE_LEN, inflate);
  assert.ok(chunks.length > 1, 'should split by rendered length');
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0, 'no empty chunk');
    assert.ok(inflate(chunk) <= RENDERED_CHUNK_CAP, `rendered chunk over cap: ${inflate(chunk)}`);
  }
});

test('splitMessage: a pathological single un-splittable token still terminates', () => {
  // One huge token with no newline whose every char inflates 3×: back-off has
  // no newline to retreat to, so it must geometrically shrink and still produce
  // non-empty chunks without looping forever.
  const inflate = (chunk: string): number => chunk.length * 3;
  const token = 'x'.repeat(20000);
  const chunks = splitMessage(token, MAX_MESSAGE_LEN, inflate);
  assert.ok(chunks.length > 1, 'should split the giant token');
  let reassembled = '';
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0, 'no empty chunk');
    reassembled += chunk;
  }
  // No newline removal happens (none present), so reassembly is exact.
  assert.equal(reassembled, token, 'split must lose no characters');
});

test('splitMessage: real renderAgentHtml on escapable-heavy text keeps every chunk under the hard limit', () => {
  // Integration: a source full of `<`/`&` (each escapes 4–5×) that fits the
  // source cap but renders far over it. Using the REAL render as the measure,
  // every rendered chunk — AFTER rebalanceFences — must stay under Telegram's
  // hard 4096 limit (the margin reserves room for fence wrappers).
  const escapableLine = '<div> & </div> '.repeat(6);
  const text = Array.from({ length: 40 }, (_, i) => `${i}: ${escapableLine}`).join('\n');
  assert.ok(text.length <= MAX_MESSAGE_LEN, 'fixture must fit the source cap');
  assert.ok(renderAgentHtml(text).length > TELEGRAM_HARD_LIMIT, 'fixture must render over the hard limit');

  const chunks = splitMessage(text, MAX_MESSAGE_LEN, chunk => renderAgentHtml(chunk).length);
  assert.ok(chunks.length > 1, 'should split by rendered length');
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0, 'no empty chunk');
    // The produced chunks are already post-rebalance; assert the final
    // rendered size — the actual thing Telegram receives — fits the hard cap.
    assert.ok(
      renderAgentHtml(chunk).length <= TELEGRAM_HARD_LIMIT,
      `rendered chunk over hard limit: ${renderAgentHtml(chunk).length}`,
    );
  }
});

test('splitMessage: render-aware split of a long fenced block stays valid and under the cap', () => {
  // A long fenced diff full of escapable chars: chunks must stay fence-balanced
  // AND each rendered chunk (post-rebalance) under the hard limit.
  const body = Array.from({ length: 300 }, (_, i) => `- old <${i}> & new <${i}>`).join('\n');
  const text = `\`\`\`diff\n${body}\n\`\`\``;
  const chunks = splitMessage(text, MAX_MESSAGE_LEN, chunk => renderAgentHtml(chunk).length);
  assert.ok(chunks.length > 1, 'long fenced block should split');
  for (const chunk of chunks) {
    assert.equal(countFences(chunk) % 2, 0, `unbalanced fences in chunk: ${JSON.stringify(chunk)}`);
    assert.ok(
      renderAgentHtml(chunk).length <= TELEGRAM_HARD_LIMIT,
      `rendered fenced chunk over hard limit: ${renderAgentHtml(chunk).length}`,
    );
  }
});
