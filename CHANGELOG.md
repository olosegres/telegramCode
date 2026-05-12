# Changelog

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
