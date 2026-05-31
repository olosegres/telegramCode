# telegram-code — project guide

> Shared rules live in `.claude/rules/` (loaded automatically). This file is
> the **project map**: read it first to understand what the code does before
> changing it.

## What this project is

A Telegram **forum-supergroup bot that proxies user commands and messages to
agentic CLIs** — **Claude Code** and **OpenCode**. The bot itself contains
almost no "AI" logic: its job is routing, session lifecycle, and translating
Telegram input into the right call to the underlying agent, then streaming the
agent's output back into the topic.

**Core mental model — the bot is a proxy/relay.** Most commands are *forwarded*
to the agent rather than handled locally:

- **Claude Code** runs as an interactive TUI inside `tmux`, spawned via
  `node-pty`. The bot drives it by **writing keystrokes / slash commands**
  into the pty (e.g. `/model …`, `/clear`, arrow keys, Enter) and scrapes the
  rendered terminal output. There is no API — it is screen-driving.
- **OpenCode** runs as a local HTTP server. The bot talks to it over
  **HTTP + SSE**: it POSTs prompts to `/session/:id/prompt_async` (with a
  `model: {providerID, modelID}` override) and consumes the `/global/event`
  stream.

When adding a feature, first decide: *is this a bot-local concern, or something
that must be proxied to the agent?* If it changes agent behavior (model,
effort, prompt, interrupt), it almost always has **two implementations** — a
keystroke sequence for Claude (tmux/pty) and an HTTP call for OpenCode — and
the two backends often expose the capability very differently (e.g. Claude has
a real `/effort` slash command; OpenCode encodes reasoning effort in model
config/variants, not a per-message API field).

## Key concepts

- **One topic ↔ one project folder ↔ one agent session.** Each forum topic is
  bound to a subfolder under `WORK_ROOT` and runs its own isolated `claude` or
  `opencode` session. Two topics can point at the same folder for parallel work.
- **Per-thread isolation.** Routing, sessions, MCP config, model/effort prefs,
  and history are keyed per topic (`ThreadKey` = `"<chatId>:<threadId>"`).
- **Restart-safe.** State is persisted to `state.json`; on restart the bot
  re-attaches to the `tmux` session (Claude) or re-connects SSE (OpenCode).
  Per-thread prefs (e.g. OpenCode model) live in `DATA_DIR` JSON files.
- **Startup-safe input.** A session has an async boot window (Claude tmux/pty,
  OpenCode server + `POST /session`). Prompts typed during it are buffered
  (`startupPromptBuffer.ts`) and replayed in order when ready — never dropped.
- **Two-instance ready.** A "pet" and a "work" instance can run on one host with
  isolated `DATA_DIR`, group, and OpenCode port.
- **MCP hierarchy.** MCP servers merge across user / group / project / thread
  scopes with `${VAR}` env expansion.

## Module map (`src/`)

| File | Responsibility |
|------|----------------|
| `cli.ts`, `cli/bot.ts`, `cli/cliClaude.ts` | CLI entrypoints / wiring |
| `cli/envLoader.ts` | Load `.env` (config dir + per-project override) |
| `cli/lock.ts` | Single-instance lockfile |
| `bot.ts` | **The bot.** Telegram handlers, all slash commands, output streaming. Large — most logic lives here |
| `threadRouting.ts` | Resolve which project folder a forum topic is bound to |
| `state.ts` | Persistence (`state.json`): bindings, sessions, pairing; `resolveDataDir()` |
| `mcpConfig.ts` | Merge MCP server config across the user/group/project/thread hierarchy |
| `i18n.ts` | `t(key, vars)` translations for all user-facing strings |
| `validation.ts` | Input validation |
| `rateLimiter.ts` | Per-user / per-action rate limiting |
| `progressLine.ts` | Render the live progress / spinner line |
| `pinnedStatus.ts` | Per-thread pinned status banner (shows model, etc.) |
| `agentTrigger.ts` | Detect agent-ready / prompt triggers in output |
| `sendErrorClassifier.ts` | Classify Telegram send failures |
| `openCodeSessionRouting.ts` | Pure helpers: match an SSE event to its owning session via child→parent lineage (`checkIsEventForSession`), record lineage (`updateSessionLineage`) |
| `diagLog.ts` | Bounded rotating diagnostic log (`appendDiagLog`) under `DATA_DIR/agent-diag.log` — SSE/session lifecycle milestones only, never the per-delta firehose |
| `installManager.ts` | Install / locate the agent binaries, start OpenCode server |
| `utils/resolveBinary.ts` | Resolve `claude` / `opencode` binary paths |
| `types.ts` | Shared types incl. the `AgentAdapter` contract and `ThreadKey` |

