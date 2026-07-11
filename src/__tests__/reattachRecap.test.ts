/**
 * @description Unit coverage for `formatReattachRecap` — the pure renderer of
 * the silent-reattach recap (recover output the agent produced while the bot was
 * down, instead of silently dropping it). The bot owns the anti-spam gate; the
 * formatter just shapes a recap it was asked to render.
 *
 * Locale-agnostic (the i18n module reads `BOT_LANG` once at import time): both
 * catalogs share the recap markers — ⚠️ on the count header, 🔄 on the no-count
 * fallback header, ⏳ on the still-working line, and 👤 / 🤖 on the turn body —
 * so the assertions check those rather than locale-specific words.
 *
 * Test case: N/A — TelegramCode has no Jira tracker. TODO: add a test-case key
 * if one is ever created.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkShouldPostReattachRecap, formatReattachRecap } from '../resumeContext';
import type { RecentTurn } from '../types';

const turns: RecentTurn[] = [
  { role: 'user', text: 'fix the login bug' },
  { role: 'assistant', text: 'done — patched the token check' },
  { role: 'user', text: 'thanks' },
];

describe('formatReattachRecap', () => {
  it('returns null when there are no turns (nothing to recover)', () => {
    assert.equal(
      formatReattachRecap({ missedCount: 0, turns: [], isActive: false, isWatermarkKnown: false }),
      null,
    );
    // Even a positive count with no turns yields null — there is no body to show.
    assert.equal(
      formatReattachRecap({ missedCount: 7, turns: [], isActive: false, isWatermarkKnown: true }),
      null,
    );
  });

  it('uses the COUNT header (⚠️ + N) when the watermark is known and N>0, with the turn body', () => {
    const out = formatReattachRecap({ missedCount: 5, turns, isActive: false, isWatermarkKnown: true });
    assert.ok(out);
    const header = out.split('\n')[0];
    assert.ok(header.includes('⚠️'), `count header must carry the warning marker: ${header}`);
    assert.ok(header.includes('5'), `count header must carry N: ${header}`);
    assert.ok(!header.includes('🔄'), 'count header must not be the fallback header');
    // The turn body is rendered (shared with the resume context renderer).
    assert.ok(out.includes('👤 fix the login bug'));
    assert.ok(out.includes('🤖 done — patched the token check'));
    // No still-working line when inactive.
    assert.ok(!out.includes('⏳'), 'no status line when isActive=false');
  });

  it('uses the FALLBACK header (🔄, no number) when the watermark is unknown', () => {
    const out = formatReattachRecap({ missedCount: 0, turns, isActive: false, isWatermarkKnown: false });
    assert.ok(out);
    const header = out.split('\n')[0];
    assert.ok(header.includes('🔄'), `fallback header must carry the restart marker: ${header}`);
    assert.ok(!header.includes('⚠️'), 'fallback header must not be the count header');
    // The body still shows the last turns.
    assert.ok(out.includes('🤖 done — patched the token check'));
  });

  it('uses the FALLBACK header when watermark is known but N==0 (no misleading "missed 0")', () => {
    // The bot gates this combo out, but the formatter must still never claim a
    // count when there was none.
    const out = formatReattachRecap({ missedCount: 0, turns, isActive: false, isWatermarkKnown: true });
    assert.ok(out);
    const header = out.split('\n')[0];
    assert.ok(header.includes('🔄'), `expected fallback header: ${header}`);
    assert.ok(!header.includes('⚠️'), 'must not render the count header for N==0');
  });

  it('appends the still-working line (⏳) only when isActive', () => {
    const active = formatReattachRecap({ missedCount: 2, turns, isActive: true, isWatermarkKnown: true });
    assert.ok(active);
    assert.ok(active.includes('⏳'), 'active recap must carry the still-working line');
    // The status line is LAST, below the turn body.
    assert.ok(active.lastIndexOf('⏳') > active.indexOf('🤖 done'), 'status line must be below the body');

    const idle = formatReattachRecap({ missedCount: 2, turns, isActive: false, isWatermarkKnown: true });
    assert.ok(idle);
    assert.ok(!idle.includes('⏳'), 'idle recap must not carry the still-working line');
  });
});

describe('checkShouldPostReattachRecap (anti-spam gate)', () => {
  it('posts known missed output (N>0) in BOTH boot modes', () => {
    for (const isColdStart of [true, false]) {
      assert.equal(
        checkShouldPostReattachRecap({ missedCount: 3, isWatermarkKnown: true, hasTurns: true, isColdStart }),
        true,
        `missedCount>0 must post (isColdStart=${isColdStart})`,
      );
    }
  });

  it('posts the watermark-unknown fallback ONLY on a cold start', () => {
    assert.equal(
      checkShouldPostReattachRecap({ missedCount: 0, isWatermarkKnown: false, hasTurns: true, isColdStart: true }),
      true,
      'cold start + unknown watermark + turns → fallback posts',
    );
    // The live regression: a hot reload of a watermark-less session must STAY
    // SILENT, otherwise every hot rebuild re-spams the last turns (the 14×
    // fallback flood that this gate fixes).
    assert.equal(
      checkShouldPostReattachRecap({ missedCount: 0, isWatermarkKnown: false, hasTurns: true, isColdStart: false }),
      false,
      'hot reload + unknown watermark → silent',
    );
  });

  it('stays silent on a clean reattach (known watermark, nothing missed)', () => {
    for (const isColdStart of [true, false]) {
      assert.equal(
        checkShouldPostReattachRecap({ missedCount: 0, isWatermarkKnown: true, hasTurns: true, isColdStart }),
        false,
        `known watermark + N==0 must be silent (isColdStart=${isColdStart})`,
      );
    }
  });

  it('stays silent when there are no turns to show, even on a cold start', () => {
    assert.equal(
      checkShouldPostReattachRecap({ missedCount: 0, isWatermarkKnown: false, hasTurns: false, isColdStart: true }),
      false,
    );
  });
});
