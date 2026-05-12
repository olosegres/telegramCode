import { test } from 'node:test';

/**
 * @description Placeholder skip-tests for plan §11 Этап 7 items **R9** and
 * **R10**. Both require live external binaries (`tmux`, `claude`) and a
 * controlled bot/process lifecycle, neither of which is realistic to set
 * up inside a CommonJS `node:test` unit run. They are explicit
 * `t.skip()` cases instead of "todo" comments so:
 *
 *   1. The plan checklist (R-list) is visibly accounted for in the
 *      reporter output — no quiet gaps.
 *   2. Each test body documents the exact manual reproduction recipe so
 *      a future maintainer with a tmux + claude box can lift the skip
 *      and turn this into a real harness.
 *
 * Plan refs: §11 Этап 7 R9 (re-attach), R10 (resume on non-existent UUID).
 */

test('R9 — re-attach to surviving tmux session after bot restart', { skip: 'integration test; requires tmux + claude. See body for manual steps.' }, () => {
  /*
   * Manual reproduction (Linux/Mac with tmux + claude installed):
   *
   *   1. Start the bot with a clean `${DATA_DIR}`. Bind a thread (call its
   *      key `<C>:<T>`) via `/bind <subdir>` and start `/claude`. Verify
   *      `tmux ls` lists `claude-<C>-<T>`.
   *
   *   2. Send one prompt so the session has a non-trivial transcript.
   *      Confirm the bot answered.
   *
   *   3. Kill the bot HARD (`kill -9 $(pidof node)` or `docker compose
   *      kill telegram-code`). DO NOT use Ctrl-C — the graceful shutdown
   *      path stops sessions, which would defeat the test.
   *
   *   4. `tmux ls` should still show `claude-<C>-<T>` and the original
   *      claude process should still be running inside it (verify with
   *      `tmux attach -t claude-<C>-<T>` — Ctrl-b d to detach).
   *
   *   5. Start the bot again. Expected:
   *        - log line `[reattach] tmux: adopted 1, killed 0 orphans`
   *        - inside the thread, the bot posts `t('agent.reattached')`
   *          (currently: "🔄 Bot restarted, session is alive, continuing")
   *        - `adapter.checkIsActive(<C>:<T>)` reports true again
   *        - the pinned banner edits in place to `🟢 running`
   *
   *   6. Send another prompt — the existing claude transcript should
   *      pick up uninterrupted (claude's in-process state never died).
   *
   * Automation requirements before lifting the skip:
   *   - CI image with tmux + claude bundled
   *   - Fake Telegram surface (Telegraf launches mock server) — see
   *     telegraf/typings/test or a hand-rolled mock that supplies
   *     getMe / sendMessage / pinChatMessage.
   *   - Spawn the bot as a child process so we can SIGKILL it.
   *
   * Plan §13.19 / E1 / D36.
   */
});

test('R10 — claude --resume on a non-existent UUID must start a fresh session', { skip: 'integration test; requires claude CLI. See body for manual steps.' }, () => {
  /*
   * Manual reproduction (any host with claude installed):
   *
   *   1. Pick a random UUID that is NOT present in
   *      `~/.claude/projects/<encoded-cwd>/*.jsonl`. e.g.
   *
   *        UUID=00000000-0000-4000-8000-000000000000
   *
   *   2. Run:
   *
   *        cd /tmp && claude --dangerously-skip-permissions \
   *          --resume $UUID
   *
   *   3. Expected behaviour:
   *        - claude prints something like "Session not found" or
   *          "Starting a new session with id <UUID>".
   *        - claude IS interactive but DOES NOT open the picker (which
   *          would be unrenderable in our pty wrapper).
   *        - hitting one key returns control / claude shows its prompt.
   *
   *   4. With the bot in the loop:
   *        - Persist `state.agents[key].claudeSessionId = <bogus-uuid>`
   *          (hand-edit `state.json`).
   *        - Restart the bot. The reattach scan will NOT find a tmux
   *          session, so this is purely the `resumeSession` path.
   *        - From the thread, tap a Resume button or send a message —
   *          claudeCliAdapter.resumeSession should spawn with
   *          `--resume <uuid>` and the bot should NOT hang on a picker.
   *
   *   5. The bot should fall through to a NEW claude session (new UUID)
   *      and inform the user via the existing "history not found, fresh
   *      session started" reply (see plan §10.2 / T8 / D48).
   *
   * Automation requirements before lifting the skip:
   *   - CI image with claude installed (~70 MB binary).
   *   - Mock for `~/.claude/projects/` directory so the assert can
   *     verify both code paths (missing dir vs missing UUID file).
   *   - Fake Telegraf surface as for R9.
   *
   * Plan §10.2 / T8 / D48.
   */
});
