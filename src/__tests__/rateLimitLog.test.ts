/**
 * @description Pure rate-limit instrumentation log formatters
 * (plan 2026-06-24-rate-limit-429-metrics, S2/S3).
 *
 * Load-bearing intent (per `.claude/rules/tests.md`): assert the EXACT emitted
 * string — every field a future budget-tuner reads (chat, retry_after, measured
 * sends/min, peak burst, queue depth + priority mix, after-retry flag) must be
 * present and correctly rendered — AND that both lines stay greppable via their
 * `[RateLimit] 429` / `[RateLimit] rate` prefixes. A formatter that silently
 * dropped a field would still "not crash"; the explicit-string assertions catch
 * that.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatRateLimit429Line, formatRateSummaryLine } from '../utils/rateLimitLog';

describe('formatRateLimit429Line', () => {
  it('renders every field of a first (pre-retry) 429', () => {
    const line = formatRateLimit429Line({
      chatId: -100123,
      retryAfterSec: 5,
      sentPerMin: 38,
      peak10s: 12,
      waitersByPriority: { interactive: 1, output: 5, status: 1 },
      isAfterRetry: false,
    });
    assert.equal(
      line,
      '[RateLimit] 429 chat=-100123 retryAfter=5s sent/min=38 peak10s=12 queue=7 (interactive=1,output=5,status=1) after_retry=no',
    );
  });

  it('marks the second consecutive 429 with after_retry=yes', () => {
    const line = formatRateLimit429Line({
      chatId: -7,
      retryAfterSec: 30,
      sentPerMin: 40,
      peak10s: 15,
      waitersByPriority: { interactive: 0, output: 0, status: 0 },
      isAfterRetry: true,
    });
    assert.equal(
      line,
      '[RateLimit] 429 chat=-7 retryAfter=30s sent/min=40 peak10s=15 queue=0 (interactive=0,output=0,status=0) after_retry=yes',
    );
  });

  it('queue depth is the sum of all priority classes', () => {
    const line = formatRateLimit429Line({
      chatId: 1,
      retryAfterSec: 1,
      sentPerMin: 0,
      peak10s: 0,
      waitersByPriority: { interactive: 2, output: 3, status: 4 },
      isAfterRetry: false,
    });
    assert.match(line, /queue=9 \(interactive=2,output=3,status=4\)/);
  });

  it('stays greppable by the [RateLimit] 429 prefix', () => {
    const line = formatRateLimit429Line({
      chatId: -1,
      retryAfterSec: 2,
      sentPerMin: 3,
      peak10s: 1,
      waitersByPriority: { interactive: 0, output: 1, status: 0 },
      isAfterRetry: false,
    });
    assert.ok(line.startsWith('[RateLimit] 429 '), 'must start with the greppable prefix');
  });
});

describe('formatRateSummaryLine', () => {
  it('renders the periodic per-chat rate summary', () => {
    assert.equal(
      formatRateSummaryLine(-100123, 22, 8),
      '[RateLimit] rate chat=-100123 sent/min=22 peak10s=8',
    );
  });

  it('stays greppable by the [RateLimit] rate prefix', () => {
    const line = formatRateSummaryLine(5, 0, 0);
    assert.ok(line.startsWith('[RateLimit] rate '), 'must start with the greppable prefix');
  });
});
