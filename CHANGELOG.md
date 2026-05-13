# Changelog

## 2.1.0 — 2026-05-13

**Audit fixes release.** Full repo audit (50 findings across security,
concurrency, resource handling, error contracts, infra) closed in 20
focused commits. See `agent/tasks/actual/2026-05-13-audit-fixes.md` for
the full plan; highlights below.

### Security
- **Two RCEs closed** in `claudeCliAdapter`: `sendInput` and
  `startSession`/`resumeSession` built tmux command lines via
  `execSync` with `JSON.stringify`-interpolated user input, letting any
  allowed user run arbitrary host commands via `$(…)` / backticks in a
  thread message. Reroute all tmux calls onto the argv-based helper;
  single-quote every element of the final `tmux new-session` shell
  command (S1).
- **Forum-topic auth bypass** closed: `forum_topic_created` /
  `_closed` / `_reopened` are now gated on `ALLOWED_USERS`, not just
  the chat allowlist. A non-allowed admin previously could rename a
  topic to fuzzy-match a sensitive WORK_ROOT subdir and have the next
  allowed-user message launch an agent there (S2).
- **OpenCode SSE cross-thread events**: `permission.asked` and
  `question.asked` events without `sessionID` used to fan out to every
  active thread, auto-approving permissions and stacking duplicate
  questions. Now any event without a `sessionID` is dropped (S5).
- **SSRF guard** on `OPENCODE_URL` (loopback by default, opt in with
  `OPENCODE_ALLOW_REMOTE=1`); 30 s timeout on every fetch; abortable
  SSE reader; 10-minute wall-clock cap on SSE reconnect (S7).
- **Docker hardening**: drop `user: root`, `cap_drop: [ALL]`,
  `security_opt: no-new-privileges`, bounded `mem_limit`/`pids_limit`,
  healthcheck. `.docker-entrypoint.sh` uses `runuser -- "$@"` instead
  of `su -c "$*"` so argv stays argv. claude-code install moved to
  build time with a pinned version (S16).

### Bugs
- `resume_<idx>` callback: full session id is recovered from a
  per-thread map instead of being truncated into callback_data, which
  used to make OpenCode resume target a non-existent id (S4).
- Pinned-banner pipeline serialised per key so concurrent adapter
  events can't stack duplicate pinned messages (S6).
- OpenCode lifecycle: per-key serialisation of start/stop, cleanup of
  `statusDebounceTimer` and `reconnectTimer` on stop, explicit
  teardown of every session after `restartServer` (S8).
- Claude adapter: auto-Enter / auto-Accept timers tracked + cleared on
  stop; `pollOutput` uses self-rescheduling `setTimeout` with
  re-entrancy guard; `adoptExistingTmuxSession` rejects zombie panes
  with no live child; capture-pane scrollback raised to 2000 lines (S9).
- `/clear` snapshots message ids under `state.withLock` so agent
  messages pushed mid-deletion can't slip out of tracking (S11).
- `/output` flips `markNeedsNewMessage` and surfaces "+N more chunks
  omitted" instead of silently dropping (S11).
- `/new` routes through `applyBinding` so collision warnings reach the
  new thread (S11).
- `switchThreadAdapter` clears the previous adapter's stored session id
  so post-restart reattach doesn't pick the wrong adapter (S12).
- In-memory per-thread maps GC'd against `state.json` every 60 s so
  orphan entries from UI-deleted topics don't linger (S13).
- Numeric model-selection reply unconditionally returns; previously
  fell through to NL-start + agent-forward when `setModel` was absent
  (S12).
- `downloadFile` capped at 5 redirects with 20 s `setTimeout`;
  `transcribeAudio` got the same timeout and a proper error handler
  installed before `form.pipe(req)`. Voice file URL now built via
  `ctx.telegram.getFileLink` so the bot token isn't materialised in a
  JS string (S14).

### Contracts
- `AgentAdapter` events documented: `startSession` throws on failure,
  `error` is for async failures after a successful start, `closed` is
  unsolicited death, `stopped` is explicit teardown. Claude's two
  start paths now throw + clean up. `setModel` unified to
  `Promise<string | null>`. OpenCode SSE giveup emits `closed` so the
  bot wipes persisted ids (S10).

