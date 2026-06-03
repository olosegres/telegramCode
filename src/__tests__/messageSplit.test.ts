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
import { splitMessage, rebalanceFences } from '../messageSplit';

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
