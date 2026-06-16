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
  with the last. **Owner resolution is robust (plan
  `agent/tasks/actual/2026-06-08-fix-lost-final-message-and-silent-question-drops.md`,
  S1+S2):** an event routes by `sessionID` (direct id, else child→parent lineage
  ancestor — sub-agents run in CHILD sessions), and when both miss it falls back
  to the stream's DIRECTORY (the sole active session there, or — when two topics
  share a folder — only the one that is a genuine lineage ancestor, else a LOUD
  drop, never a guess). Lineage is recorded from ANY event exposing `parentID`
  (not just `session.updated`) and refreshed-on-use so an actively-routing child
  is never evicted from the bounded map. `question.asked`/`permission.asked` are
  CRITICAL: a genuinely unroutable one is logged, never silently swallowed (the
  old silent drop = the user's "question vanished, looked hung" bug).

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
- **Terminal sessions (`/terminal`).** A topic can bind to a raw interactive
  `$SHELL` (in tmux) instead of an AI agent — a third `AgentAdapter`
  (`terminalAdapter.ts`). The bot proxies the user's text in as keystrokes and
  streams the scraped pane back (stream-only render model: ONE rolling message
  per command). Fresh bot-owned shell per topic (NOT attach-to-existing tmux),
  restart-safe (a live `term-<chatId>-<threadId>` shell re-adopts at boot just
  like an agent — current pane seeds the baseline, no transcript flood; an
  explicitly-stopped shell stays gone). No scheduler-MCP is injected into a
  shell. v1 limitation: full-screen TUIs (vim/htop/less) render messy; normal
  commands stream cleanly. Mutually exclusive with `/claude` / `/opencode`.
- **Restart-safe.** State is persisted to `state.json`; on restart the bot
  re-attaches to the `tmux` session (Claude) or re-connects SSE (OpenCode).
  Per-thread prefs (e.g. OpenCode model) live in `DATA_DIR` JSON files.
  If the `opencode serve` process crashes, the bot auto-restarts the server
  and **restores** each active session by re-resuming its persisted id
  (sessions persist on opencode disk; the in-flight reply is lost). Explicit
  `/stop`, `/stop-all`, `/quit`, and leaving a folder (the `/bind` «leave
  current dir» button) instead **release** the persisted session ids — so a
  later bot restart does NOT auto-reattach those sessions (they stay reachable
  only via the `/sessions` picker).
- **Startup-safe input.** A session has an async boot window (Claude tmux/pty,
  OpenCode server + `POST /session`). Prompts typed during it are buffered
  (`startupPromptBuffer.ts`) and replayed in order when ready — never dropped.
- **Agent start UX — one-tap start + ONE typing loader.** The post-bind welcome
  buttons (▶️ Claude / ▶️ OpenCode) START the chosen agent in one tap (the
  `agent_<name>` callback funnels through `handleAgentStart`, the shared core
  also behind `/claude` `/opencode` `/terminal`), not a select-then-type step.
  The sole "agent is working" cue is the native typing indicator (`startTypingLoader`
  re-fires `sendChatAction('typing')` every `typingLoaderRefreshMs`; it REPLACED
  the old `⏳` placeholder message). It runs at every wait point — a self-greeting
  agent's boot AND every prompt forward — and is cleared ONLY by a real event
  (first output via `handleAgentOutput`, a status/question frame, or session
  teardown / start-fail via `stopTypingLoader`); there is NO timeout, so a
  long-thinking agent keeps showing it. An adapter that prints its own greeting
  declares `selfGreetsOnStart` (Claude's TUI banner) — then `startAgentSession`
  suppresses the bot's `agent.ready` notice (returns `''` via `getStartReadyMessage`)
  and keeps the loader up until that banner lands. OpenCode/terminal don't
  self-greet, so they keep the `agent.ready` / `terminal.ready` cue (and boot uses
  a one-shot typing ping, not the sustained loader — no output is coming yet).
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
- **Output transport seam (CHAT_MODE-selected).** HOW agent output reaches a topic
  is chosen ONCE at boot by `CHAT_MODE` via `createOutputTransport` (`src/output/`),
  mirroring the `AgentAdapter` factory — no per-call surface branch. **Group** =
  the `queueOutput` edit-in-place path above. **DM** (`src/output/dmOutputTransport.ts`)
  = the live "cursor" draft: ONE accumulating native `sendMessageDraft` holds the
  full current reply, FINALIZED to a permanent `sendMessage` on boundaries (idle
  ~4s / 4096 overflow / isFinal / new-response / status / teardown); `isComplete`
  one-shots post directly. **Both backends stream via the cursor** now: OpenCode
  marks `isContinuation` directly; the Claude scrape adapter emits each poll's
  classifier-filtered prose delta with NO meta, so the DM transport synthesises the
  continuation flag (`getDmDraftContinuation`, gated on the adapter's
  `outputsDeltas`) — its deltas accumulate into ONE full-snapshot draft instead of
  finalizing per poll. Tools/status stay separate transients. The Claude liveness
  heartbeat is kept noop while a draft is active (`OutputTransport.checkIsStreaming`
  ORed into `checkIsOutputStreaming`) so it can't insert a status frame between
  deltas and chop the draft mid-answer. `OutputTransport` interface lives in
  `types.ts`. In **`both`** the factory returns a DISPATCHER that routes each
  per-thread call by `checkIsDmKey(key)` to a once-built DM impl or group impl —
  so one instance streams the owner DM via the cursor AND the group edit-in-place
  at the same time.
- **CHAT_MODE — one surface or both (default `both`).** `CHAT_MODE` selects which
  Telegram surface(s) the instance serves: `group` (forum supergroup only), `dm`
  (the owner's private chat only), or `both` (DEFAULT) — ONE instance serves the
  owner DM AND the group at once, decided PER CHAT off the resolved `ThreadKey`
  (`checkIsDmKey(key) = key.chatId === ownerUserId`, since a DM key carries the
  owner's chat id). `OWNER_USER_ID` is REQUIRED for `dm`; for `both` it is
  OPTIONAL — unset → the DM surface is INERT (group-only, boot logs a notice), so
  a bare `telegramCode` stays backward-compatible with a group-only deploy and
  lights up DM the moment `OWNER_USER_ID` is set. Access stays per surface: the
  owner id gates the DM chat, the served group's admin cache gates the group chat
  (`checkIsAllowedUser(ctx)` is the single per-chat authority). The bi-surface
  key resolution (`resolveThreadKeyForMode`) and discriminator
  (`checkIsDmThreadKey`) are pure in `threadRouting.ts`; `bot.ts` wraps them with
  the runtime config.
- **Two-instance ready.** A "pet" and a "work" instance can run on one host with
  isolated `DATA_DIR`, group, and OpenCode port. (Orthogonal to `CHAT_MODE=both`,
  which serves both surfaces from ONE instance — use two instances when you want
  process-level isolation/distribution instead.)
- **MCP hierarchy.** MCP servers merge across user / group / project / thread
  scopes with `${VAR}` env expansion.
- **Agent scheduling tools (injected).** Separately from that user hierarchy,
  the bot injects its OWN `telegramBot` MCP server (HTTP, loopback `127.0.0.1`,
  per-session thread/dir-scoped HMAC tokens) into EVERY bot-started session —
  Claude via a bot-generated `--mcp-config` file (thread-scoped), OpenCode via
  runtime `POST /mcp?directory=` (dir-scoped, re-registered after a server
  restart). This server exposes the `schedule_*` tools plus `send_file`
  (agent→user file/image send into the topic, dir/thread-scoped exactly like the
  `schedule_*` tools — no new server/port/token/injection) and is bot-owned
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
  ONE catch-up annotated with the missed time. Leaving a folder (the `/bind`
  «leave current dir» button) pauses the thread's jobs (one notice); `/bind`
  resumes them from now (an expired one-shot is dropped). Run history:
  `DATA_DIR/scheduler-runs.jsonl`.
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
- **Auto-retry on API errors (`src/apiErrorRetry.ts` + the `bot.ts` retry
  manager; plan `agent/tasks/completed/2026-06-09-api-error-auto-retry.md`).**
  When the agent dies on a provider API error the bot doesn't leave the topic
  looking hung — it classifies the error and auto-resumes after a backoff.
  Detection is at the **adapter boundary** via a new `apiError` event: OpenCode
  classifies in `handleSessionError` (`session.error`, structural); Claude
  detects the terminal `API Error:` line in `handleAutoLifecycle` behind a
  one-shot guard. Classes (markers verified against the `claude.exe` string
  table): *transient* (rate-limit / overloaded / 429·503·529) → retry +5/10/20
  min, 3 tries; *usageLimit* (usage-limit reached / credit-balance too low) →
  +60 min re-armed each repeat up to 6× (or a parsed reset time, rare); *auth*
  (login / bad credentials) → never retried. On fire the bot posts a notice and
  nudges the still-live session with a neutral "continue" via
  `forwardPromptToAgent` (NEVER a wait-for-idle path — OpenCode's optimistic
  `isBusy` is not cleared on `session.error` and would stall the 10-min cap).
  Any user message / `/stop` / `/new` / `/quit` / leaving a folder cancels a
  pending retry; pending retries survive a bot restart (`state.json` `apiRetries`,
  re-armed after reattach). **⚠️ Known check (not yet verified live):** the
  Claude scrape-detection regex (`^\s*API Error:`, run over `cleanOutput(raw)`
  WITHOUT `stripTuiElements`) was never confirmed against a real raw TUI render
  — a rate-limit isn't inducible on demand. **So if a Claude API error did NOT
  auto-retry, first grep the bot log for `[Claude] API error detected`: absent
  ⇒ the regex missed the line (likely a chrome prefix like `✗ ` / box char) and
  must be widened.** OpenCode's structural path needs no such check.

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
| `progressLine.ts` | Classify + collapse Claude's transient progress shapes so they roll in ONE edited status message: `PROGRESS_LINE_RE` (spinner tick — the activity title may carry parenthesised segments like `(sub-agent)`; the end-anchored `(time · tokens)` stats parenthesis is the load-bearing anchor), sub-agent `◯` panel frames, `/compact` verb+bar lines; `checkIsProgressChunk` (every line must match) + `collapseProgressChunk` (latest frame per shape) |
| `pinnedStatus.ts` | Per-thread pinned status banner (shows model, etc.) |
| `agentTrigger.ts` | Detect agent-ready / prompt triggers in output |
| `threadContextPreamble.ts` | Pure helpers: build the `[Telegram thread context]` preamble (`buildThreadContextPreamble`), decide whether to inject it (`checkShouldInjectPreamble`, `checkShouldSkipPreambleForText`), and glue it ahead of the prompt (`prependThreadContextPreamble`) |
| `telegramFileIntake.ts` | Pure file-intake helpers: normalise the six media kinds (`getTelegramFileMeta`, photo = largest size), read the album id (`getMediaGroupId`), build the safe saved filename (`buildSavedFileName`, sanitised), the agent-facing announcements (`buildFilePromptText` single, `buildAlbumPromptText` album), and the size cap check (`checkIsFileTooBig`) |
| `utils/mediaGroupCollector.ts` | Pure debounced batcher for media albums: `collect(groupKey, item)` re-arms a per-group timer, `onFlush` fires once with items in arrival order; also owns the per-group one-shot hint guard (`checkShouldAnnounceOnce`) so gating/error replies fire once per album |
| `botFileStorage.ts` | Per-thread intake dir layout + janitor: `resolveThreadFilesDir`, `ensureThreadFilesDir`, `purgeThreadFiles` (on `/clear`), `sweepExpiredThreadFiles` (boot + daily age sweep, `fileRetentionDays = 30`) |
| `sendErrorClassifier.ts` | Classify Telegram send failures |
| `apiErrorRetry.ts` | Pure auto-retry decision layer for agent **API** errors: `classifyAgentApiError` (transient / usageLimit / null-for-auth; markers from the claude.exe strings), `parseResetAt`, `getRetryPlan` (backoff schedule), `decideRetryAction` (arm/ignore/giveUp + grace-window dedup). The `bot.ts` manager owns the timer + kick |
| `openCodeSessionRouting.ts` | Pure helpers: match an SSE event to its owning session via child→parent lineage (`checkIsEventForSession`), record lineage (`updateSessionLineage`), verify strict descent (`getLineageDepthToAncestor` — busy tracking records a busy CHILD only for a verified descendant, so a dir-fallback-routed foreign sibling's busy=true never pins the thread busy) |
| `utils/sseStreamLifecycle.ts` | Pure decision logic for the OpenCode adapter's per-directory SSE streams: open/close edge detection (`getSseStreamTransition`), the directory reference count (`countActiveSessionsForDirectory`), and the wanted-stream set (`getWantedStreamDirectories`) |
| `utils/displayVerbosity.ts` | THE shared display-verbosity vocabulary for `/thinking` / `/tool_results` / `/subagent`: option order (`displayVerbosityModeOptions`: minimal, short, full), the locked default (`defaultDisplayVerbosityMode` = `minimal`), the type guard (`checkIsDisplayVerbosityMode`), and the legacy-name normalization (`normalizeDisplayVerbosityMode`: `detailed`→`full`, `brief`→`short`, `hide`→`minimal`, `compact`→`short`; unknown→null) used both for old persisted values and old command/callback aliases |
| `utils/verbosityRender.ts` | Pure decision helper for the `/verbosity` umbrella picker: `getUniformVerbosityLevel` returns the level all three display prefs share (✓ marker target) or `null` when mixed → rendered as "custom" with the three values spelled out. The macro's write path just reuses the per-command apply helpers in `bot.ts` |
| `utils/thinkingRender.ts` | Pure decision/format helpers behind `/thinking`: the OpenCode mode×phase action matrix (`getThinkingEventAction`), the answer-start removal rule, the ms→seconds formatter (`formatThinkingDurationSeconds`), and — for the Claude scrape path (no ms timestamps) — `parseThinkingDurationSeconds` (scrapes the duration out of the "Thinking for…" header / "✻ … for Ns" trailer) |
| `utils/toolResultRender.ts` | Pure helpers for tool-result rendering behind `/tool_results`: mode→render action (`getToolResultRenderAction`), and the `short`-mode dual-cap truncation (`getTruncatedToolResult`, 15 lines / 1200 chars, line-boundary-preserving) |
| `utils/subagentRender.ts` | Sub-agent rendering helpers behind `/subagent`: the mode×part-kind matrix the adapter consults for child-session parts (`getSubagentPartAction`: text→status/stream, tool→ignore/status, reasoning→always ignore; `minimal` ≡ `short` here, v1), the status-only rolling status line (`buildSubagentStatusText`), the parent-side in-flight delegation status (`buildDelegatingStatusText`) and the full-mode chunk marker (`buildSubagentOutputPrefix`) |
| `utils/subagentStatusRender.ts` | Pure helpers behind the DEDICATED OpenCode sub-agent status message (non-`full`): `getSubagentStatusAction` (open/refresh/close/noop lifecycle from "message exists?" × "event active?"), `formatElapsed` (`m:ss`), `buildSubagentElapsedText` ("🤖 sub-agent: <title> · m:ss"). The bot's `handleSubagentStatus` owns the message id + the 10 s elapsed tick timer; replaces the flood-prone shared-status line |
| `utils/claudeScrapeShapes.ts` | THE single source of truth for Claude TUI line-shape regexes (one definition per shape): tool headers (`ANY_TOOL_HEADER_RE` superset of `OUTPUT_TOOL_HEADER_RE`+`FILE_TOOL_HEADER_RE` — incl. `Update`, Claude's render of Edit), `⎿` result marker, thinking header/trailer, collapse markers (`COLLAPSE_MARKER_RE` "+N tool uses/lines"; `COLLAPSE_TOOLUSE_MARKER_RE` "+N tool uses" only, for the orphan-panel-chatter drop), spinner ticks, chrome. **Assistant-output bullet:** detection accepts BOTH `●` (U+25CF) and `⏺` (U+23FA) — Claude Code v2.1.177 renders the output bullet as `⏺`; the older `●`-only regexes silently missed it (live 2026-06-15: a wide table's `⏺ ┌…` top border was never detected → the whole table was lost). When adding a regex that anchors on the bullet, match both glyphs (NOT the spinner-tick classes — `⏺` is a static bullet, not an animation frame) |
| `utils/claudeChunkClassifier.ts` | Pure classifier for the Claude relay (S3): segments a scraped pane chunk into tagged runs (`classifyClaudeChunk` → thinking / tool-header / tool-body / sub-agent-panel-preview / prose / chrome), threading fence/block context across polls. Conservative default-to-prose so the answer is never swallowed; an orphan "+N tool uses" wall → chrome |
| `utils/claudeRelayRouting.ts` | Pure per-pref router for the classifier's segments (S4–S6): `routeClaudeChunkSegments` keeps prose always, applies `/tool_results` + `/thinking` per segment (full keep / short truncate-or-collapse / minimal fold), always folds sub-agent panel previews to status, and returns `keptText` (permanent) + the one rolling `activityLine`; `checkIsClaudeRelayFastPath` is the all-`full` byte-identical regression anchor |
| `utils/claudeSubagentTail.ts` | Pure decision logic for Claude's `/subagent full` transcript tailing: per-file tail state (byte offset + partial-line carry), the scan planner (`getSubagentTailReads`: first scan seeds offsets to EOF with no reads = no backlog replay; non-`full` modes fast-forward without reading; full returns `[offset..size)` ranges), the transcript filename filter (`checkIsSubagentTranscriptName`), and the extractor (`extractAppendedSubagentTexts`: assistant `text` blocks only — thinking/tool_use/user/attachment dropped, malformed JSONL lines skipped). The adapter's poll tick does the fs work |
| `utils/fileSendPlan.ts` | Pure decision layer for the agent→Telegram `send_file`: path-safety (`resolveSendFileWithinDir` — realpath containment + regular-file gate inside the bound folder, mirrors `validateSubdir` but for a file, returns a result instead of throwing), extension→render-kind (`classifyFileSendKind`: photo/animation/document), and the single/album send plan (`planFileSend`: `as_file` + >10MB-photo→document downgrade, all-photo→albumPhoto else albumDocument, size/count → error variant) + `trimCaption` (1024 cap) |
| `scheduler/recurrence.ts` | Pure schedule math on `croner`: `ScheduleSpec` (cron / once / N-times), validation (min fire interval 5 min), next-occurrence, human description, catch-up decision |
| `scheduler/store.ts` | Schedule records: create path (slug ids, ≤30/thread cap, `isPinSilent`), persisted in `state.json` `schedules` (lifecycle-independent) |
| `scheduler/engine.ts` | Timer engine: one unref'd timer per job, boot replay with one-catch-up-per-missed-run, no-overlap guard, N-times/once bookkeeping, `whenIdle` drain |
| `scheduler/delivery.ts` | Fire pipeline: announce → pin (notify by default) → wait-for-idle (5s polls, 10 min cap) → forward with the `[Scheduled run]` marker; unbound topic → distinct error |
| `scheduler/mcpSurface.ts` | Bot-owned MCP server (stateless streamable HTTP, `127.0.0.1:4097`): `schedule_create/list/cancel` + `send_file` (agent→Telegram file/image, separate `registerFileSendTool`), HMAC bearer tokens scoped `thread:`/`dir:` |
| `scheduler/injection.ts` | Builders for injecting the bot's MCP entry into sessions: Claude `--mcp-config` object, OpenCode `POST /mcp` registration; inert until configured |
| `scheduler/runLedger.ts` | Append-only JSONL run history (`DATA_DIR/scheduler-runs.jsonl`, 10MB→.1 rotation) |
| `scheduler/directoryThreads.ts` | Pure inversion: directory → thread keys bound to it (the MCP `dir:` scope resolution) |
| `scheduler/rebindResume.ts` | Pure rebind decision: resume a paused job from now, or drop an expired one-shot |
| `diagLog.ts` | Bounded rotating diagnostic log (`appendDiagLog`) under `DATA_DIR/agent-diag.log` — SSE/session lifecycle milestones only, never the per-delta firehose |
| `outputTrace.ts` | Output-trace mode, toggled at runtime via `/trace` (no env var): JSONL record of incoming updates (`recv`), adapter emits (`emit`), and every outgoing Bot API call with outcome (`sendTry`/`sendOk`/`sendErr`, incl. 429 details) under `DATA_DIR/output-trace.jsonl` — lets live verification diff what the bot did vs what reached Telegram. The toggle (`tracedThreads` set + `traceAllThreads` flag) is persisted in `state.json` and re-seeded at boot; an async-buffered, single-flight writer flushes on a 500ms timer / 200-entry threshold (sync flush on process exit). OFF by default → one boolean check per hook. Filtering: `recv`/`emit`/send-with-thread-id record iff the thread is traced (all-flag or in the set); send records with NO derivable thread id (e.g. `editMessageText`) record whenever ANY tracing is active |
| `installManager.ts` | Install / locate the agent binaries, start OpenCode server |
| `utils/resolveBinary.ts` | Resolve `claude` / `opencode` binary paths |
| `utils/pollBackoff.ts` | Pure adaptive poll cadence: `getNextPollDelay` (300ms while the pane changes → ×2 up to 1.5s after 10 unchanged polls; any write/change snaps back) |
| `utils/tmuxExec.ts` | Generic tmux/shell primitives shared by the claude + terminal backends (relocated from `claudeCliAdapter`): `tmuxAsync`/`tmuxOrThrowAsync` (best-effort vs strict tmux calls), `checkArgsAreSafe` (reject control chars), `shellSingleQuote`, `execFilePromise` |
| `utils/ansiClean.ts` | Pane-text cleaning shared by both tmux backends (relocated from `claudeCliAdapter`): `convertAnsiToMarkdown` (ANSI→Telegram markdown, OSC-8 strip, spinner-glyph de-bold), `cleanOutput` (full clean pipeline), private `joinBrokenUrls` |
| `utils/paneDiff.ts` | Pure line-SET diff between two tmux pane captures (relocated from `claudeCliAdapter`): `getNewPaneContent` + `NewPaneContent` (only NEW lines, `startsNewParagraph` out-of-band); imports `normalizeForComparison` from `utils/recentRelayWindow` so both backends share one normalization domain |
| `utils/tmuxSessionName.ts` | Pure parameterized tmux session-name codec shared by the tmux backends: `buildTmuxSessionName(prefix, key)` / `parseTmuxSessionName(prefix, name)` — careful negative-chatId + strict per-half regex so a foreign session sharing a prefix is never mis-adopted. Claude binds the `'claude'` prefix via thin wrappers; terminal the `'term'` prefix |
| `utils/terminalEmitPlan.ts` | Pure helpers behind `terminalAdapter`: `getTerminalEmitPlan(nextOutputFresh)` (fresh→new message, else continuation — one rolling message per command), `buildTerminalNewSessionArgs` (the `tmux new-session` argv: shell-command + `-c workDir` + size flags, no `--session-id`/permission/MCP), and the named constants (`terminalPaneCols` 200, `terminalPaneRows` 50, `terminalTmuxPrefix` `term`, `defaultShell`) |
| `types.ts` | Shared types incl. the `AgentAdapter` contract and `ThreadKey` |

### Adapters (`src/adapters/`) — the proxy boundary

| File | Responsibility |
|------|----------------|
| `createAdapter.ts` | Factory: pick adapter by tool kind; wire adapter events → bot |
| `claudeCliAdapter.ts` | Claude Code via `tmux` (keystroke driving, adaptive capture-pane polling/scraping; the poll tick also tails the on-disk sub-agent transcripts for `/subagent full`). Owns the Claude-TUI scrape logic + table stabilizer; the GENERIC tmux/ANSI/diff primitives now live in `utils/tmuxExec`, `utils/ansiClean`, `utils/paneDiff`, `utils/tmuxSessionName` (shared with the terminal backend) and are re-exported here for back-compat |
| `openCodeAdapter.ts` | OpenCode via HTTP + SSE (POST prompts; one `/event?directory=` stream per bound folder, shared by threads in that folder, parsed once + owner-routed) |
| `terminalAdapter.ts` | A raw interactive `$SHELL` in `tmux` — a third adapter sibling to claude/opencode (NO AI logic). Types the user's text in as keystrokes (`send-keys`) and streams the scraped pane back as ONE rolling message per command (generic capture → line-set-diff → `cleanOutput` → emit; no question/survey/sub-agent/tool-result/effort/MCP/resume machinery). Restart-safe: `listExistingTmuxSessions`/`adoptExistingTmuxSession` re-adopt a live `term-…` session at boot (current pane seeds the baseline, no flood). Does NOT extend `ClaudeCliAdapter` and leaves `outputsDeltas` falsy, so the Claude liveness loop never fires for it |

The `AgentAdapter` interface (in `types.ts`) is the seam. Per-backend agent
controls (`setModel`, `getCurrentModel`, `sendInput`, `sendSignal`,
`sendEnter`/`sendArrow`/`sendTab`, lifecycle `startSession`/`stopSession`/
`resumeSession`/`checkIsActive`) are optional methods; the bot checks for them
before calling. New per-backend capabilities are added here first, then surfaced
as a command in `bot.ts`.

### Output transport (`src/output/`) — the per-mode output boundary

| File | Responsibility |
|------|----------------|
| `createOutputTransport.ts` | Factory: pick the output transport by `CHAT_MODE` (the single mode decision); thin group impl (`queueOutput` + noop finalize), DM delegates to `createDmOutputTransport`, `both` returns a per-key dispatcher (`checkIsDmKey`) over both impls |
| `dmOutputTransport.ts` | The DM draft-cursor manager (relocated out of `bot.ts`): `deliverOutput` 3-way route (draft / `isComplete` one-shot / `queueOutput` baseline), `finalizeInFlight`, `disposeThread`, and the whole draft state + send/pace/idle machinery — built from injected `bot.ts` primitives |

The `OutputTransport` interface (in `types.ts`) is the seam, selected once at boot
(`registerOutputTransport`, mirroring `registerDisplayPrefsReader`). `queueOutput`
and `sendAgentChunks` stay shared primitives in `bot.ts` (group + the DM Claude
baseline / one-shot use them too). Thinking frames, sub-agent status, and pinned
status are NOT part of this seam — they are mode-orthogonal (`displayPrefs` /
OpenCode events / bindings).

## Commands (all registered in `bot.ts`)

- **Session lifecycle:** `/claude`, `/opencode` (`/oc`), `/terminal`, `/new`
  (`/clear_session`), `/stop`, `/stop-all`, `/quit` (`/q`), `/sessions`
  (`/resume`), `/rename_session`, `/clear_messages`, `/compact`
  - `/terminal` starts a raw interactive `$SHELL` in the topic's bound folder
    (a third adapter sibling to `/claude` / `/opencode`, mutually exclusive with
    them via `switchThreadAdapter`). Unbound topic / General → the same
    bind-required reply agents give. While active, EVERY plain text message is
    typed in as a command (Enter appended) and routed DIRECTLY via
    `adapter.sendInput` — skipping `forwardPromptToAgent` (no `[thread context]`
    preamble, no typing loader, no interrupt). Output streams back as ONE rolling
    message per command (continuation), like OpenCode. Raw keys reuse the
    existing TUI commands: `/c` (Ctrl-C), `/up`·`/down` (history), `/tab`
    (completion), `/enter`. `/stop`·`/new`·`/quit`·leaving a folder work as for
    agents; `/sessions` lists nothing (shells aren't resumable); `/model`
    `/effort` `/thinking` `/tool_results` `/subagent` `/rename_session` reply
    "not supported" (those adapter methods are simply absent). `/schedule`
    against a terminal is out of scope for v1. Terminal sessions are NOT
    auto-started by a natural-language phrase — only by the explicit command.
    Accepted v1 limitation: full-screen / cursor-addressed TUIs (vim, htop,
    less) repaint the whole pane and look messy; normal commands/builds/logs
    stream cleanly.
  - `/new` (alias `/clear_session`) stops the thread's current agent session
    and immediately starts a fresh one in the SAME topic with the SAME adapter.
    The old session is **released, not deleted** (its transcript stays on disk
    → still resumable via `/sessions`; a bot restart won't auto-reattach it).
    Reuses the `/stop` release path (`releaseThreadSession`) then
    `startAgentSession` (so it carries startup buffering, the typing loader, and
    the preamble-marker reset). The `agent.ready` notice is shown only for a
    non-self-greeting backend (OpenCode/terminal) — Claude prints its own banner,
    so `startAgentSession` returns `''` and the typing loader covers the gap (see
    "agent start / typing loader" below). Unbound topic → bind-required reply;
    General → a hint that `/new` works inside a bound topic. It no longer creates
    a forum topic (that behavior was removed).
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
    session, `0` to exit, out-of-range stays armed, any other
    text exits and is handled normally. A picked session is **persisted** as
    the thread's session id (`state.json`), so a bot restart (hot rebuild
    included) re-attaches to the pick — previously only fresh starts
    persisted and a restart silently fell back to the pre-resume session.
    **Both backends are folder-scoped now**
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
- **Binding & navigation:** `/bind`, `/ls`, `/list`, `/pair`
  - `/bind` is the single binding hub — there is no `/unbind` or `/where`
    command. The no-arg picker prints the current-binding line (replacing
    `/where`'s per-topic output) and carries action rows ABOVE the folders:
    when the topic is BOUND, the FIRST button is «leave current dir»
    (`bindLeaveCurrent` callback → `unbindThread`: stop session, drop pin,
    release ids, pause schedules, wipe binding — the folded-in `/unbind`);
    next is «create new folder» (`bindCreateFolder` callback). An unbound topic
    omits the leave row (nothing to leave). Tapping «create new folder» arms a
    per-thread await-folder-name mode (`awaitingFolderName`): the next text
    message is validated (`validateNewFolderName` in `folderName.ts` — no
    slashes/traversal/dots/control chars), `mkdir`'d under `WORK_ROOT`
    (already-exists → just bind to it), then bound via `applyBinding` with the
    normal welcome stack. Invalid name → error, mode stays armed for retry.
    Any command exits the mode. `/bind <subdir>` direct form is unchanged.
- **Agent control (proxied):** `/model`, `/effort`, `/verbosity`, `/thinking`,
  `/tool_results`, `/subagent`, `/output`, `/schedule`, and raw TUI
  keys `/c`, `/y`, `/n`, `/enter`, `/up`, `/down`, `/tab`, `/esc` (`/escape`)
  - `/esc` (alias `/escape`) sends a raw Escape keystroke to the live agent
    (Claude: interrupt the current turn / dismiss a selector via
    `sendEscape` → `tmux send-keys Escape`, a fire-and-forget one-shot, NOT a
    wait-for-idle interrupt; OpenCode: "not supported").
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
  - **`/login` OAuth code paste.** The login flow's last step shows
    `Paste code here if prompted >` (a plain `>` box, not `❯`/a selector).
    While it is up (`isLoginPastePending`, `checkIsClaudeLoginPaste` off the
    last pane) ANY text reply is typed VERBATIM via `sendInput` — no Escape, no
    thread-context preamble — then the user's message is deleted from the topic
    (the code is a single-use secret) and a `🔐 code relayed` confirmation is
    posted. Pre-fix the long code fell to the prompt path, whose Escape
    cancelled the login and whose preamble corrupted the code ("login can't be
    done via the bot").
  - `/model` picked with NO running session persists as the thread pref and
    applies on the next agent start (OpenCode; Claude refuses — its model
    switch is a TUI keystroke with nothing to persist).
  - `/effort` sets per-thread reasoning effort and offers tappable inline
    buttons (one per available level). **Works pre-session like `/model`** (no
    `checkIsActive` gate): the pick is persisted and the next session replays it
    — the picker lists the PROSPECTIVE model's levels (OpenCode resolves it from
    the live session → saved `/model` pref → server default; Claude's canonical
    set is session-independent). Picking before a session start returns a soft
    "start an agent" notice, not a refusal. **Two backends differ:** Claude has a
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
  - `/verbosity [minimal|short|full]` is the umbrella macro over the three
    display prefs below: it sets thinking + tool results + sub-agents to ONE
    level at once (same store as the individual commands, so those keep
    point-overriding afterwards — last write per pref wins). Both backends, no
    session needed. Bare `/verbosity` shows a 3-button picker (`verb_<mode>`):
    ✓ on a level IFF all three prefs equal it; mixed prefs render as "custom"
    with the three current values spelled out (decision helper
    `getUniformVerbosityLevel` in `utils/verbosityRender.ts`).
  - `/thinking [minimal|short|full]` and `/tool_results [minimal|short|full]`
    set per-topic DISPLAY modes (bot-rendering concerns, never sent to the
    agent), persisted in `state.json` `displayPrefs` and lifecycle-independent.
    They work on **BOTH backends** now (`/tool_results` un-gated in S4,
    `/thinking` in S5) — like `/subagent`. The MECHANISM differs per backend:
    OpenCode renders from its SSE events; Claude has no API, so the scraped pane
    chunk runs through the classifier (`utils/claudeChunkClassifier.ts` — tags
    each run of lines thinking / tool-header / tool-body / sub-agent-panel-
    preview / prose / chrome, threading fence context across polls) and the
    per-pref relay router (`utils/claudeRelayRouting.ts`) which keeps /
    truncates / folds each segment. PROSE is ALWAYS kept (the answer is never
    swallowed); a sub-agent panel preview (incl. orphan "… +N tool uses" walls)
    and `minimal`-mode tool/thinking always fold into the ONE rolling status
    frame — this is what keeps a `minimal` topic quiet under a long delegation.
    (`Update`, Claude's TUI render of the Edit tool, is in the recognised header
    set, so Edit headers + their `⎿ Update(…)` previews route like any other
    tool.) All three commands share ONE unified mode vocabulary
    (`minimal|short|full`, default `minimal`; old names
    `detailed`/`brief`/`hide`/`compact` persist/parse as hidden aliases via
    `utils/displayVerbosity.ts` — pickers and replies show only the new
    names). All offer inline mode buttons (✓ on current) and work with no
    session running. **`/thinking`** (default `minimal`) controls what REMAINS
    of the chain-of-thought — the live "☁️ thinking …" indicator shows in ALL
    modes: `full` keeps the full reasoning, `short` collapses it to "💭 thought
    for {N}s" (OpenCode times it from ms; Claude scrapes the duration from the
    "Thinking for…" header / "✻ … for Ns" trailer via
    `parseThinkingDurationSeconds`, and the "💭" collapse line is force-kept past
    the status-frame heuristic so it isn't mistaken for a transient), `minimal`
    keeps nothing permanent (the live status stays / is deleted when the answer
    starts). **`/tool_results`** (default `minimal`) controls a completed tool
    call's OUTPUT: `full` = whole body, `short` = capped at 15 lines / 1200
    chars + a "… (truncated, /tool_results full)" footer, `minimal` = only the
    transient 🔧 status. OpenCode posts it as its own "🔧 <tool> →" fenced
    message via a dedicated `toolResult` event (never mixed into the answer's
    continuation chain); Claude routes the scraped `● Tool(…)` header + `⎿` body
    segments through the same keep/truncate/fold matrix.
    **`/subagent`** (default `minimal`) controls a sub-agent's transcript on
    BOTH backends — `minimal` ≡ `short` here (v1): both are status-only, so
    no mode ever hides the "working" indicator (locked decision). Shared
    parity rules: child reasoning is NEVER rendered and
    child tool calls/results are never streamed (the parent's task result
    carries the final outcome); in `full` mode child TEXT streams as chunks
    marked "🤖 ⤷" OUTSIDE the parent's continuation chain
    (`OutputEventMeta.isSubagent`). **OpenCode** (child-session SSE events):
    non-`full` = the child transcript is NOT streamed; a DEDICATED
    self-updating message "🤖 sub-agent: <title> · m:ss" (its own
    `subagentStatusMessageId`, independent of the shared transient
    `statusMessageId`) opens on delegation start, is edited in place every
    `subagentTickMs` (10 s) with a ticking elapsed counter, and is deleted when
    the delegation ends / the parent turn idles / the session stops (the
    dedicated `subagentStatus` adapter event drives open/refresh/close). This
    replaced the old shared-status line, whose lost single-message identity
    re-`sendMessage`d a NEW message per sparse child-text burst — the flood the
    user hit (one 14-min delegation → 14 identical posts). The title is sticky
    (last non-null `task`-part title/description; upgrades from the "sub-agent"
    fallback as soon as the parent's running `task` part carries it — a short
    delegation that ends first stays on the fallback, by design). The competing
    "Delegating…" shared status is suppressed in non-`full`. `full` = a separate
    adapter-side child accumulator streams the text, and the parent's
    pending/running `task` part keeps the generic "🤖 Delegating: <title> …"
    shared status (`buildDelegatingStatusText`); completed/error keep the
    generic ✅/❌. **Claude** (no child
    events — its TUI renders sub-agents itself): non-`full` = nothing extra,
    the TUI's ◯ task-panel line rolls inside the coalesced status frame;
    `full` = the poll loop ADDITIONALLY tails the on-disk sub-agent
    transcripts (`~/.claude/projects/<slug>/<sessionId>/subagents/
    agent-*.jsonl`) and streams the appended assistant `text` blocks — no
    backlog replay on resume/adopt (the first scan seeds offsets to EOF), and
    mode flips take effect from that moment (non-`full` ticks fast-forward the
    offsets without reading). Unlike thinking/tool-results (bot resolves the
    mode at render time), the sub-agent mode is read BY the adapters via an
    injected reader (`registerSubagentModeReader` in `createAdapter.ts`) —
    the branch decides what is PRODUCED. Pure decision/format helpers:
    `utils/displayVerbosity.ts`, `utils/thinkingRender.ts`,
    `utils/toolResultRender.ts`, `utils/subagentRender.ts`,
    `utils/subagentStatusRender.ts`, `utils/claudeSubagentTail.ts`.
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
per-backend, persisted agent setting. **Also add the new command's name (and
any alias) to the `botCommands` set in `bot.ts`** — it is the `message('text')`
handler's guard that stops a bot-owned slash from ALSO being re-forwarded to the
agent as a prompt; omit it and e.g. `/esc` reaches the agent verbatim. (A
retired command is kept in the set on purpose so a stray `/where` is swallowed
rather than typed into the agent.)

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
  - **Diagnosing "a message never reached the user"** (dropped agent output,
    missing question / option buttons) — `output-trace.jsonl` is the SOURCE OF
    TRUTH, not the bot's stdout (which goes to the operator's terminal, not a
    file). Method: `/trace on` in the topic → reproduce → follow the chain per
    message and localize the loss:
    `recv` (update arrived) → `emit` (adapter produced output/question) →
    `sendTry` → `sendOk` / `sendErr`.
      - no `emit` → lost in the adapter (SSE event not routed/handled);
      - `emit` but no `sendTry`/`sendOk` → lost in the bot's send path;
      - `sendErr` (429 `retryAfterSec`) → rate-limited / dropped under load
        (the prime suspect for *intermittent* loss — event-loop saturation);
      - `sendOk` but absent in `get_history` → spilled into / edited onto
        another message.
    Then diff the trace (what the bot DID) against `get_history` (what the user
    SEES). This beats reasoning from code or a homemade SSE listener — a stale
    code comment can lie (e.g. `question.asked` was once documented as carrying
    no `sessionID`; the live event now does), the trace cannot.

- **`OpenCode error: Invalid authentication credentials` → restart the OpenCode
  server** (the `opencode serve` process on port 4096) — its provider credentials
  went stale; new sessions keep failing until the server restarts. (User
  instruction, 2026-06-04.)

- **Verify a per-prompt OpenCode override actually applied** (model or `/effort`
  variant): `GET http://127.0.0.1:4096/session/<sessionId>/message` — the stored
  user + assistant turns echo `model.variant`, proving `body.variant` rode the
  prompt (stronger proof than "no HTTP 400"). Claude side: the tmux pane +
  `[Claude] sendInput: "/effort <level>"` in the log.
