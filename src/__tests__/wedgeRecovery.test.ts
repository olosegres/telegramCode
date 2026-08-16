/**
 * @description Unit tests for `decideWedgeRecovery` — the loop guard for
 * recovering a WEDGED OpenCode session (accepted a prompt, ran no turn). The
 * session is unrecoverable in place, so recovery restarts fresh and replays the
 * prompt; this decides restart-vs-give-up so a persistently wedging session
 * cannot loop forever.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideWedgeRecovery } from '../utils/wedgeRecovery';

describe('decideWedgeRecovery', () => {
  it('restarts once when a prompt is cached and no attempt was made yet', () => {
    assert.equal(
      decideWedgeRecovery({ hasReplayPrompt: true, alreadyRecovering: false }),
      'restart',
    );
  });

  it('gives up when a fresh-session attempt already happened (loop guard)', () => {
    assert.equal(
      decideWedgeRecovery({ hasReplayPrompt: true, alreadyRecovering: true }),
      'giveUp',
    );
  });

  it('gives up when there is no cached prompt to replay', () => {
    assert.equal(
      decideWedgeRecovery({ hasReplayPrompt: false, alreadyRecovering: false }),
      'giveUp',
    );
  });

  it('gives up when both no prompt and already recovering', () => {
    assert.equal(
      decideWedgeRecovery({ hasReplayPrompt: false, alreadyRecovering: true }),
      'giveUp',
    );
  });
});
