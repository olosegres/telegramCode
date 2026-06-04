/**
 * @description Unit coverage for `formatResumeContext` — the pure renderer of
 * the resume context block (the short "last N turns" preview posted on resume
 * instead of flooding the topic with the whole restored transcript).
 *
 * Locale-agnostic: the i18n module reads `BOT_LANG` once at import time (static
 * imports hoist, so an in-file assignment lands too late to influence it).
 * Both catalogs share the same role emoji (👤 / 🤖) and put the turn count in
 * the header, so the assertions check those rather than a locale-specific word.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatResumeContext,
  resumeContextTurnCharCap,
} from '../resumeContext';
import type { RecentTurn } from '../types';

describe('formatResumeContext', () => {
  it('returns null for an empty turn list (no context block)', () => {
    assert.equal(formatResumeContext([]), null);
  });

  it('renders turns oldest→newest with role labels and the count in the header', () => {
    const turns: RecentTurn[] = [
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'follow-up' },
    ];
    const out = formatResumeContext(turns);
    assert.ok(out);
    // Header carries the turn count + the resume marker (locale-agnostic).
    const headerLine = out.split('\n')[0];
    assert.ok(headerLine.includes('↩️'), `header missing resume marker: ${headerLine}`);
    assert.ok(headerLine.includes('3'), `header missing turn count: ${headerLine}`);
    // Role labels (shared across catalogs: 👤 user, 🤖 assistant).
    assert.ok(out.includes('👤 first question'));
    assert.ok(out.includes('🤖 first answer'));
    assert.ok(out.includes('👤 follow-up'));
    // Order is preserved oldest→newest: first question before follow-up.
    assert.ok(
      out.indexOf('first question') < out.indexOf('first answer'),
      'oldest turn must come first',
    );
    assert.ok(
      out.indexOf('first answer') < out.indexOf('follow-up'),
      'turns must stay chronological',
    );
  });

  it('truncates an over-cap turn with an ellipsis, leaves short turns intact', () => {
    const longText = 'x'.repeat(resumeContextTurnCharCap + 50);
    const turns: RecentTurn[] = [
      { role: 'assistant', text: longText },
      { role: 'user', text: 'short' },
    ];
    const out = formatResumeContext(turns);
    assert.ok(out);
    // The long turn is cut to the cap and ends with the ellipsis.
    assert.ok(out.includes('…'), 'over-cap turn must end with ellipsis');
    const xRun = out.match(/x+/);
    assert.ok(xRun);
    assert.ok(
      xRun[0].length <= resumeContextTurnCharCap,
      `truncated body (${xRun[0].length}) must not exceed cap (${resumeContextTurnCharCap})`,
    );
    // The short turn is untouched (no ellipsis attached to it).
    assert.ok(out.includes('👤 short'));
    // A turn at exactly the cap is NOT truncated.
    const exact = formatResumeContext([{ role: 'user', text: 'y'.repeat(resumeContextTurnCharCap) }]);
    assert.ok(exact);
    assert.ok(!exact.includes('…'), 'a turn exactly at the cap must not be truncated');
  });
});
