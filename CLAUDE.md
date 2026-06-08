# telegram-code — project guide

> Shared rules live in `~/src/.claude/rules/` (loaded automatically). This file is
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

- **Claude Code** runs as an interactive TUI inside `tmux`. The bot drives it
  by **writing keystrokes / slash commands** into the pane via `tmux send-keys`
  (e.g. `/model …`, `/clear`, arrow keys, Enter) and scrapes the rendered
  terminal output with adaptive `capture-pane` polling (300ms while the pane
  changes, backing off to 1.5s when it doesn't; an unchanged frame is skipped
  without any parsing). There is no API — it is screen-driving.
  `CLAUDE_SCRAPE_DEBUG=1` logs full RAW/FILTERED scrape chunks (default:
  one-line size summaries).
- **OpenCode** runs as a local HTTP server. The bot talks to it over
  **HTTP + SSE**: it POSTs prompts to `/session/:id/prompt_async` (with a
  `model: {providerID, modelID}` override) and consumes one
  `/event?directory=<workDir>` stream **per unique bound folder** (not per
  thread). Each directory instance delivers only its own events, so threads
  sharing a folder share one stream and every event is JSON-parsed once and
  routed to the owning session (plan `agent/tasks/completed/2026-06-05-event-loop-saturation-phase1.md`,
  S5). The stream opens with the first active session in a folder and closes
  with the last.

When adding a feature, first decide: *is this a bot-local concern, or something
that must be proxied to the agent?* If it changes agent behavior (model,
effort, prompt, interrupt), it almost always has **two implementations** — a
keystroke sequence for Claude (tmux/pty) and an HTTP call for OpenCode — and
the two backends often expose the capability very differently (e.g. Claude has
a real `/effort` slash command; OpenCode encodes reasoning effort in model
config/variants, not a per-message API field).

## Key concepts

- **One topic ↔ one project folder ↔ one agent session — the bind is mandatory.**
  Each forum topic binds to a subfolder under `WORK_ROOT` and runs its own
  isolated `claude` or `opencode` session **in that folder**. Two topics can
  point at the same folder for parallel work. **No bind → no agent:** an unbound
  topic refuses every agent-facing action (start, `/sessions`, resume) with a
  "bind a folder first" reply — the agent never runs against `WORK_ROOT` itself
  (the old smoke-test fallback is retired). For OpenCode the bind is the
  server-instance selector: sessions are created and listed in that folder's
  project instance via `?directory=<workDir>`.
- **Launch path defines the work root.** The normal operator workflow is
  `cd <projects-parent> && telegramCode`; when `WORK_ROOT` is unset, the
  wrapper uses `$PWD`. Treat `WORK_ROOT` as an advanced override for services or
  containers where the process cwd cannot be controlled.
- **Per-thread isolation.** Routing, sessions, MCP config, model/effort prefs,
  and history are keyed per topic (`ThreadKey` = `"<chatId>:<threadId>"`).
- **Restart-safe.** State is persisted to `state.json`; on restart the bot
  re-attaches to the `tmux` session (Claude) or re-connects SSE (OpenCode).
  Per-thread prefs (e.g. OpenCode model) live in `DATA_DIR` JSON files.
  If the `opencode serve` process crashes, the bot auto-restarts the server
  and **restores** each active session by re-resuming its persisted id
  (sessions persist on opencode disk; the in-flight reply is lost). Explicit
  `/stop`, `/stop-all`, `/quit`, `/unbind` instead **release** the persisted
  session ids — so a later bot restart does NOT auto-reattach those sessions
  (they stay reachable only via the `/sessions` picker).
- **Startup-safe input.** A session has an async boot window (Claude tmux/pty,
  OpenCode server + `POST /session`). Prompts typed during it are buffered
  (`startupPromptBuffer.ts`) and replayed in order when ready — never dropped.
