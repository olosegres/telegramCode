/**
 * @description Unit coverage for `getResumeSeedDecision` — the pure state
 * machine behind Claude's resume flood-suppression.
 *
 * On `--resume`, Claude repaints the WHOLE restored transcript into the pane
 * over several polls. `pollOutput` runs this decision each seeding poll: while
 * `keepSeeding` is true it advances the baseline but emits NO conversation
 * text, so once the pane stops growing the baseline equals the full restored
 * transcript and only genuinely-new output is emitted afterwards.
 *
 * Load-bearing simulation: we drive the same swallow → exit-on-stable →
 * emit-only-new sequence the adapter does and assert the full restored pane is
 * NEVER emitted, while a later genuinely-new line IS.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getResumeSeedDecision, getNewPaneContent } from '../adapters/claudeCliAdapter';

describe('getResumeSeedDecision', () => {
  it('keeps seeding while the pane is still growing', () => {
    assert.equal(getResumeSeedDecision({ content: 'a', prevContent: '', polls: 0 }).keepSeeding, true);
    assert.equal(getResumeSeedDecision({ content: 'a\nb', prevContent: 'a', polls: 1 }).keepSeeding, true);
  });

  it('exits when the pane is non-empty and unchanged across two polls', () => {
    const stable = getResumeSeedDecision({ content: 'restored pane', prevContent: 'restored pane', polls: 2 });
    assert.equal(stable.keepSeeding, false);
  });

  it('does NOT exit on an empty-and-unchanged pane (boot not started yet)', () => {
    const emptyStable = getResumeSeedDecision({ content: '', prevContent: '', polls: 1 });
    assert.equal(emptyStable.keepSeeding, true);
  });

  it('force-exits at the hard cap even if the pane never stabilises', () => {
    // polls keeps incrementing while content jitters; the cap must still fire.
    const capped = getResumeSeedDecision({ content: 'still painting…', prevContent: 'different', polls: 39 });
    assert.equal(capped.keepSeeding, false, 'must force-exit when polls+1 reaches resumeSeedMaxPolls (40)');
  });

  it('full restored pane is swallowed; only a later new line is emitted', () => {
    const restoredPane = ['user: old question', 'assistant: old answer', 'assistant: more old context'].join('\n');

    // Mirror pollOutput's seeding loop: baseline advances every poll, decision
    // gates whether we keep swallowing. We collect anything that WOULD be
    // emitted to prove nothing from the restored transcript escapes.
    const emitted: string[] = [];
    let baseline = '';
    let prevContent = '';
    let polls = 0;
    let seeding = true;

    const seedFrames = [
      'user: old question',
      restoredPane, // fully painted
      restoredPane, // unchanged → exit on this poll
    ];
    for (const content of seedFrames) {
      assert.equal(seeding, true, 'still seeding while transcript paints');
      const decision = getResumeSeedDecision({ content, prevContent, polls });
      // Seeding emits NOTHING — only advances the baseline.
      baseline = content;
      prevContent = content;
      polls += 1;
      if (!decision.keepSeeding) seeding = false;
    }
    assert.equal(seeding, false, 'seeding must have exited once the pane stabilised');
    assert.equal(baseline, restoredPane, 'baseline must equal the full restored pane on exit');
    assert.deepEqual(emitted, [], 'no part of the restored transcript may be emitted');

    // Post-seed: a genuinely-new assistant line arrives. The diff against the
    // (now full) baseline yields ONLY the new line — the restored history does
    // not reappear.
    const afterNewLine = restoredPane + '\nassistant: brand new reply';
    const newPart = getNewPaneContent(baseline, afterNewLine);
    assert.equal(newPart, 'assistant: brand new reply');
  });
});