### Hygiene
- `tsconfig.json`: `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `noImplicitOverride`,
  `exclude: src/__tests__/**`.
- `package.json`: drop `ts-node`, move `typescript` to devDeps,
  `private: true`, `engines.node >=22`.
- `BOT_LANG` lowercased + trimmed with a warn on unknown values.
- 19 hardcoded English `ctx.answerCbQuery` strings migrated to a new
  `cb.*` namespace in i18n.
- `.env.example` no longer leaks the author's home path; the two-
  instance example uses `REPLACE_ME` so a copy-pasted file fails
  validation visibly.
- DATA_DIR resolved via `resolveDataDir()` everywhere; previously the
  two adapters dropped state files in `$HOME` instead of `DATA_DIR`,
  breaking two-instance isolation (S3).

### Tests
- 13 new tests: i18n placeholders + fallback (S19/#50), agent NL
  trigger parser extracted into `src/agentTrigger.ts` with full ru/en
  coverage (S19/#25), state.json forward-compat round-trip with an
  unknown future field. 98 tests passing (R9/R10 still skipped).

### Deferred
- `noUncheckedIndexedAccess` in `tsconfig.json` (106 errors fallout —
  needs a careful per-site task).
- Complete MarkdownV2 escaper (regression risk).
- bot.ts test coverage (3300 LOC — separate task).

## 2.0.0 — 2026-05-12

**Breaking release.** The bot now routes through a Telegram forum
supergroup with one topic per task; the 1.x "one bot = one private chat
= one folder" mode is removed. See [Migration](README.md#migration-from-1x).

### Added
- **Forum-supergroup routing.** `ThreadKey = (chatId, threadId)` is the
  routing key everywhere; threads are bound to subfolders of `WORK_ROOT`
  and run their own `claude` or `opencode` session in parallel.
- **Persistent state** (`src/state.ts`) — `${DATA_DIR}/state.json` with
  atomic writes (write tmp → fsync fd → rename → fsync parent dir),
  per-key async-lock for concurrent `/bind`, corrupted-file archival to
  `state.json.corrupted-<ts>` with a fresh restart, debounced saves with
  immediate flush on critical paths.
- **Restart-safe sessions** — claude tmux sessions named
  `claude-${chatId}-${threadId}` are re-adopted on boot via
  `tmux ls`; opencode SSE streams are reopened from persisted
  `opencodeSessionId`. Orphan tmux sessions are killed.
- **Per-thread Claude session id** — `crypto.randomUUID()` →
  `claude --session-id <uuid>` on a fresh start, `--resume <uuid>` on
  resume. Fixes the 1.x picker hang.
- **MCP hierarchy** — user (`~/.claude/settings.json`) /
  group (`${DATA_DIR}/mcp.json`) /
  project (`${workDir}/.mcp.json`) /
  thread (`${DATA_DIR}/threads/<key>.json`). `${VAR}` placeholders are
  expanded by the bot before claude sees the config; tmp files are
  written `0600` and cleaned up on `stopSession`.
- **Commands.** `/bind`, `/unbind`, `/where` (per topic);
  `/ls`, `/list`, `/new`, `/status` (global), `/doctor`, `/mcp`,
  `/whoami`, `/version`, context-aware `/help`, `/stop-all`.
- **Path traversal protection** — NFC normalisation, control-char
  rejection, `realpathSync` + strict containment, symlink-out rejection,
  `/bind .` rejection.
- **Auto-welcome** when the bot is added to a forum supergroup, and
  rich post-bind welcome with CLAUDE.md / .mcp.json / git stats.
- **Token-bucket rate limiter** — 1 token/sec per chat, burst 5,
  layered with reactive 429-retry. Prevents the multi-thread N-msg/sec
  storm that would otherwise breach Telegram's per-chat budget.
- **i18n** — `BOT_LANG=ru|en` (default ru) via `src/i18n.ts`.
- **Two-instance docker-compose** (`examples/docker-compose.yml`) — pet
  + work, isolated `DATA_DIR`, group, token, `OPENCODE_URL` port.
- **Test suite** — `yarn test` (node:test + tsx). 54 tests cover R1
  (ThreadKey round-trip), R2 (gating matrix), R3 (path-traversal
  corpus), R4 (legacy file migration), R5 (concurrent state writes),
  R6 (corrupted state archival), R7 (rate-limit token bucket + 429
  retry), R8 (send-error classification).

### Changed
- **`WORK_DIR` → `WORK_ROOT`.** `WORK_DIR` is now fatal — bot fails to
  start with a migration hint. `WORK_ROOT` points at the *parent* folder
  containing your projects.
- **`ALLOWED_GROUP_ID` is required.** Without it the bot has no idea
  which forum supergroup to listen to.
- **`DATA_DIR`** — single-instance default `~/.telegramCode`, mandatory
  for two-instance setups.
- **`--dangerously-skip-permissions`** hardcoded for symmetry with
  opencode's auto-approve.
- **`/clear`** scoped to the current thread (uses persisted message ids),
  chunked at 100 per call, surfaces the Telegram 48 h limit.
- **README** rewritten end-to-end around forum supergroup setup,
  troubleshooting, MCP hierarchy, two-instance compose, migration.

### Removed
- One-bot-per-private-chat mode and `WORK_DIR` env var.
- Legacy `~/.telegram-bot-messages.json` (renamed to `.bak` on first
  start; no message-id migration into the new schema).

### Deferred (Phase 9+)
- `/mcp-add`, `/mcp-remove`, `/mcp-restart` UI commands.
- OpenCode per-thread MCP override.
- Routines / opencode-scheduler integration (`/schedule`,
  `/schedule-cloud`) — Phase 8.
- Claude Code hooks integration + `--input-format stream-json`
  rewrite — Phase 9.

### Stage 7 polish (shipped 2026-05-12)
- Per-thread pinned status banner (`📁 subdir · agent · model ·
  state`) — edits in place on every adapter lifecycle event,
  unpinned on `/unbind`.
- Fuzzy auto-bind on `forum_topic_created` — separator drift
  (`my-api` ↔ `my_api` ↔ `my api`) is folded alongside case + NFC.
- `/bind` keyboard pagination at 20 folders/page with
  `[⬅️ Prev] [N/M] [Next ➡️]` nav row; `WORK_ROOT` listing cap
  raised 50 → 200.
- R9 (tmux re-attach) and R10 (claude `--resume` on bogus UUID)
  filed as documented skip-tests pending an integration harness.

### Migration
1. Stop the 1.x bot.
2. Create a forum supergroup, add the bot, follow
   [README Quick Start](README.md#2-create-the-forum-supergroup).
3. Rename `WORK_DIR` → `WORK_ROOT` and point at the parent folder.
4. Add `ALLOWED_GROUP_ID` (find it via `/whoami` in the group).
5. Set `DATA_DIR` if you run multiple instances on one host.
6. `docker compose up -d`.

The legacy `~/.telegram-bot-messages.json` is moved to `.bak` on first
start; message-id history does not migrate.
