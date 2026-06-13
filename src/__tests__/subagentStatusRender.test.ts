/**
 * @description Unit tests for the dedicated OpenCode sub-agent status helpers
 * (`utils/subagentStatusRender.ts`). These back the fix for the flood bug
 * (every child-text burst re-`sendMessage`d a new status), so each piece is
 * load-bearing: a wrong `formatElapsed` shows a garbled counter, a wrong
 * lifecycle cell either floods again (`open` when a message exists) or orphans
 * the message (`noop` when one should close).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatElapsed,
  buildSubagentElapsedText,
  getSubagentStatusAction,
} from '../utils/subagentStatusRender';

describe('formatElapsed — m:ss with two-digit seconds', () => {
  it('0 ms → "0:00"', () => {
    assert.equal(formatElapsed(0), '0:00');
  });

  it('7 s → "0:07" (seconds zero-padded)', () => {
    assert.equal(formatElapsed(7000), '0:07');
  });

  it('59 s → "0:59" (still under one minute)', () => {
    assert.equal(formatElapsed(59000), '0:59');
  });

  it('60 s → "1:00" (minute rollover)', () => {
    assert.equal(formatElapsed(60000), '1:00');
  });

  it('843 s → "14:03" (multi-minute, padded seconds)', () => {
    assert.equal(formatElapsed(843000), '14:03');
  });

  it('floors sub-second ms to whole seconds', () => {
    assert.equal(formatElapsed(7999), '0:07');
  });
});

describe('buildSubagentElapsedText — status line', () => {
  it('embeds the title, the marker and the elapsed counter', () => {
    const text = buildSubagentElapsedText('Implement timeline quick filters', 42000);
    assert.ok(text.includes('Implement timeline quick filters'), 'title embedded');
    assert.ok(text.includes('🤖'), 'sub-agent marker present');
    assert.ok(text.includes('0:42'), 'elapsed counter embedded');
  });

  it('null title falls back to a non-empty generic label (never "null")', () => {
    const text = buildSubagentElapsedText(null, 0);
    assert.ok(!text.includes('null'));
    assert.ok(text.includes('🤖'));
    assert.ok(text.includes('0:00'), 'elapsed counter still rendered');
  });
});

describe('getSubagentStatusAction — lifecycle truth table', () => {
  it('active + no message → open', () => {
    assert.equal(getSubagentStatusAction({ hasMessage: false, eventActive: true }), 'open');
  });

  it('active + message exists → refresh', () => {
    assert.equal(getSubagentStatusAction({ hasMessage: true, eventActive: true }), 'refresh');
  });

  it('inactive + message exists → close', () => {
    assert.equal(getSubagentStatusAction({ hasMessage: true, eventActive: false }), 'close');
  });

  it('inactive + no message → noop (defensive close is idempotent)', () => {
    assert.equal(getSubagentStatusAction({ hasMessage: false, eventActive: false }), 'noop');
  });
});
