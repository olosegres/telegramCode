/**
 * @description Unit coverage for `formatResumeContext` — the pure renderer of
 * the resume context block (the last N turns, rendered in full, posted on
 * resume instead of flooding the topic with the whole restored transcript;
 * the turn count is the only flood bound — the bot splits over-cap blocks).
 *
 * Locale-agnostic: every catalog shares the same role emoji (👤 / 🤖) and puts
 * the turn count in the header, so the assertions check those rather than a
 * locale-specific word.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatResumeContext } from '../resumeContext';
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

  it('renders a long turn in FULL — no per-turn truncation (the bug: resume showed cut messages)', () => {
    // Longer than the retired 500-char per-turn cap and longer than the
    // Telegram message cap, to prove the renderer itself never trims; the
    // bot's send path (`splitMessage`) handles over-cap blocks downstream.
    const longBody = 'x'.repeat(800);
    const longText = `Here is the full final answer: ${longBody} END`;
    const turns: RecentTurn[] = [
      { role: 'assistant', text: longText },
      { role: 'user', text: 'short' },
    ];
    const out = formatResumeContext(turns);
    assert.ok(out);
    // Load-bearing: the COMPLETE long turn text survives verbatim, including
    // the tail after the old cut point — assert the full string, not a length.
    assert.ok(
      out.includes(`🤖 ${longText}`),
      'the full long turn must be rendered verbatim, with no truncation',
    );
    // The retired ellipsis marker must never appear.
    assert.ok(!out.includes('…'), 'no per-turn ellipsis/truncation must remain');
    // The short turn is untouched.
    assert.ok(out.includes('👤 short'));
  });

  it('strips the forwarded thread-context preamble from user turns (service glue is not user speech)', () => {
    const storedPrompt =
      '[Telegram thread context]\ngroup: "ExampleGroup"\nthread: -100123:9085 | folder: someProject\n\nwhat folder are you in?';
    const turns: RecentTurn[] = [
      { role: 'user', text: storedPrompt },
      // An assistant turn that happens to QUOTE the marker must stay intact.
      { role: 'assistant', text: '[Telegram thread context] is the preamble header' },
    ];
    const out = formatResumeContext(turns);
    assert.ok(out);
    assert.ok(out.includes('👤 what folder are you in?'), 'user turn must show only the actual prompt');
    assert.ok(!out.includes('👤 [Telegram thread context]'), 'the glued preamble must be stripped from user turns');
    assert.ok(
      out.includes('🤖 [Telegram thread context] is the preamble header'),
      'assistant text is never stripped',
    );
  });
});