- **Streaming output appends, never overwrites.** OpenCode streams a reply as
  incremental tails; every `output` emit after the first of a response carries
  `isContinuation: true` (`OutputEventMeta` in `types.ts`). The bot appends a
  continuation to the message it is already rendering — re-rendering the FULL
  accumulated text (so `**`/`` ` `` pairs split across flushes re-pair) and
  editing in place; when the combined text outgrows the Telegram cap it spills
  into a new message and keeps growing there (pure planner:
  `utils/outputFlushPlan.ts`). Non-continuation outputs ALWAYS send a new
  message — the old edit-in-place for fresh outputs silently replaced interim
  texts (live bug 2026-06-05). Claude's adapter never marks continuations, so
  its flushes stay one-message-each.
- **Two-instance ready.** A "pet" and a "work" instance can run on one host with
  isolated `DATA_DIR`, group, and OpenCode port.
- **MCP hierarchy.** MCP servers merge across user / group / project / thread
  scopes with `${VAR}` env expansion.
- **Agent scheduling tools (injected).** Separately from that user hierarchy,
  the bot injects its OWN `telegramBot` MCP server (HTTP, loopback `127.0.0.1`,
  per-session thread/dir-scoped HMAC tokens) into EVERY bot-started session —
  Claude via a bot-generated `--mcp-config` file (thread-scoped), OpenCode via
  runtime `POST /mcp?directory=` (dir-scoped, re-registered after a server
  restart). This server exposes the `schedule_*` tools and is bot-owned
  plumbing; it is NOT part of the user-editable `/mcp` hierarchy and never
  touches the user's group/thread config files. Builders live in
  `scheduler/injection.ts`, configured at boot by `wireScheduler` in `bot.ts`
  (if the MCP server fails to bind its port, the bot still boots — injection
  stays inert and only the agent-facing tools are unavailable that run).
- **Scheduled prompts (`src/scheduler/`).** A topic can have scheduled prompts:
  at fire time the bot posts the prompt into the topic, PINS the announcement
  (pins accumulate as run history — the bot never auto-unpins; per-job
  `isPinSilent` makes the pin not notify members, default notifies), then
  delivers the prompt to the topic's agent — reusing an active session
  (waiting for idle up to 10 min rather than interrupting live work) or
  starting one with the thread's last-used adapter. Created via `/schedule`
  (prompt wrapper) or by the agent itself (`schedule_create/list/cancel` MCP
  tools; cron / one-shot / N-times, min interval 5 min, ≤30 jobs per thread).
  Restart-safe: timers re-arm from `state.json` at boot and missed runs fire
  ONE catch-up annotated with the missed time. `/unbind` pauses the thread's
  jobs (one notice); `/bind` resumes them from now (an expired one-shot is
  dropped). Run history: `DATA_DIR/scheduler-runs.jsonl`.
- **Thread-context preamble.** The bot prepends a `[Telegram thread context]`
  block (topic name, group title, `chatId:threadId`, bound folder) to the
  forwarded prompt so the agent knows WHERE it works. Built in
  `threadContextPreamble.ts`; injected in `forwardPromptToAgent` (the single
  choke point). Rides the next prompt only when it changed since last sent —
  per-thread in-memory marker, reset on session start/stop/closed and on
  forwarding a bare `/clear`. Topic name comes from `forum_topic_created` /
  `_edited` (persisted on the binding); the group title from an
  in-memory cache fed by authorised updates. Slash commands skip the preamble.
- **File intake.** A file sent to a bound, agent-active topic (photo,
  document incl. PDF, video, video_note, audio, animation) is downloaded into
  `DATA_DIR/files/<chatId>_<threadId>/` (bot-owned, never inside the bound
  project folder) and announced to the agent through `forwardPromptToAgent` as
  `[Telegram file] <kind> saved to: <path> (<size>)` + caption. Idle/unbound
  thread → same friendly hint as plain text, nothing downloaded; file over the
  20 MB Bot API cap → `file.too_big` reply. A **media album** (multiple files
  sent as one visual message; arrives as N messages sharing `media_group_id`)
  is batched by `(thread, media_group_id)` with a ~2 s debounce after the last
  item into ONE combined `[Telegram album]` prompt (one bullet per saved file +
  the album's caption), so the N items no longer abort each other and gating /
  error hints fire once per album, not N times. The batcher lives in
  `utils/mediaGroupCollector.ts` (pure, debounce + per-group one-shot hint
  guard); prompt text in `buildAlbumPromptText`. **Voice is NOT intake** — it
  stays on the transcription path. Two cleanup mechanisms: a forwarded bare
  `/clear` purges the thread's files dir (agent context gone → files useless),
  and a daily + at-boot age sweep deletes files older than `fileRetentionDays`
  (30). Pure helpers in `telegramFileIntake.ts`; storage/janitor in
  `botFileStorage.ts`.

## Module map (`src/`)

| File | Responsibility |
|------|----------------|
| `cli.ts`, `cli/bot.ts`, `cli/cliClaude.ts` | CLI entrypoints / wiring |
| `cli/envLoader.ts` | Load `.env` (config dir + per-project override) |
| `cli/lock.ts` | Single-instance lockfile |
| `bot.ts` | **The bot.** Telegram handlers, all slash commands, output streaming. Large — most logic lives here |
| `threadRouting.ts` | Resolve which project folder a forum topic is bound to |
| `accessControl.ts` | Who may use the bot: `extractAdminIds` + `AdminCache` (the served group's creator/admins, read live via `getChatAdministrators`, cached 1h). No allow-list env, no `/grant` |
| `state.ts` | Persistence (`state.json`): bindings, sessions, pairing; `resolveDataDir()` |
| `mcpConfig.ts` | Merge MCP server config across the user/group/project/thread hierarchy |
| `i18n.ts` | `t(key, vars)` translations for all user-facing strings |
| `validation.ts` | Input validation for existing-folder `/bind` args (`validateSubdir`, path-traversal/symlink-safe) |
| `folderName.ts` | Pure validation of a typed NEW folder name for the `/bind` create-folder flow (`validateNewFolderName`) — pre-`mkdir` gate (no slashes/traversal/dots/control chars), distinct from `validateSubdir` which requires the folder to exist |
| `rateLimiter.ts` | Per-user / per-action rate limiting |
| `progressLine.ts` | Render the live progress / spinner line |
| `pinnedStatus.ts` | Per-thread pinned status banner (shows model, etc.) |
| `agentTrigger.ts` | Detect agent-ready / prompt triggers in output |
| `threadContextPreamble.ts` | Pure helpers: build the `[Telegram thread context]` preamble (`buildThreadContextPreamble`), decide whether to inject it (`checkShouldInjectPreamble`, `checkShouldSkipPreambleForText`), and glue it ahead of the prompt (`prependThreadContextPreamble`) |
| `telegramFileIntake.ts` | Pure file-intake helpers: normalise the six media kinds (`getTelegramFileMeta`, photo = largest size), read the album id (`getMediaGroupId`), build the safe saved filename (`buildSavedFileName`, sanitised), the agent-facing announcements (`buildFilePromptText` single, `buildAlbumPromptText` album), and the size cap check (`checkIsFileTooBig`) |
| `utils/mediaGroupCollector.ts` | Pure debounced batcher for media albums: `collect(groupKey, item)` re-arms a per-group timer, `onFlush` fires once with items in arrival order; also owns the per-group one-shot hint guard (`checkShouldAnnounceOnce`) so gating/error replies fire once per album |
| `botFileStorage.ts` | Per-thread intake dir layout + janitor: `resolveThreadFilesDir`, `ensureThreadFilesDir`, `purgeThreadFiles` (on `/clear`), `sweepExpiredThreadFiles` (boot + daily age sweep, `fileRetentionDays = 30`) |
| `sendErrorClassifier.ts` | Classify Telegram send failures |
| `openCodeSessionRouting.ts` | Pure helpers: match an SSE event to its owning session via child→parent lineage (`checkIsEventForSession`), record lineage (`updateSessionLineage`) |
| `utils/sseStreamLifecycle.ts` | Pure decision logic for the OpenCode adapter's per-directory SSE streams: open/close edge detection (`getSseStreamTransition`), the directory reference count (`countActiveSessionsForDirectory`), and the wanted-stream set (`getWantedStreamDirectories`) |
| `scheduler/recurrence.ts` | Pure schedule math on `croner`: `ScheduleSpec` (cron / once / N-times), validation (min fire interval 5 min), next-occurrence, human description, catch-up decision |
| `scheduler/store.ts` | Schedule records: create path (slug ids, ≤30/thread cap, `isPinSilent`), persisted in `state.json` `schedules` (lifecycle-independent) |
| `scheduler/engine.ts` | Timer engine: one unref'd timer per job, boot replay with one-catch-up-per-missed-run, no-overlap guard, N-times/once bookkeeping, `whenIdle` drain |
| `scheduler/delivery.ts` | Fire pipeline: announce → pin (notify by default) → wait-for-idle (5s polls, 10 min cap) → forward with the `[Scheduled run]` marker; unbound topic → distinct error |
| `scheduler/mcpSurface.ts` | Bot-owned MCP server (stateless streamable HTTP, `127.0.0.1:4097`): `schedule_create/list/cancel`, HMAC bearer tokens scoped `thread:`/`dir:` |
| `scheduler/injection.ts` | Builders for injecting the bot's MCP entry into sessions: Claude `--mcp-config` object, OpenCode `POST /mcp` registration; inert until configured |
| `scheduler/runLedger.ts` | Append-only JSONL run history (`DATA_DIR/scheduler-runs.jsonl`, 10MB→.1 rotation) |
| `scheduler/directoryThreads.ts` | Pure inversion: directory → thread keys bound to it (the MCP `dir:` scope resolution) |
| `scheduler/rebindResume.ts` | Pure rebind decision: resume a paused job from now, or drop an expired one-shot |
| `diagLog.ts` | Bounded rotating diagnostic log (`appendDiagLog`) under `DATA_DIR/agent-diag.log` — SSE/session lifecycle milestones only, never the per-delta firehose |
| `outputTrace.ts` | Output-trace mode, toggled at runtime via `/trace` (no env var): JSONL record of incoming updates (`recv`), adapter emits (`emit`), and every outgoing Bot API call with outcome (`sendTry`/`sendOk`/`sendErr`, incl. 429 details) under `DATA_DIR/output-trace.jsonl` — lets live verification diff what the bot did vs what reached Telegram. The toggle (`tracedThreads` set + `traceAllThreads` flag) is persisted in `state.json` and re-seeded at boot; an async-buffered, single-flight writer flushes on a 500ms timer / 200-entry threshold (sync flush on process exit). OFF by default → one boolean check per hook. Filtering: `recv`/`emit`/send-with-thread-id record iff the thread is traced (all-flag or in the set); send records with NO derivable thread id (e.g. `editMessageText`) record whenever ANY tracing is active |
| `installManager.ts` | Install / locate the agent binaries, start OpenCode server |
| `utils/resolveBinary.ts` | Resolve `claude` / `opencode` binary paths |
| `utils/pollBackoff.ts` | Pure adaptive poll cadence: `getNextPollDelay` (300ms while the pane changes → ×2 up to 1.5s after 10 unchanged polls; any write/change snaps back) |
| `types.ts` | Shared types incl. the `AgentAdapter` contract and `ThreadKey` |

### Adapters (`src/adapters/`) — the proxy boundary

| File | Responsibility |
|------|----------------|
| `createAdapter.ts` | Factory: pick adapter by tool kind; wire adapter events → bot |
| `claudeCliAdapter.ts` | Claude Code via `tmux` (keystroke driving, adaptive capture-pane polling/scraping) |
| `openCodeAdapter.ts` | OpenCode via HTTP + SSE (POST prompts; one `/event?directory=` stream per bound folder, shared by threads in that folder, parsed once + owner-routed) |

The `AgentAdapter` interface (in `types.ts`) is the seam. Per-backend agent
controls (`setModel`, `getCurrentModel`, `sendInput`, `sendSignal`,
`sendEnter`/`sendArrow`/`sendTab`, lifecycle `startSession`/`stopSession`/
`resumeSession`/`checkIsActive`) are optional methods; the bot checks for them
before calling. New per-backend capabilities are added here first, then surfaced
as a command in `bot.ts`.

## Commands (all registered in `bot.ts`)

- **Session lifecycle:** `/claude`, `/opencode` (`/oc`), `/new`
  (`/clear_session`), `/stop`, `/stop-all`, `/quit` (`/q`), `/sessions`
  (`/resume`), `/rename_session`, `/cancel`, `/clear_messages`, `/compact`
  - `/new` (alias `/clear_session`) stops the thread's current agent session
    and immediately starts a fresh one in the SAME topic with the SAME adapter.
    The old session is **released, not deleted** (its transcript stays on disk
    → still resumable via `/sessions`; a bot restart won't auto-reattach it).
    Reuses the `/stop` release path (`releaseThreadSession`) then
    `startAgentSession` (so it carries startup buffering, typing indicator,
    preamble-marker reset, and the single `agent.ready` notice). Unbound topic →
    bind-required reply; General → a hint that `/new` works inside a bound topic.
    It no longer creates a forum topic (that behavior was removed).
  - `/clear_messages` (formerly `/clear`) deletes this thread's Telegram
    messages (up to 48h, Telegram limit). The bare `/clear` is **no longer
    bot-owned** — it's forwarded verbatim to the agent like `/compact` (Claude
    TUI wipes its context; OpenCode treats it as plain text), and forwarding it
    resets the thread-context preamble marker so the next prompt re-informs the
    agent of its topic. It also **purges the thread's file-intake dir** (the
    agent's context is gone, so any downloaded files it referenced are useless).
  - `/sessions` and its synonym `/resume` list resumable sessions for the
    thread's bound folder as numbered text **and** tappable inline buttons,
    then arm a per-thread pick mode: reply with a bare digit to resume that
    session, `0` or `/cancel` to exit, out-of-range stays armed, any other
    text exits and is handled normally. **Both backends are folder-scoped now**
    (a binding is required to even reach the list): Claude lists real
    `~/.claude/projects/<cwd-slug>/*.jsonl` transcripts filtered by
    `recordedCwd === workDir` (so sessions started by hand on the laptop in
    that folder are resumable too); OpenCode lists the bound folder's project
    instance via `GET /session?directory=<workDir>`. Sessions created in other
    instances (by-hand serve-cwd scatter) no longer appear — accepted tradeoff;
    already-attached ones keep working (by-id calls are cross-instance).
    - **OpenCode session naming:** bot-created OpenCode sessions are created
      WITHOUT a title, so opencode's own LLM auto-titles them from the first
      prompt (e.g. "Debug broken login flow") instead of the old identical
      `Telegram session <chatId>:<threadId>` wall. `/opencode <args>` keeps
      an explicit, never-auto-renamed title. If auto-title never lands the
      adapter falls back to a ~60-char snippet of the first meaningful (non
      slash, ≥10-char) raw prompt via `PATCH /session/:id`. See plan
      `agent/tasks/completed/2026-06-04-opencode-session-autonaming.md`.
  - `/rename_session <new title>` manually renames the CURRENT thread's live
    session (per-backend, adapter-owned optional method like `/model`).
    **OpenCode** renames via instance-scoped `PATCH /session/:id { title }`
    (reusing the auto-naming PATCH helper) and clears `isAutoNamePending` so a
    manual title can never be overwritten by the auto-name fallback; the title
    is trimmed and capped at `sessionTitleSnippetMaxLength` (60). **Claude**
    has no title concept and does not implement the method → the bot replies
    "not supported". No args → usage hint; no active session → "start an agent
    first".
- **Binding & navigation:** `/bind`, `/unbind`, `/where`, `/ls`, `/list`,
  `/pair`
  - `/bind` with no arg shows the folder picker; its FIRST inline button is
    «create new folder» (`bindCreateFolder` callback). Tapping it arms a
    per-thread await-folder-name mode (`awaitingFolderName`): the next text
    message is validated (`validateNewFolderName` in `folderName.ts` — no
    slashes/traversal/dots/control chars), `mkdir`'d under `WORK_ROOT`
    (already-exists → just bind to it), then bound via `applyBinding` with the
    normal welcome stack. Invalid name → error, mode stays armed for retry.
    `/cancel` or any other command exits the mode. `/bind <subdir>` direct form
    is unchanged.
- **Agent control (proxied):** `/model`, `/effort`, `/agent`, `/output`,
  `/schedule`, and raw TUI keys `/c`, `/y`, `/n`, `/enter`, `/up`, `/down`,
  `/tab`
  - `/schedule <free text>` is a **thin prompt wrapper** — the bot owns NO
    scheduling logic. It wraps the request in an agent-facing instruction
    (`schedule.forwardPromptTemplate`; bare `/schedule` →
    `schedule.interviewPromptTemplate`, agent asks what + when) and delivers it
    EXACTLY like a plain user message: `ensureAgentSession` does the
    bind-check + start (unbound → bind-required reply), then
    `deliverPromptOrBuffer` forwards to the live agent or buffers it
    mid-startup. The agent does all the work (parse time → cron/one-shot, call
    the `schedule_create` / `schedule_list` / `schedule_cancel` MCP tools).
    Template instructions stay English in both locales (agent-facing, not
    user-read), but the TARGET reply language is baked per locale (ru → reply
    in Russian, en → in English): a fresh session's only user-language signal
    is the bot locale (live 2026-06-06: "in their language" made the agent
    interview in English). The agent's `schedule_*` MCP tools are injected
    into every bot-started session (see "Agent scheduling tools" above).
  - While a Claude TUI selector is on screen (`isQuestionPending`), a bare
    digit / `y` / `n` reply drives the menu in place (`sendInput`, no
    interrupt Escape); any other text breaks out as a fresh prompt. Pre-fix
    the digit was forwarded as a prompt and its Escape cancelled the menu
    ("Login interrupted").
  - `/model` picked with NO running session persists as the thread pref and
    applies on the next agent start (OpenCode; Claude refuses — its model
    switch is a TUI keystroke with nothing to persist).
  - `/effort` sets per-thread reasoning effort and offers tappable inline
    buttons (one per available level). **Two backends differ:** Claude has a
    native `/effort <level>` slash command (typed into the TUI; canonical set
    `low…ultracode`, claude clamps unsupported levels per model). OpenCode
    encodes effort as the model's **variant** — read live from
    `GET /config/providers` and applied per-prompt as `body.variant` on the
    prompt request (no env configuration). See plan
    `agent/tasks/completed/2026-05-31-effort-buttons-both-backends.md`.
    - **Effort survives the session lifecycle (per-thread, permanent).** claude
      persists effort GLOBALLY in its own settings.json, so a fresh TUI (start /
      `/new` / resume) would otherwise inherit the last globally-set level
      (maybe another topic's). On every fresh spawn the Claude adapter ARMS the
      thread's stored level on the session (`pendingEffortReapply`); the poll
      loop types `/effort <level>` the FIRST time the TUI input box is actually
      ready (`checkIsClaudePromptReady`) — NOT at the spawn instant, when the
      banner is still painting (typing then leaves the command unsubmitted; live
      bug 2026-06-05). One-shot, and strictly before any buffered prompt (same
      serial tmux queue). NOT done on adopt/reattach (the surviving process
      keeps its in-TUI state). OpenCode seeds `effortLevel` from the same
      per-thread pref at session creation.
- **Info / ops:** `/start`, `/status`, `/whoami`, `/version`, `/help`,
  `/doctor`, `/mcp`, `/trace`
  - `/trace on|off` toggles the output-trace recorder for THIS topic; `/trace
    on all` / `/trace off all` flips the every-thread flag (and `off all`
    clears the per-thread set too); bare `/trace` reports status. Persisted in
    `state.json`, lifecycle-independent (session stop/new/quit/resume/unbind
    never touch it). Replaces the retired boot-time `OUTPUT_TRACE` env var.

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

- **ALWAYS verify output/rendering changes LIVE via Telegram MCP — unit tests
  and code review are NOT enough.** Anything touching how agent output reaches a
  topic (`stripTuiElements`, `cleanOutput`, `getNewPaneContent`, fencing,
  progress-collapse in `progressLine.ts`, `renderAgentHtml`, message splitting)
  must be confirmed in a real topic with `mcp__telegram-mcp__get_history` before
  it's considered done. Why: these bugs only show under the real tmux-scrape +
  per-poll-diff timing (e.g. a sub-agent `◯` line fenced → flood) that no
  unit test reproduced — they shipped green and the user caught them. This
  session is itself relayed to a topic, so your own tool calls are live test
  data; in `get_history` raw text a Bash result still showing `⎿` means it was
  NOT fenced, a clean code block (no `⎿`, no literal ```` ``` ````) means the
  HTML `<pre>` was accepted.

- **Live tests touch ONLY the "Telegram code testing" topic** (root message id
  `9085` in ExampleGroup `-1001111111111`). Never send commands, prompts, or
  button presses to any other topic — those are the user's working threads with
  live agent sessions. (User instruction, 2026-06-04.)

- **For send-path / responsiveness / ordering verification, enable the
  output-trace mode** at runtime: send `/trace on` in the topic under test
  (or `/trace on all` for cross-thread forensics), then assert against
  `DATA_DIR/output-trace.jsonl`, not just `get_history`: recv→sendOk latency
  per command, `sendErr` 429s with `retryAfterSec`, emit-vs-sendOk order per
  topic. `/trace off` (or `/trace off all`) stops it; `/trace` reports status.
  The toggle is persisted in `state.json`, so it survives a hot rebuild
  mid-debug — no `.env` edit, no restart.

- **`OpenCode error: Invalid authentication credentials` → restart the OpenCode
  server** (the `opencode serve` process on port 4096) — its provider credentials
  went stale; new sessions keep failing until the server restarts. (User
  instruction, 2026-06-04.)

- **Verify a per-prompt OpenCode override actually applied** (model or `/effort`
  variant): `GET http://127.0.0.1:4096/session/<sessionId>/message` — the stored
  user + assistant turns echo `model.variant`, proving `body.variant` rode the
  prompt (stronger proof than "no HTTP 400"). Claude side: the tmux pane +
  `[Claude] sendInput: "/effort <level>"` in the log.