### Adapters (`src/adapters/`) — the proxy boundary

| File | Responsibility |
|------|----------------|
| `createAdapter.ts` | Factory: pick adapter by tool kind; wire adapter events → bot |
| `claudeCliAdapter.ts` | Claude Code via `tmux` + `node-pty` (keystroke driving, output scraping) |
| `openCodeAdapter.ts` | OpenCode via HTTP + SSE (POST prompts, stream `/global/event`) |

The `AgentAdapter` interface (in `types.ts`) is the seam. Per-backend agent
controls (`setModel`, `getCurrentModel`, `sendInput`, `sendSignal`,
`sendEnter`/`sendArrow`/`sendTab`, lifecycle `startSession`/`stopSession`/
`resumeSession`/`checkIsActive`) are optional methods; the bot checks for them
before calling. New per-backend capabilities are added here first, then surfaced
as a command in `bot.ts`.

## Commands (all registered in `bot.ts`)

- **Session lifecycle:** `/claude`, `/opencode` (`/oc`), `/stop`, `/stop-all`,
  `/quit` (`/q`), `/sessions` (`/resume`), `/cancel`, `/clear`, `/compact`
  - `/sessions` and its synonym `/resume` list resumable sessions for the
    thread's bound folder as numbered text **and** tappable inline buttons,
    then arm a per-thread pick mode: reply with a bare digit to resume that
    session, `0` or `/cancel` to exit, out-of-range stays armed, any other
    text exits and is handled normally. **Two backends differ:** Claude lists
    real `~/.claude/projects/<cwd-slug>/*.jsonl` transcripts filtered by
    `recordedCwd === workDir` (so sessions started by hand on the laptop in
    that folder are resumable too); OpenCode lists server sessions via
    `GET /session` (not folder-filtered).
- **Binding & navigation:** `/bind`, `/unbind`, `/where`, `/ls`, `/list`,
  `/new`, `/pair`
- **Agent control (proxied):** `/model`, `/effort`, `/agent`, `/output`, and raw
  TUI keys `/c`, `/y`, `/n`, `/enter`, `/up`, `/down`, `/tab`
  - `/effort` sets per-thread reasoning effort and offers tappable inline
    buttons (one per available level). **Two backends differ:** Claude has a
    native `/effort <level>` slash command (typed into the TUI; canonical set
    `low…ultracode`, claude clamps unsupported levels per model). OpenCode
    encodes effort as the model's **variant** — read live from
    `GET /config/providers` and applied per-prompt as `body.variant` on the
    prompt request (no env configuration). See plan
    `agent/tasks/completed/2026-05-31-effort-buttons-both-backends.md`.
- **Info / ops:** `/start`, `/status`, `/whoami`, `/version`, `/help`,
  `/doctor`, `/mcp`

When adding a command, follow the existing pattern: register via the
group-gated `command()` wrapper in `bot.ts`, put user-facing text in `i18n.ts`,
and (if it controls the agent) branch on the thread's adapter to drive Claude
(keystrokes) vs OpenCode (HTTP) — **`/model` (`handleClaudeModel` /
`setOpenCodeModel`) is the reference implementation** for a per-thread,
per-backend, persisted agent setting.

## Tests & build

- `yarn test` — unit/integration (`src/__tests__/**/*.test.ts`, node test runner + tsx)
- `yarn typecheck` — `tsc --noEmit`
- `yarn build` — `tsc` → `dist/`
- `yarn dev` — `tsx watch src/cli.ts` (fast dev — TS errors crash the process)
- `yarn hot` / `telegramCode hot` — hot-reload mode: `tsc -w` + `nodemon`
  on `dist/`. A broken intermediate edit can't take the bot down (no
  emit until the build is green), and `nodemon` waits for the old PID's
  graceful shutdown before respawning so the lock changes hands cleanly.
  Agents survive the reload (they run in external `tmux`/`opencode`
  processes); `reattachExistingSessions()` on the next boot re-adopts
  them silently if the downtime gap is short (hot reload), with a
  per-topic notice if it's long (cold start). Globally-installed bin
  resolves the project root via `fs.realpathSync(__dirname)`, so
  `telegramCode hot` works from any CWD.

- **Verify a per-prompt OpenCode override actually applied** (model or `/effort`
  variant): `GET http://127.0.0.1:4096/session/<sessionId>/message` — the stored
  user + assistant turns echo `model.variant`, proving `body.variant` rode the
  prompt (stronger proof than "no HTTP 400"). Claude side: the tmux pane +
  `[Claude] sendInput: "/effort <level>"` in the log.
