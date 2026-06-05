/**
 * @description S7 — Claude re-applies the thread's stored `/effort` on every
 * FRESH TUI spawn (startSession / resumeSession), at the moment the TUI input
 * box is ready and BEFORE buffered user prompts.
 *
 * Why this test: claude persists effort GLOBALLY in its own settings.json, so a
 * fresh TUI (start / `/new` / resume) inherits the LAST globally-set level —
 * possibly chosen in another topic. The bot keeps the real per-thread choice in
 * `.claude-effort-prefs.json`; on spawn it must re-type `/effort <level>` once,
 * ahead of any replayed prompt. No stored pref → nothing typed.
 *
 * BUG fixed 2026-06-05: the first cut typed `/effort` immediately at the end of
 * `startSession` — but a fresh tmux session returns while the claude TUI is
 * still painting its boot banner, so the keystrokes interleaved with the paint
 * and the command sat UNSUBMITTED. The mechanism is now a two-step seam:
 *   1. `applyStoredEffortOnSpawn(key)` ARMS `session.pendingEffortReapply` from
 *      the on-disk pref (no keystroke).
 *   2. the poll loop calls `consumePendingEffortReapply(session)` the FIRST time
 *      the pane is ready (`checkIsClaudePromptReady`), typing once and clearing
 *      the flag (one-shot).
 *
 * Driving the real `startSession` would spawn a real tmux + claude process, so
 * we exercise both halves of the seam directly with a session injected into the
 * private map and `sendInput` spied — the same keystroke path a manual
 * `/effort` uses. The adopt-exclusion is verified structurally (adopt never
 * calls `applyStoredEffortOnSpawn`, so its `pendingEffortReapply` stays null);
 * the pure readiness predicate is locked by `claudePromptReady.test.ts` and the
 * pure keystroke decision by `effortStartupKeystroke.test.ts`.
 *
 * Harness mirrors `openCodeSetModelNoSession.test.ts`: the testSetup module is
 * imported FIRST so the adapter reads its prefs file from a temp `DATA_DIR`;
 * private members reached via runtime bracket access (tests are excluded from
 * tsconfig and run via tsx type-stripping, so this does not affect typecheck).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  seededThreadKeyString,
  seededEffortLevel,
  noPrefThreadKeyString,
} from './claudeEffortReapply.testSetup';
import { ClaudeCliAdapter, checkIsClaudePromptReady } from '../adapters/claudeCliAdapter';
import { keyToString, keyFromString, type ThreadKey } from '../types';

const seededKey: ThreadKey = keyFromString(seededThreadKeyString);
const noPrefKey: ThreadKey = keyFromString(noPrefThreadKeyString);

/** A captured pane that the readiness predicate accepts (input box up, no gate). */
const readyPane = 'Some prior output\n\n❯ ';

/**
 * @description Build an adapter with a live session injected for `key` (so the
 * `sendInput` active-session guard passes) and `sendInput` replaced by a spy
 * that records every typed string instead of touching tmux. Returns the live
 * session too, so a test can read/poke `pendingEffortReapply`.
 */
function createAdapterWithSession(key: ThreadKey): {
  adapter: ClaudeCliAdapter;
  typed: string[];
  session: { pendingEffortReapply: string | null };
} {
  const adapter = new ClaudeCliAdapter();
  const session = adapter['createSession']({
    key,
    workDir: '/tmp/work',
    sessionName: `claude-${keyToString(key)}`,
    claudeSessionId: '00000000-0000-4000-8000-000000000000',
    isActive: true,
    handledAutoEnter: false,
    handledAutoAccept: false,
  });
  adapter['sessions'].set(keyToString(key), session);

  const typed: string[] = [];
  adapter['sendInput'] = (_key: ThreadKey, input: string) => {
    typed.push(input);
  };
  return { adapter, typed, session };
}

describe('Claude effort re-apply on fresh spawn (S7)', () => {
  let adapter: ClaudeCliAdapter;
  let typed: string[];
  let session: { pendingEffortReapply: string | null };

  describe('arm step — applyStoredEffortOnSpawn', () => {
    it('arms the pending flag from the stored pref WITHOUT typing', () => {
      ({ adapter, typed, session } = createAdapterWithSession(seededKey));
      adapter['applyStoredEffortOnSpawn'](seededKey);
      assert.equal(
        session.pendingEffortReapply,
        seededEffortLevel,
        'a fresh spawn must STASH the per-thread level, not type it into a booting TUI',
      );
      assert.deepEqual(typed, [], 'arming must not touch the pane — that is the booting-paint bug');
    });

    it('arms nothing when there is no stored pref', () => {
      ({ adapter, typed, session } = createAdapterWithSession(noPrefKey));
      assert.equal(adapter.getEffort(noPrefKey), null, 'precondition: no pref for this thread');
      adapter['applyStoredEffortOnSpawn'](noPrefKey);
      assert.equal(session.pendingEffortReapply, null, 'no pref ⇒ nothing armed');
      assert.deepEqual(typed, [], 'no pref ⇒ no keystroke ever');
    });
  });

  describe('consume step — consumePendingEffortReapply', () => {
    beforeEach(() => {
      ({ adapter, typed, session } = createAdapterWithSession(seededKey));
      adapter['applyStoredEffortOnSpawn'](seededKey);
    });

    it('types the armed level once and clears the flag (one-shot)', () => {
      adapter['consumePendingEffortReapply'](session);
      assert.deepEqual(
        typed,
        [`/effort ${seededEffortLevel}`],
        'readiness must re-type the per-thread effort claude lost to its global state',
      );
      assert.equal(session.pendingEffortReapply, null, 'consumed flag must be cleared');
    });

    it('does NOT fire a second time (flag already consumed)', () => {
      adapter['consumePendingEffortReapply'](session);
      adapter['consumePendingEffortReapply'](session);
      assert.equal(typed.length, 1, 'a one-shot must type exactly once across repeated poll ticks');
    });

    it('does nothing when nothing is armed', () => {
      session.pendingEffortReapply = null;
      adapter['consumePendingEffortReapply'](session);
      assert.deepEqual(typed, [], 'no armed level ⇒ no keystroke');
    });
  });

  describe('readiness-gated poll loop (arm → poll → consume)', () => {
    /** Mirrors the poll-loop guard: pending + ready ⇒ consume. */
    function runPollTick(paneText: string): void {
      if (session.pendingEffortReapply && checkIsClaudePromptReady(paneText)) {
        adapter['consumePendingEffortReapply'](session);
      }
    }

    it('arms on spawn but stays silent until a poll sees a ready pane', () => {
      ({ adapter, typed, session } = createAdapterWithSession(seededKey));
      adapter['applyStoredEffortOnSpawn'](seededKey);

      // Booting pane (no input box) → predicate false → still silent.
      runPollTick('Claude Code v2.1.165\nbooting…');
      assert.deepEqual(typed, [], 'no keystroke while the TUI is still painting its banner');
      assert.equal(session.pendingEffortReapply, seededEffortLevel, 'still armed for a later ready poll');

      // Ready pane → predicate true → consume.
      runPollTick(readyPane);
      assert.deepEqual(typed, [`/effort ${seededEffortLevel}`], 'typed once the input box is ready');
      assert.equal(session.pendingEffortReapply, null, 'consumed');

      // A further ready poll must NOT re-type (one-shot survives the loop).
      runPollTick(readyPane);
      assert.equal(typed.length, 1, 'one-shot: the loop never re-types after consumption');
    });
  });
});
