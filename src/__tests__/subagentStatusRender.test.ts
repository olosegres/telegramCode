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
  checkShouldSendSubagentStatus,
  checkShouldEnqueueSubagentStatus,
  checkShouldExpireSubagentStatus,
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

describe('checkShouldSendSubagentStatus — S1 dedup gate', () => {
  it('identical text → false (skip the edit, no 400 "not modified" churn)', () => {
    assert.equal(checkShouldSendSubagentStatus('🤖 sub-agent: X · 3:21', '🤖 sub-agent: X · 3:21'), false);
  });

  it('changed elapsed → true (a real m:ss tick still lands)', () => {
    assert.equal(checkShouldSendSubagentStatus('🤖 sub-agent: X · 3:31', '🤖 sub-agent: X · 3:21'), true);
  });

  it('changed title → true (a title upgrade still lands)', () => {
    assert.equal(checkShouldSendSubagentStatus('🤖 sub-agent: Y · 0:10', '🤖 sub-agent: X · 0:10'), true);
  });

  it('null last text (fresh open / post-clear) → true (always send the first edit)', () => {
    assert.equal(checkShouldSendSubagentStatus('🤖 sub-agent: X · 0:10', null), true);
  });
});

describe('checkShouldEnqueueSubagentStatus — coalescing gate (live 2026-08-07, topic 61130)', () => {
  const text = '🤖 sub-agent: X · 3:54';

  it('an edit already in flight → false (never stack a second onto the FIFO)', () => {
    assert.equal(
      checkShouldEnqueueSubagentStatus({ nextText: text, lastEnqueuedText: '🤖 sub-agent: X · 3:53', isEditInFlight: true }),
      false,
    );
  });

  it('same text as last ENQUEUED, nothing in flight → false (dedup at decision time)', () => {
    assert.equal(
      checkShouldEnqueueSubagentStatus({ nextText: text, lastEnqueuedText: text, isEditInFlight: false }),
      false,
    );
  });

  it('changed text, nothing in flight → true (a real m:ss tick still lands)', () => {
    assert.equal(
      checkShouldEnqueueSubagentStatus({ nextText: '🤖 sub-agent: X · 3:55', lastEnqueuedText: text, isEditInFlight: false }),
      true,
    );
  });

  it('first edit (null last, nothing in flight) → true', () => {
    assert.equal(
      checkShouldEnqueueSubagentStatus({ nextText: '🤖 sub-agent: X · 0:00', lastEnqueuedText: null, isEditInFlight: false }),
      true,
    );
  });

  // THE regression: a burst of same-second refreshes arriving while the first
  // (pacer-delayed) edit is still draining must enqueue AT MOST ONE edit — not
  // the hundreds of identical closures that head-of-line-blocked the agent's
  // answer in the same per-thread FIFO. Dedup MUST be against the last DECIDED
  // text (recorded synchronously), not the last delivered one.
  it('burst of identical refreshes with one edit in flight → exactly one enqueue', () => {
    let decided = 0;
    let lastEnqueuedText: string | null = null;
    let isEditInFlight = false;
    for (let i = 0; i < 200; i++) {
      if (checkShouldEnqueueSubagentStatus({ nextText: text, lastEnqueuedText, isEditInFlight })) {
        decided += 1;
        lastEnqueuedText = text; // synchronous decision record
        isEditInFlight = true;   // the edit stays in flight for the whole burst
      }
    }
    assert.equal(decided, 1, 'exactly one edit enqueued for the whole burst');
  });

  // After the in-flight edit resolves, a genuinely NEW elapsed still lands
  // (coalescing must not wedge the counter permanently).
  it('one tick per resolve cycle: enqueue → in-flight blocks → resolve → next distinct text enqueues', () => {
    let lastEnqueuedText: string | null = null;
    let isEditInFlight = false;
    const enqueue = (next: string): boolean => {
      const go = checkShouldEnqueueSubagentStatus({ nextText: next, lastEnqueuedText, isEditInFlight });
      if (go) { lastEnqueuedText = next; isEditInFlight = true; }
      return go;
    };
    assert.equal(enqueue('🤖 sub-agent: X · 0:10'), true);   // first lands
    assert.equal(enqueue('🤖 sub-agent: X · 0:11'), false);  // blocked in flight
    isEditInFlight = false;                                   // prior edit resolved
    assert.equal(enqueue('🤖 sub-agent: X · 0:12'), true);   // next distinct tick lands
  });
});

describe('checkShouldExpireSubagentStatus — S2 close-instead-of-rearm gate', () => {
  const maxAgeMs = 30 * 60 * 1000;

  it('owning session inactive → true (close even when young)', () => {
    assert.equal(
      checkShouldExpireSubagentStatus({ startedAtMs: 1000, nowMs: 2000, maxAgeMs, isOwningSessionActive: false }),
      true,
    );
  });

  it('active + within the age cap → false (keep ticking)', () => {
    assert.equal(
      checkShouldExpireSubagentStatus({ startedAtMs: 0, nowMs: maxAgeMs - 1, maxAgeMs, isOwningSessionActive: true }),
      false,
    );
  });

  it('active + exactly at the age cap → false (strict `>` boundary)', () => {
    assert.equal(
      checkShouldExpireSubagentStatus({ startedAtMs: 0, nowMs: maxAgeMs, maxAgeMs, isOwningSessionActive: true }),
      false,
    );
  });

  it('active + past the age cap → true (bounds a silent server-side death)', () => {
    assert.equal(
      checkShouldExpireSubagentStatus({ startedAtMs: 0, nowMs: maxAgeMs + 1, maxAgeMs, isOwningSessionActive: true }),
      true,
    );
  });

  it('null startedAt + active → false (treated as just-started, never force-closes a healthy frame)', () => {
    assert.equal(
      checkShouldExpireSubagentStatus({ startedAtMs: null, nowMs: 5_000_000, maxAgeMs, isOwningSessionActive: true }),
      false,
    );
  });

  it('null startedAt + inactive → true (the inactive check wins before the age branch)', () => {
    assert.equal(
      checkShouldExpireSubagentStatus({ startedAtMs: null, nowMs: 5_000_000, maxAgeMs, isOwningSessionActive: false }),
      true,
    );
  });
});
