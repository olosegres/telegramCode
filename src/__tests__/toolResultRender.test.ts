/**
 * @description Unit tests for the pure tool-result render helpers
 * (`utils/toolResultRender.ts`) consumed by `bot.ts`'s `handleAgentToolResult`
 * (S3). The mode→action matrix and the dual-cap truncation (lines first, then
 * chars) are unit-testable without the Telegraf machinery (same pattern as
 * `thinkingRender.test.ts`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getToolResultRenderAction,
  getTruncatedToolResult,
  buildFencedToolResultBody,
  checkIsToolResultMode,
  toolResultModeOptions,
  toolResultMaxLines,
  toolResultMaxChars,
} from '../utils/toolResultRender';

describe('getToolResultRenderAction — mode → action matrix', () => {
  it('full → full (whole body rendered)', () => {
    assert.equal(getToolResultRenderAction('full'), 'full');
  });
  it('short → truncated (caps + footer)', () => {
    assert.equal(getToolResultRenderAction('short'), 'truncated');
  });
  it('hide → drop (pre-S3 behavior: only the transient 🔧 status)', () => {
    assert.equal(getToolResultRenderAction('hide'), 'drop');
  });
});

describe('checkIsToolResultMode — narrows /tool_results <arg> without a cast', () => {
  it('accepts every valid mode', () => {
    for (const mode of toolResultModeOptions) {
      assert.equal(checkIsToolResultMode(mode), true, `mode=${mode}`);
    }
  });
  it('rejects unknown / empty / wrong-case input', () => {
    assert.equal(checkIsToolResultMode('verbose'), false);
    assert.equal(checkIsToolResultMode(''), false);
    assert.equal(checkIsToolResultMode('Full'), false);
  });
});

describe('getTruncatedToolResult — dual caps, lines first then chars', () => {
  it('body under both caps → unchanged, isTruncated=false', () => {
    const body = 'line one\nline two\nline three';
    const result = getTruncatedToolResult(body);
    assert.equal(result.text, body);
    assert.equal(result.isTruncated, false);
  });

  it('body over the line cap → exactly the cap of lines, isTruncated=true', () => {
    const body = Array.from({ length: toolResultMaxLines + 10 }, (_, i) => `line ${i}`).join('\n');
    const result = getTruncatedToolResult(body);
    assert.equal(result.text.split('\n').length, toolResultMaxLines);
    assert.equal(result.isTruncated, true);
    // The kept lines are the FIRST ones (head of the output), intact.
    assert.equal(result.text.split('\n')[0], 'line 0');
    assert.equal(result.text.split('\n')[toolResultMaxLines - 1], `line ${toolResultMaxLines - 1}`);
  });

  it('multi-line body over the char cap → cut at a line boundary, ≤ cap chars', () => {
    // 14 lines of 100 chars each (under the line cap) = ~1414 chars total.
    const longLine = 'x'.repeat(100);
    const body = Array.from({ length: 14 }, () => longLine).join('\n');
    const result = getTruncatedToolResult(body);
    assert.ok(result.text.length <= toolResultMaxChars, `len=${result.text.length}`);
    assert.equal(result.isTruncated, true);
    // Never split inside a line when a newline is available within the budget:
    // every kept line must be a complete 100-char line.
    for (const line of result.text.split('\n')) {
      assert.equal(line, longLine);
    }
  });

  it('single line over the char cap → hard cut at the cap (no newline to retreat to)', () => {
    const body = 'y'.repeat(toolResultMaxChars + 500);
    const result = getTruncatedToolResult(body);
    assert.equal(result.text.length, toolResultMaxChars);
    assert.equal(result.isTruncated, true);
  });

  it('both caps bite: line cap first, then char cap on the survivor', () => {
    // 30 lines of 200 chars: the line cap keeps 15 (~3015 chars), the char cap
    // then trims that survivor to ≤1200 at a line boundary.
    const longLine = 'z'.repeat(200);
    const body = Array.from({ length: 30 }, () => longLine).join('\n');
    const result = getTruncatedToolResult(body);
    assert.ok(result.text.length <= toolResultMaxChars, `len=${result.text.length}`);
    assert.ok(result.text.split('\n').length <= toolResultMaxLines);
    assert.equal(result.isTruncated, true);
  });

  it('body exactly AT both caps → unchanged, isTruncated=false', () => {
    // Exactly the line cap of lines, total length exactly the char cap.
    const lineLength = Math.floor((toolResultMaxChars - (toolResultMaxLines - 1)) / toolResultMaxLines);
    const body = Array.from({ length: toolResultMaxLines }, () => 'a'.repeat(lineLength)).join('\n');
    assert.ok(body.length <= toolResultMaxChars);
    const result = getTruncatedToolResult(body);
    assert.equal(result.text, body);
    assert.equal(result.isTruncated, false);
  });
});

describe('buildFencedToolResultBody — fence wrapping stays balanced', () => {
  it('wraps a plain body in exactly one open + one close fence', () => {
    const fenced = buildFencedToolResultBody('hello\nworld');
    assert.equal(fenced, '```\nhello\nworld\n```');
  });

  it('end-trims the body — a trailing newline never leaves a blank line above the closing fence', () => {
    assert.equal(buildFencedToolResultBody('output\n'), '```\noutput\n```');
  });

  it('neutralises inner ``` runs so they cannot close the fence early', () => {
    const fenced = buildFencedToolResultBody('# doc\n```ts\nconst x = 1;\n```\ntail');
    // Only OUR two line-start fences survive — the body's own are broken up
    // by zero-width spaces (load-bearing: an early close would dump the tail
    // outside the <pre> and corrupt the message rendering).
    const lineStartFences = fenced.match(/^\s*```/gm) ?? [];
    assert.equal(lineStartFences.length, 2);
    assert.ok(fenced.includes('const x = 1;'), 'body content preserved');
  });
});
