# TelegramCode — project guide

> Shared rules live in `~/src/.claude/rules/` (loaded automatically). This file is
> the **project map**: read it first to understand what the code does before
> changing it.

> **Terminology:** when the user says "чат"/"chat" they mean a **topic** (forum
> thread), NOT the whole supergroup. Read every such request as per-topic.

> **Naming:** the product in prose is **TelegramCode**; the npm package and the
> CLI command are lowercase **`telegramcode`** (legacy `telegramCode` bin alias
> kept; `DATA_DIR` default `~/.telegramCode` deliberately unrenamed).

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
  `model: {providerID, modelID}` override) and consumes ONE multiplexed
  `/global/event` stream for the WHOLE server. Every event is wrapped in
  `payload` and tagged with a top-level `directory` field; the bot JSON-parses
  each event exactly once and routes it by envelope `directory` + `sessionID`
  to the owning session (plan
  `agent/tasks/actual/2026-06-17-opencode-global-event-stream.md`). The single
  stream opens with the FIRST active session anywhere and closes with the LAST.
  Healthy busy turns keep new `prompt_async` messages queued. A provider-managed
  `session.status=retry` is the exception: it stays visibly busy and posts one
  retry notice; the next user prompt aborts the old provider wait before posting
  with the current `/model`, otherwise a model switch + `continue` sits unread
  behind the old provider's retry deadline.
  (Why not `/event?directory=<workDir>` — the old per-folder model: on opencode
  1.14.41 that endpoint goes silent for an aged sole subscriber, keeping only
  `server.heartbeat` flowing so the stall watchdog never trips → the topic
  hangs. `/global/event` delivers reliably regardless of connection age.)
  Scheduler-MCP is registered per directory on session start (Set-gated, cleared
  on server restart), decoupled from the stream. **Owner resolution is robust
  (plan `agent/tasks/actual/2026-06-08-fix-lost-final-message-and-silent-question-drops.md`,
  S1+S2):** an event routes by `sessionID` (direct id, else child→parent lineage
  ancestor — sub-agents run in CHILD sessions), and when both miss it falls back
  to the envelope's DIRECTORY (the sole active session there, or — when two
  topics share a folder — only the one that is a genuine lineage ancestor, else
  a LOUD drop, never a guess). Events for directories the bot does not own (the
  user's by-hand opencode in other folders, now visible on the global stream)
  drop cheaply at owner resolution — never emitted to a topic. Lineage is
  recorded from ANY event exposing `parentID` (not just `session.updated`) and
  refreshed-on-use so an actively-routing child is never evicted from the
  bounded map. `question.asked`/`permission.asked` are CRITICAL: a genuinely
  unroutable one is logged, never silently swallowed (the old silent drop = the
  user's "question vanished, looked hung" bug).

When adding a feature, first decide: *is this a bot-local concern, or something
that must be proxied to the agent?* If it changes agent behavior (model,
effort, prompt, interrupt), it almost always has **two implementations** — a
keystroke sequence for Claude (tmux/pty) and an HTTP call for OpenCode — and
the two backends often expose the capability very differently (e.g. Claude has
a real `/effort` slash command; OpenCode encodes reasoning effort in model
config/variants, not a per-message API field).

## Key concepts

- **The operator runs ALL forum topics muted.** Design any "the user must
  notice this" signal accordingly: a plain bot message is silently muted.
  Pinning a message DOES pierce a muted topic — it fires a Telegram
  notification (vibration, no sound). This is why a pending agent question is
  pinned (see the question-pin behavior below).
- **A pending interactive question is PINNED so the muted topic notifies.**
  When the agent asks an interactive question the bot pins that message →
  Telegram fires a notification even though the topic is muted; the pin is
  removed when the question resolves (answer / cancel / session teardown /
  leaving the folder). **Exactly one notification per question:** the first pin
  notifies, any re-pin from the existing repost-to-bottom or the Q1→Q2 advance
  is silent (`disable_notification: true`). Both backends, via the shared
  `pinThreadQuestion` / `unpinThreadQuestion` helpers + the in-memory
  `questionPinnedMessageId` map (`unpinChatMessage` is per-message-id, so the
  pinned STATUS banner is never disturbed). **OpenCode** pins its discrete
  question message (`postPendingQuestionAt`), unpins via the single resolve
  choke point `clearPendingQuestion`. **Claude** has no discrete message — the
  scraped selector emit is tagged `isQuestion` (`OutputEventMeta`) so the bot
  sends it as its OWN standalone pinnable message; a `questionGone` adapter
  event (fired when `extractClaudeQuestion` goes pending→none) drives the unpin.
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
  `cd <projects-parent> && telegramcode`; when `WORK_ROOT` is unset, the
  wrapper uses `$PWD`. `telegramcode hot` propagates that launch directory to
  its compiled worker too, so `/bind` sees the same root in both modes. Treat
  `WORK_ROOT` as an advanced override for services or containers where the
  process cwd cannot be controlled.
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
  **json-stream Claude sessions survive restarts too** (plan
  `agent/tasks/completed/2026-07-05-jsonstream-restart-isolation.md`): the
  process is EXTERNAL (tmux `cjson-…`, stdin on a FIFO it holds `0<>`, stdout
  appended to `DATA_DIR/jsonstream/<chatId>_<threadId>/stdout.jsonl`), so a bot
  restart neither EOFs its stdin nor loses output — the restarted bot ADOPTS
  the session, resumes the stdout tail from the persisted line-boundary offset
  (`agents[key].jsonStreamTail`) and replays the downtime gap through the
  normal pipeline: **the in-flight turn is delivered end-to-end** (no recap
  posted — the replay is the delivery; a recap fires only on the dead-process
  `--resume` fallback). A pending AskUserQuestion survives via the host dir's
  `question.json` sidecar. Consequently `tmux` is a REQUIRED dependency for
  BOTH Claude backends (as it already was for scrape/terminal).
  If the `opencode serve` process crashes, the bot auto-restarts the server
  and **restores** each active session by re-resuming its persisted id
  (sessions persist on opencode disk; the in-flight reply is lost).
  `ensureOpenCodeServer` also reconciles VERSION, not just liveness: if a server
  is already up but running an OUTDATED binary (its `/global/health` version ≠
  on-disk `opencode --version` — a stale long-lived process after opencode was
  updated, whose old code dies on the migrated shared `opencode.db`, e.g. `no
  such column: …`), it is killed (own child, else by PID on the port) and
  respawned on the current binary instead of being adopted. Only a CONFIRMED
  mismatch restarts (`checkIsOpenCodeServerStale`); an unknown version adopts as
  before. Explicit
  `/quit`, `/quit-all`, and leaving a folder (the `/bind` «leave
  current dir» button) instead **release** the persisted session ids — so a
  later bot restart does NOT auto-reattach those sessions (they stay reachable
  only via the `/sessions` picker).
- **Startup-safe input.** A session has an async boot window (Claude tmux/pty,
  OpenCode server + `POST /session`). Prompts typed during it are buffered
  (`startupPromptBuffer.ts`) and replayed in order when ready — never dropped.
- **Boot readiness status.** At startup the bot tells the owner whether it can
  work, or lists the setup steps still missing (create+pair a forum group, grant
  the bot Manage Topics / Pin / Delete, bind a topic, install an agent CLI; plus
  optional groq/owner hints). **Delivery depends on readiness
  (`resolveStartupTargets`):** the "✅ Ready" status is owner-DM-ONLY
  (`OWNER_USER_ID`) — it is noise in the shared group, so it NEVER falls back to
  General (and a ready-status owner-DM 403 does NOT fall back either); no owner DM
  ⇒ nothing is sent (log only). The General fallback is reserved for the
  ACTIONABLE not-ready checklist, which tries the owner DM first then General on a
  403 / unset owner, else console-only. Cold start always sends; a hot reload
  stays silent when fully ready. Decision logic
  is pure (`utils/startupReadiness.ts`); `bot.ts` gathers live facts + sends it
  just BEFORE `bot.launch()` (Telegraf v4's long-poll `launch()` never resolves
  until the bot stops, so post-launch code would only run on shutdown).
- **Agent start UX — one-tap start + ONE typing loader.** The post-bind welcome
  buttons (▶️ Claude / ▶️ OpenCode) START the chosen agent in one tap (the
  `agent_<name>` callback funnels through `handleAgentStart`, the shared core
  also behind `/claude` `/opencode` `/terminal`), not a select-then-type step.
  The sole "agent is working" cue is the native typing indicator (`startTypingLoader`
  re-fires `sendChatAction('typing')` every `typingLoaderRefreshMs`; it REPLACED
  the old `⏳` placeholder message). It runs at every wait point — a self-greeting
  agent's boot AND every prompt forward. It is a PERSISTENT working state (S3):
  each tick keeps firing while `checkShouldKeepTyping` holds — output mid-flight
  (`checkIsOutputStreaming`) OR the adapter is busy (`checkIsBusy`) — and
  SELF-STOPS only when the topic is truly drained + idle (pure rule in
  `utils/typingActive.ts`). It is NOT cleared on the first output or a status
  frame any more (that made the topic look idle mid-answer); hard teardown paths
  (session end / question UI / unbind / start-fail) still call `stopTypingLoader`.
  There is NO timeout, so a long-thinking agent keeps showing it. An adapter that prints its own greeting
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
- **Send pacing & ordering — global 1/2s FCFS gate, 3s debounce, backlog glue**
  (plan `agent/tasks/actual/2026-07-04-send-limits-ordering-global-pacer.md`).
  With two topics streaming at once the bot used to overrun Telegram's per-chat
  budget → a sustained 429 storm. Now ONE process-wide `GlobalSendPacer`
  (`rateLimiter.ts`) releases at most one send every `globalSendIntervalMs`=2s
  across ALL chats (supergroup + owner DM), FCFS — CLOCK-BASED and non-blocking,
  so a slow/stuck send never head-of-line-blocks others (it replaced the per-chat
  priority `TokenBucket`; `enqueueSend` no longer takes a priority — pure FCFS
  temporal order, no class jumps the line). An aborted final waiter cannot leave
  a stale timer that grants a later send early. Cancellation rejects while a send
  is parked in the per-thread/pacer queues; once its operation starts, the caller
  awaits the operation and cleanup instead of racing them. Each topic coalesces its own stream
  at a 3s output debounce (`OUTPUT_DEBOUNCE_MS`, up from 1s; `isFinal` still
  flushes now). When a topic BACKS UP (≥3 messages queued) the flush GLUES the
  backlog into the fewest `\n\n`-joined messages (pure `utils/outputBacklogGlue.ts`,
  wired at `sendOutputImmediate` fresh-path + `sendAgentChunks`) so a burst drains
  in one send. The old bounded post-cooldown REDELIVERY + `send.degradedUnderLoad`
  notice are RETIRED — at 1/2s a 429 is essentially impossible, and the late
  re-send was the OUT-OF-ORDER cause the user reported; `withRateLimitRetry`'s
  single retry-after wait stays the floor, a rare double-429 just logs. The group
  transport's `finalizeInFlight` still drains the coalesced-but-unsent buffer to a
  permanent message on settle/teardown (`finalizeGroupOutput` + pure
  `utils/groupFinalizePlan.ts`, idempotent, per-key in `both`) so the final
  answer is never discarded. While in a 429 cooldown the output debounce
  (`utils/outputFlushTiming.ts`) still scales to the LIVE remaining cooldown
  (`max(normal, 5s floor, remainingCooldownMs)`) as a harmless safety net.
  **Two deliberate UNPACED exceptions** ride `sendUnpaced` (`rateLimiter.ts`:
  429-retry + rate-summary kept, but NO pacer permit and NO per-thread FIFO):
  the typing indicator (`sendChatAction` is not a message → not subject to the
  message flood limit, yet it was eating ~60% of the paced budget) and the
  voice-transcript 🎤 echo (`replyToThread` opt-in `unpaced` flag, sole caller —
  the user's own input ack must not queue behind agent output; was up to 182s
  late under load, now sub-second). Agent output NEVER goes unpaced — this is
  not a priority class inside the pacer, it is a small closed set of rare
  non-output sends moved out of it (plan
  `agent/tasks/completed/2026-07-05-unpace-typing-and-priority-acks.md`).
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
  a bare `telegramcode` stays backward-compatible with a group-only deploy and
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
- **MCP hierarchy (opt-in, mostly dormant — NOT a documented feature).** MCP
  servers merge across user / group / project / thread scopes with `${VAR}` env
  expansion, BUT the group (`${DATA_DIR}/mcp.json`) and thread
  (`${DATA_DIR}/threads/<key>.json`) layers are opt-in: `prepareMcpFlags`
  (`mcpConfig.ts`) emits a `--mcp-config` for them ONLY when the file exists, so
  a default install passes none. In practice the always-on consumer of the
  `--mcp-config` plumbing is the bot's OWN injected `telegramBot` server (next
  bullet) — the user-editable group/thread hierarchy exists in code but is
  unused by default, so the README deliberately does NOT document it (cut
  2026-07-12). User + project layers are claude-native (auto-loaded,
  bot-independent).
- **Agent scheduling tools (injected).** Separately from that user hierarchy,
  the bot injects its OWN `telegramBot` MCP server (HTTP, loopback `127.0.0.1`,
  per-session thread/dir-scoped HMAC tokens + a fresh client UUID) into EVERY bot-started session —
  Claude via a bot-generated `--mcp-config` file (thread-scoped), OpenCode via
  runtime `POST /mcp?directory=` (dir-scoped, re-registered after a server
  restart AND self-healed on every BOT boot: `reconcileSchedulerMcpForActiveSessions`
  reads the live `GET /mcp` per active dir and force re-registers any `telegramBot`
  that is missing or not `connected` — opencode does NOT auto-reconnect a remote
  MCP dropped during the bot-restart gap, which otherwise stranded every dir's
  tools; fire-and-forget so boot never blocks on opencode). The scheduler MCP
  listen port is OS-ephemeral by default but PERSISTED in `state.json`
  (`schedulerMcpPort`) and reused across restarts so injected URLs stay valid
  (env `SCHEDULER_MCP_PORT` pins it and wins). This server exposes the `schedule_*` tools plus `send_file_to_user`
  (agent→user file/image send into the topic, dir/thread-scoped exactly like the
  `schedule_*` tools — no new server/port/token/injection) and is bot-owned
  plumbing; it is NOT part of the user-editable `/mcp` hierarchy and never
  touches the user's group/thread config files. Builders live in
  `scheduler/injection.ts`, configured at boot by `wireScheduler` in `bot.ts`
  (if the MCP server fails to bind its port, the bot still boots — injection
  stays inert and only the agent-facing tools are unavailable that run). A
  single MP4 uses Bot API `sendVideo`; eligible all-video and mixed photo/video
  albums use `sendMediaGroup` with `InputMediaVideo` entries for MP4s.
  `as_file:true` is the explicit document override, and a silent MP4 needs no
  fake audio track. `utils/fileSendService.ts` owns the reusable path/snapshot/
  plan/request-dispatch pipeline: it captures each canonical file's bigint
  device/inode identity, pins one canonical root across every album item, and on
  Linux traverses from a pinned root descriptor with per-component `O_NOFOLLOW`.
  macOS fails this tool closed until a native descriptor-relative bridge exists.
  The service verifies the opened identity and owns the pinned
  file descriptor through gateway completion. `bot.ts` injects the real target
  resolver, one `executeDelivery` seam backed by `enqueueSend`, and five direct
  gateway methods. The delivery callback keeps gateway dispatch AND atomic,
  durable message-id recording inside one per-thread queue transaction; the
  complete Telegram response-ID batch reaches `state.json` before success. Every retry callback
  creates a fresh `autoClose:false` positional stream bounded to the validated
  snapshot size; a zero-byte snapshot uses a fresh in-memory empty `Readable`.
  Each attempt registers stream completion before sending, destroys unread
  streams on an early rejection, and waits for every stream to become terminal
  before `withRateLimitRetry` can start the next attempt. Telegram API errors
  remain retryable; a non-API failure after invocation becomes a typed
  delivery-unknown result that says Telegram may already have accepted the send
  and MUST NOT be retried automatically; the MCP result is non-error structured
  content `{ kind: 'deliveryUnknown', retryable: false }`. Once the gateway returns, delivery is
  final: a later message-id recording or descriptor-cleanup
  failure stays `ok:true` with a warning so the agent cannot duplicate the
  already-delivered message/album by retrying. Request cancellation removes
  parked snapshot/pacer/FIFO/retry waiters. While any request-body stream remains
  unconsumed it destroys the streams and aborts the active Telegraf `callApi`,
  surfacing `AbortError` only after terminal cleanup. Once every stream has ended,
  caller cancellation is not forwarded because Telegram may already have accepted
  the upload; instead an unref'ed 30-second response deadline starts. Expiry aborts
  Telegraf, awaits sender cleanup, and returns delivery-unknown without retrying;
  returned message IDs still win at the deadline boundary and are durably recorded.
  A directory-scoped request carries its
  canonical authorised directory into the service, which re-resolves the topic
  after snapshot admission before opening files and again inside `executeDelivery`
  immediately before dispatch, refusing a binding that changed in either queue.
- **Scheduled prompts (`src/scheduler/`).** A topic can have scheduled prompts:
  at fire time the bot posts the prompt into the topic, PINS the announcement
  (pins accumulate as run history — the bot never auto-unpins; per-job
  `isPinSilent` makes the pin not notify members, default notifies), then
  delivers the prompt to the topic's agent — reusing an active session
  (waiting for idle up to 10 min rather than interrupting live work) or
  starting one with the thread's last-used adapter. Created via `/schedule`
  (prompt wrapper) or by the agent itself (`schedule_create/list/cancel` MCP
  tools; cron / one-shot / N-times, min interval 5 min, ≤30 jobs per thread).
  **`schedule_create` is agent-robust** (`buildSpecFromCreateArgs`): a one-shot
  (`onceAt`) IGNORES a redundant `repeatCount` instead of erroring (a one-shot
  always runs once — the agent naturally sends `repeatCount:1` to mean "run
  once"; rejecting it made the model spiral into absurd counts / a wrong-year
  cron), empty/whitespace `cron`/`onceAt` normalise to absent, and a structural
  error (both/neither field) echoes the exact 3-mode recipe so a bad call teaches
  the corrected next call. ALWAYS use `onceAt` for a single future run, never a
  cron — cron has no year and would re-fire every year.
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
  Detection is at the **adapter boundary** via the `apiError` event: OpenCode
  classifies in `handleSessionError` (`session.error`, structural); Claude runs
  the scraped pane through `getClaudeAgentErrorLine` — a line STARTING with
  `API Error:`, OR a `⎿` result row that contains `API Error:`, OR a `⎿` result
  row whose content LEADS with a logged-out phrase (`not logged in` / `please run
  /login` / `invalid authentication credentials`) — then `classifyAgentApiError`,
  behind a one-shot guard. **Two false-positive guards (both live 2026-07-03,
  topic 201):** (1) detection scans the NEW pane delta only, never the full pane
  — a stale `⎿ … /login` row lingers in the scrollback long after re-login, and
  the guard re-arms on redraws, so a full-pane scan re-fired every poll and
  oscillated against the recovery-clear, re-pinning "logged out" AFTER a
  successful login; the line-SET diff puts the row in the delta only on its FIRST
  render → one fire per logout episode. (2) the auth phrase must LEAD the `⎿` row
  (Claude's `⎿ Not logged in · …` format), because TOOL results (Bash/Read/Grep)
  are ALSO rendered under `⎿` — a result row that merely QUOTES the phrase deeper
  in the line (the agent grepping the bot's own logs, a `gh`/`npm` "not logged
  in") would otherwise fire; a real logged-out row leads with it, a quote embeds
  it after other text. Classes (markers verified against the `claude.exe`
  string table): *transient* (rate-limit / overloaded / 429·503·529) → retry
  +5/10/20 min, 3 tries; *usageLimit* (usage-limit reached / credit-balance too
  low) → +60 min re-armed each repeat up to 6× (or a parsed reset time, rare);
  *auth* (login / bad credentials) → **never retried, but SURFACED**: a deduped,
  PINNED logged-out notice (Claude → send `/login`; OpenCode → restart the
  server), one notification per episode, cleared on recovery (first real output
  after re-login) and at teardown — pre-fix a logged-out Claude emitted NOTHING
  and looked hung (live 2026-07-01, topic 201; plan
  `agent/tasks/completed/2026-07-01-surface-logged-out-agent-notice.md`). On a
  retryable fire the bot posts a notice and nudges the still-live session with a
  neutral "continue" via `forwardPromptToAgent` (NEVER a wait-for-idle path —
  OpenCode's optimistic `isBusy` is not cleared on `session.error` and would
  stall the 10-min cap). Any user message / `/new` / `/quit` / leaving a folder
  cancels a pending retry; pending retries survive a bot restart (`state.json`
  `apiRetries`, re-armed after reattach). **Live-verify caveat:** a Claude
  rate-limit / 401 isn't inducible on demand, so the `getClaudeAgentErrorLine`
  cases are covered by unit tests against REAL scraped samples, not a live repro.
  If a Claude API error did NOT trigger, grep the bot log for `[Claude] API
  error detected`: absent ⇒ the detector missed the line and needs another case.

## Module map (`src/`)

| File | Responsibility |
|------|----------------|
| `cli.ts`, `cli/bot.ts`, `cli/botEntry.ts`, `cli/applyDnsFix.ts` | Public CLI dispatch, shared bot startup/DNS setup, and the internal hot worker entry. The old public `bot` subcommand is retired; nodemon runs `botEntry.ts` directly |
| `cli/envLoader.ts` | Load `.env` (config dir + per-project override) |
| `cli/lock.ts` | Single-instance lockfile |
| `bot.ts` | **The bot.** Telegram handlers, all slash commands, output streaming. Large — most logic lives here |
| `threadRouting.ts` | Resolve which project folder a forum topic is bound to |
| `accessControl.ts` | Who may use the bot: `extractAdminIds` + `AdminCache` (the served group's creator/admins, read live via `getChatAdministrators`, cached 1h; a `chat_member` admin-status change in the served group invalidates the cache immediately — `checkShouldInvalidateAdminCache`, subscribed via `allowed_updates` at launch). No allow-list env, no `/grant` |
| `state.ts` | Persistence (`state.json`): bindings, sessions, pairing; `resolveDataDir()` |
| `mcpConfig.ts` | Merge MCP server config across the user/group/project/thread hierarchy |
| `i18n.ts` | `t(key, vars)` translations for all user-facing strings. **12 locales** (`en`, `de`, `fr`, `es`, `pt`, `ru`, `zh`, `ja`, `hi`, `uz`, `ka`, `uk`); active locale comes from async Telegram/chat context (`/language` override → Telegram `language_code` → stored chat locale → `en`); `en` is canonical (missing key falls back to `en`); per-locale modules live in `src/i18n/`. Add a new key to `en.ts` first, then mirror it in every locale. Agent-facing templates (`schedule.*`, `apiRetry.continueNudge`) keep English instructions but bake a per-locale "IN <language>" reply directive |
| `validation.ts` | Input validation for existing-folder `/bind` args (`validateSubdir`, path-traversal/symlink-safe); `resolveBoundWorkDir` turns a persisted binding into the CANONICAL (`realpathSync`) workDir every agent, `/status` row, and `dir:` scope compares against |
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
| `utils/claudeAuthLogin.ts` | Pure helpers behind the json-stream `/login` out-of-band flow: `parseClaudeAuthLoginUrl` (clean OAuth URL out of the ANSI/OSC-8 pty output — stops at the BEL), `checkIsClaudeAuthLoginCodePrompt` (the "paste code" gate; shares `claudeLoginPastePromptRe` with the tmux login-paste detection), `parseAuthStatusLoggedIn` + `checkIsAuthLoginSucceeded` (status-authoritative, exit-code fallback), `getLoginCommandRoute` (`outOfBand` only for a json-stream RAW pick, else `forwardToAgent`). The impure pty driver + per-thread state live in `bot.ts` (`startClaudeAuthLogin` / `submitClaudeAuthLoginCode` / `cancelClaudeAuthLogin`) |
| `openCodeSessionRouting.ts` | Pure helpers: match an SSE event to its owning session via child→parent lineage (`checkIsEventForSession`), record lineage (`updateSessionLineage`), verify strict descent (`getLineageDepthToAncestor` — busy tracking records a busy CHILD only for a verified descendant, so a dir-fallback-routed foreign sibling's busy=true never pins the thread busy) |
| `utils/sseStreamLifecycle.ts` | Pure decision logic for the OpenCode adapter's single `/global/event` stream: open/close edge detection (`getSseStreamTransition`, driven by the TOTAL active-session count — open on first session anywhere, close on last). The per-directory helpers (`countActiveSessionsForDirectory`, `getWantedStreamDirectories`) now serve scheduler-MCP per-directory tracking, not the stream |
| `utils/openCodeTurnActivity.ts` | Pure decisions for "the prompt was delivered but no turn ran". `checkIsWedgedTurn` — a delivered prompt (`awaitingResponse`) that idled with no assistant activity (`sawActivity`, set ONLY by an assistant `message.updated` — never the echoed user-prompt parts), NOT during a compaction and NOT with a pending provider retry, means OpenCode accepted the prompt but never ran a turn → the bot auto-recovers. `checkIsReplacementTurnMissing` — the same verdict for the OTHER angle, a post-provider-retry replacement prompt whose own `busy` never arrived within its bound (see the `openCodeAdapter.ts` row); both funnel through ONE `noResponse` emit point so a single prompt can never run the escalation twice |
| `utils/wedgeRecovery.ts` | Pure 3-tier escalation for recovering a wedged OpenCode session, one attempt each per prompt episode so the last dialog is preserved when possible and a persistent wedge can't loop: `decideWedgeRecovery({tier,hasReplayPrompt,canFork})` → tier 0 `resend` (same session, transient stall) → tier 1 `fork` (fork into a fresh session carrying the FULL conversation, else `restart` if the adapter can't fork) → tier 2 `restart` (blank fresh session, dialog dropped) → `giveUp`. The bot's `handleNoResponse` runs each tier (replay rides `isRecoveryReplay`, keeping the tier), surfacing `agent.no_response` at give-up; `forkSession` is the OpenCode adapter's `POST /session/:id/fork` |
| `utils/displayVerbosity.ts` | THE shared display-verbosity vocabulary for `/thinking` / `/tool_results` / `/subagent`: option order (`displayVerbosityModeOptions`: minimal, short, full), the locked default (`defaultDisplayVerbosityMode` = `minimal`), the type guard (`checkIsDisplayVerbosityMode`), and the legacy-name normalization (`normalizeDisplayVerbosityMode`: `detailed`→`full`, `brief`→`short`, `hide`→`minimal`, `compact`→`short`; unknown→null) used both for old persisted values and old command/callback aliases |
| `utils/verbosityRender.ts` | Pure decision helper for the `/verbosity` umbrella picker: `getUniformVerbosityLevel` returns the level all three display prefs share (✓ marker target) or `null` when mixed → rendered as "custom" with the three values spelled out. The macro's write path just reuses the per-command apply helpers in `bot.ts` |
| `utils/thinkingRender.ts` | Pure decision/format helpers behind `/thinking`: the OpenCode mode×phase action matrix (`getThinkingEventAction`), the answer-start removal rule, the ms→seconds formatter (`formatThinkingDurationSeconds`), and — for the Claude scrape path (no ms timestamps) — `parseThinkingDurationSeconds` (scrapes the duration out of the "Thinking for…" header / "✻ … for Ns" trailer) |
| `utils/toolResultRender.ts` | Pure helpers for tool-result rendering behind `/tool_results`: mode→render action (`getToolResultRenderAction`), and the `short`-mode dual-cap truncation (`getTruncatedToolResult`, 15 lines / 1200 chars, line-boundary-preserving) |
| `utils/subagentRender.ts` | Sub-agent rendering helpers behind `/subagent`: the mode×part-kind matrix the adapter consults for child-session parts (`getSubagentPartAction`: text→status/stream, tool→ignore/status, reasoning→always ignore; `minimal` ≡ `short` here, v1), the status-only rolling status line (`buildSubagentStatusText`), the parent-side in-flight delegation status (`buildDelegatingStatusText`) and the full-mode chunk marker (`buildSubagentOutputPrefix`) |
| `utils/subagentStatusRender.ts` | Pure helpers behind the DEDICATED OpenCode sub-agent status message (non-`full`): `getSubagentStatusAction` (open/refresh/close/noop lifecycle from "message exists?" × "event active?"), `formatElapsed` (`m:ss`), `buildSubagentElapsedText` ("🤖 sub-agent: <title> · m:ss"), and `checkShouldEnqueueSubagentStatus` (S1' COALESCING gate). The bot's `handleSubagentStatus` owns the message id + the 10 s elapsed tick timer; replaces the flood-prone shared-status line. **Coalescing (live 2026-08-07, topic 61130):** OpenCode streams frequent `message.part.updated` for a live parent `task` part → a high-frequency run of `subagentStatus{active:true}` refreshes. The bot dedups against the last text it DECIDED to enqueue (recorded synchronously) AND never enqueues while one edit is in flight (`subagentEditInFlight`); the old dedup compared against the last DELIVERED text (updated only after the pacer-delayed send resolved), so a burst stacked hundreds of identical `editMessageText` closures into the per-thread FIFO, drained one every 2 s, and head-of-line-blocked the agent's OWN answer behind them — the topic looked hung |
| `utils/claudeScrapeShapes.ts` | THE single source of truth for Claude TUI line-shape regexes (one definition per shape): tool headers (`ANY_TOOL_HEADER_RE` superset of `OUTPUT_TOOL_HEADER_RE`+`FILE_TOOL_HEADER_RE` — incl. `Update`, Claude's render of Edit), `⎿` result marker, thinking header/trailer, collapse markers (`COLLAPSE_MARKER_RE` "+N tool uses/lines"; `COLLAPSE_TOOLUSE_MARKER_RE` "+N tool uses" only, for the orphan-panel-chatter drop), spinner ticks, chrome. **Assistant-output bullet:** detection accepts BOTH `●` (U+25CF) and `⏺` (U+23FA) — Claude Code v2.1.177 renders the output bullet as `⏺`; the older `●`-only regexes silently missed it (live 2026-06-15: a wide table's `⏺ ┌…` top border was never detected → the whole table was lost). When adding a regex that anchors on the bullet, match both glyphs (NOT the spinner-tick classes — `⏺` is a static bullet, not an animation frame) |
| `utils/claudeChunkClassifier.ts` | Pure classifier for the Claude relay (S3): segments a scraped pane chunk into tagged runs (`classifyClaudeChunk` → thinking / tool-header / tool-body / sub-agent-panel-preview / prose / chrome), threading fence/block context across polls. Conservative default-to-prose so the answer is never swallowed; an orphan "+N tool uses" wall → chrome |
| `utils/claudeRelayRouting.ts` | Pure per-pref router for the classifier's segments (S4–S6): `routeClaudeChunkSegments` keeps prose always, applies `/tool_results` + `/thinking` per segment (full keep / short truncate-or-collapse / minimal fold), always folds sub-agent panel previews to status, and returns `keptText` (permanent) + the one rolling `activityLine`; `checkIsClaudeRelayFastPath` is the all-`full` byte-identical regression anchor |
| `utils/claudeSubagentTail.ts` | Pure decision logic for Claude's `/subagent full` transcript tailing: per-file tail state (byte offset + partial-line carry), the scan planner (`getSubagentTailReads`: first scan seeds offsets to EOF with no reads = no backlog replay; non-`full` modes fast-forward without reading; full returns `[offset..size)` ranges), the transcript filename filter (`checkIsSubagentTranscriptName`), and the extractor (`extractAppendedSubagentTexts`: assistant `text` blocks only — thinking/tool_use/user/attachment dropped, malformed JSONL lines skipped). The adapter's poll tick does the fs work |
| `utils/canonicalPathContainment.ts` | Shared security boundary for binding and file-send path resolution: canonicalizes a candidate beneath an already-canonical/pinned root and performs separator-safe containment, while each caller retains its own input validation, root error mapping, and file-vs-directory gate |
| `utils/fileSendPlan.ts` | Pure decision/request layer for the agent→Telegram `send_file_to_user`: path-safety (`resolveSendFileWithinDir` — shared canonical containment + bigint device/inode identity + regular-file gate inside the bound folder), canonical multipart-basename control/quoted-string-metacharacter sanitization (`getTelegramUploadFilename`), extension→render-kind (`classifyFileSendKind`: photo/animation/video/document), the single/album plan (`planFileSend`: `as_file` + >10MB-photo→document downgrade, eligible photos/videos→albumPhotoVideo else albumDocument, size/count → error variant), and `buildTelegramFileSendRequest` (exact `sendPhoto`/`sendAnimation`/`sendVideo`/`sendDocument` or discriminated `sendMediaGroup` request carrying project-owned descriptor snapshots, first-item-only album caption) + `trimCaption` (1024 cap) |
| `utils/abortableFifo.ts` | Shared abortable FIFO waiter queue used by both the global send pacer and file-snapshot admission: size, wait, resolve-next, and resolve-all; an aborted waiter removes only itself and never consumes the next live permit |
| `utils/fileSendService.ts` | Reusable impure orchestration for `send_file_to_user`: `createSendFilesToThread(deps)` resolves target+workdir, pins one canonical root for the whole operation, and on Linux traverses each canonical path from a root descriptor with per-component `O_NOFOLLOW`; macOS fails closed until a native descriptor-relative bridge exists. It verifies the opened regular file's bigint device/inode identity and ≤50 MB size, then retains every file descriptor while classifying/planning/building and exhaustively invoking an injected typed `sendPhoto`/`sendAnimation`/`sendVideo`/`sendDocument`/`sendMediaGroup` gateway. Snapshot admission is bounded/FIFO and abortable; a directory-scoped call requires the same canonical authorised workdir both before opening and inside `executeDelivery` immediately before dispatch. Optional `executeDelivery` wraps gateway dispatch plus durable message-id recording in one queue/retry transaction; the default invokes directly. It closes every collected descriptor in `finally` after gateway success/failure. A gateway return is the delivery boundary: later recording/cleanup failures append warnings to an `ok:true` result to prevent duplicate retries, while `FileSendDeliveryUnknownError` becomes a distinct no-auto-retry result. `SchedulerMcpDeps` imports its `SendFilesToThread` type directly; real-HTTP tests compose a recording gateway |
| `utils/fileSendTelegram.ts` | Telegraf adapter for project-owned file-send descriptors: each gateway invocation creates a fresh bounded input — non-empty snapshots use `fs.createReadStream('', { fd, start: 0, end: sizeBytes - 1, autoClose: false })`, while zero-byte snapshots use an in-memory empty `Readable` — converts discriminated document vs photo/video groups into correctly homogeneous Bot API media arrays, and extracts every returned message id for `/clear` tracking. It registers `finished()` before invoking each attempt; cancellation aborts Telegraf and destroys streams only while any request body remains unconsumed. After every stream ends normally, caller cancellation stays suppressed and an unref'ed 30-second response deadline starts; expiry aborts Telegraf, awaits sender cleanup, and becomes `FileSendDeliveryUnknownError`, while message IDs returned at the boundary still win. Telegram API errors propagate to the outer retry executor; other non-API post-initiation failures also become delivery-unknown. `bot.ts` passes an abort-controller shim signal to Telegraf `callApi`; descriptor closure remains the service's responsibility |
| `scheduler/recurrence.ts` | Pure schedule math on `croner`: `ScheduleSpec` (cron / once / N-times), validation (min fire interval 5 min), next-occurrence, human description, catch-up decision |
| `scheduler/store.ts` | Schedule records: create path (slug ids, ≤30/thread cap, `isPinSilent`), persisted in `state.json` `schedules` (lifecycle-independent) |
| `scheduler/engine.ts` | Timer engine: one unref'd timer per job, boot replay with one-catch-up-per-missed-run, no-overlap guard, N-times/once bookkeeping, `whenIdle` drain |
| `scheduler/delivery.ts` | Fire pipeline: announce → pin (notify by default) → wait-for-idle (5s polls, 10 min cap) → forward with the `[Scheduled run]` marker; unbound topic → distinct error |
| `scheduler/mcpSurface.ts` | Bot-owned MCP server (stateless streamable HTTP on an OS-chosen loopback port unless `SCHEDULER_MCP_PORT` pins one): `schedule_create/list/cancel` + `send_file_to_user` (agent→Telegram file/image, separate `registerFileSendTool`; an ambiguous post-invocation outcome is non-error structured content `{ kind: 'deliveryUnknown', retryable: false }`), HMAC bearer tokens scoped `thread:`/`dir:`. Because MCP cancellation is a separate HTTP notification while each transport is fresh, the HTTP server correlates by verified token + validated bounded client id + typed request id (verified-token fallback for legacy registrations), retains a bounded 30-second cancellation-before-registration tombstone set, and combines that controller with the SDK handler signal. Reports a short connect-time `instructions` (`mcpServerInstructions`, returned in the MCP `initialize` handshake) — a use-case pointer (when to reach for the server, what it can do); per-tool argument recipes stay in each tool's own `description`. NOTE: connect-time `instructions` + tool descriptions are cached by the client at connect — an already-running agent won't see edits until it reconnects; only tool RESULTS reflect live server code |
| `scheduler/injection.ts` | Builders for injecting the bot's MCP entry into sessions: Claude `--mcp-config` object, OpenCode `POST /mcp` registration, each with a fresh UUID client header for cancellation isolation; inert until configured |
| `scheduler/runLedger.ts` | Append-only JSONL run history (`DATA_DIR/scheduler-runs.jsonl`, 10MB→.1 rotation) |
| `scheduler/directoryThreads.ts` | Inversion: directory → thread keys bound to it (the MCP `dir:` scope resolution). Matches each binding's CANONICAL workDir via `resolveBoundWorkDir`, so it touches the filesystem (`realpathSync`) and can throw — NOT a pure helper |
| `scheduler/rebindResume.ts` | Pure rebind decision: resume a paused job from now, or drop an expired one-shot |
| `diagLog.ts` | Bounded rotating diagnostic log (`appendDiagLog`) under `DATA_DIR/agent-diag.log` — SSE/session lifecycle milestones only, never the per-delta firehose |
| `outputTrace.ts` | Output-trace mode, toggled at runtime via `/trace` (no env var): JSONL record of incoming updates (`recv`), adapter emits (`emit`), and every outgoing Bot API call with outcome (`sendTry`/`sendOk`/`sendErr`, incl. 429 details) under hourly bucket files `DATA_DIR/output-trace-*.jsonl` — lets live verification diff what the bot did vs what reached Telegram. The toggle (`tracedThreads` set + `traceAllThreads` flag) is persisted in `state.json` and re-seeded at boot; an async-buffered, single-flight writer flushes on a 500ms timer / 200-entry threshold (sync flush on process exit). **ON by default for ALL threads** (always-on observability — see below); `/trace off all` turns it off DURABLY (persisted `false`). Buckets pruned at 6h by the bot janitor (`pruneTraceBuckets`). Filtering: `recv`/`emit`/send-with-thread-id record iff the thread is traced (all-flag or in the set); send records with NO derivable thread id (e.g. `editMessageText`) record whenever ANY tracing is active |
| `utils/recvPreviewRedaction.ts` | Pure security decision for the recv-trace preview (`getRecvTracePreview`): while a thread is in the pending `/connect` state (same `pendingProviderConnects` state the text handler consumes), the next non-command text IS a pasted provider API key → the preview is redacted at record time; an inline `/connect <key>` records only a fixed command marker. Also owns the shared `checkIsConnectCommandText` |
| `utils/rotatingLogFile.ts` | Shared hourly time-bucket helper for the observability logs: `getHourBucketPath(dir,base,ext,nowMs)` (`<base>-YYYYMMDDHH.<ext>`, host-local hour) + `pruneExpiredBuckets(...)` (best-effort unlink of buckets + their `.1` siblings older than `retentionHours = 6`; never throws). Used by BOTH the trace writer and the console tee |
| `utils/consoleFileTap.ts` | TEE of `process.stdout`/`process.stderr` to `DATA_DIR/bot-console-*.log` (hourly bucket): `installConsoleFileTap(dir)` wraps `write` so each chunk ALSO `fs.appendFileSync`s to the bucket (best-effort, swallows IO errors, NO `console.*` inside → no recursion), original write + return value untouched (terminal preserved). Installed as early as possible at the bot entry (`cli/bot.ts`, after env load). Buckets pruned at 6h by the janitor |
| `installManager.ts` | Install / locate agent binaries and manage OpenCode server generations. In hot workers, `startExternallyParentedProcess` launches replacements through a one-shot host so crash recovery / auth reload servers leave nodemon's descendant tree before startup returns; an endpoint + PID/start-token + signal-scope file under `DATA_DIR` transfers safe ownership across worker generations |
| `utils/startupReadiness.ts` | Pure decision layer for the boot-time readiness status (plan `agent/tasks/actual/2026-07-12-startup-readiness-status.md`): `buildReadinessReport(facts)` → `{isReady, unmetKeys, missingRights}` (required items = paired group + all bot admin rights + a binding + an installed agent CLI; optional groq/owner never block ready), `checkShouldSendStartupStatus` (cold always, hot only-if-missing), `resolveStartupTargets(isReady, hasOwner, hasGeneral)` → ordered `('owner'\|'general')[]` (ready ⇒ owner-DM-only, NEVER General; not-ready ⇒ owner then General), `buildStartupStatusText` (ready line vs numbered checklist, via an injected translate). `bot.ts` gathers the live facts + sends |
| `utils/resolveBinary.ts` | Resolve `claude` / `opencode` binary paths |
| `utils/pollBackoff.ts` | Pure adaptive poll cadence: `getNextPollDelay` (300ms while the pane changes → ×2 up to 1.5s after 10 unchanged polls; any write/change snaps back) |
| `utils/tmuxExec.ts` | Generic tmux/shell primitives shared by the claude + terminal backends (relocated from `claudeCliAdapter`): `tmuxAsync`/`tmuxOrThrowAsync` (best-effort vs strict tmux calls), `checkArgsAreSafe` (reject control chars), `shellSingleQuote`, `execFilePromise` |
| `utils/ansiClean.ts` | Pane-text cleaning shared by both tmux backends (relocated from `claudeCliAdapter`): `convertAnsiToMarkdown` (ANSI→Telegram markdown, OSC-8 strip, spinner-glyph de-bold), `cleanOutput` (full clean pipeline), private `joinBrokenUrls` |
| `utils/paneDiff.ts` | Pure line-SET diff between two tmux pane captures (relocated from `claudeCliAdapter`): `getNewPaneContent` + `NewPaneContent` (only NEW lines, `startsNewParagraph` out-of-band); imports `normalizeForComparison` from `utils/recentRelayWindow` so both backends share one normalization domain |
| `utils/paneResizeGuard.ts` | Pure decision logic for the Claude scrape pane-RESIZE guard (live 2026-07-02, topic 202: an interactive `tmux attach` resized the window → tmux re-wrapped the whole scrollback → the line-SET diff relayed ragged fragments of OLD conversation; the relay window's 16-char short-line exemption let short-line clusters through on EVERY width flap). The poll loop queries `#{pane_width}x#{pane_height}` AFTER each capture (same-poll order = race-free) and on a change swallows the repaint — baseline reseeds, nothing emits — until the capture settles (`getPaneResizeGuardDecision`, capped by `resizeSettleMaxPolls` so a busy pane is never wedged silent; `parsePaneSize` validates the query). To inspect a live pane use `capture-pane`, not `attach` — capture doesn't resize |
| `utils/tmuxSessionName.ts` | Pure parameterized tmux session-name codec shared by the tmux backends: `buildTmuxSessionName(prefix, key)` / `parseTmuxSessionName(prefix, name)` — careful negative-chatId + strict per-half regex so a foreign session sharing a prefix is never mis-adopted. Claude binds the `'claude'` prefix via thin wrappers; terminal the `'term'` prefix |
| `utils/terminalEmitPlan.ts` | Pure helpers behind `terminalAdapter`: `getTerminalEmitPlan(nextOutputFresh)` (fresh→new message, else continuation — one rolling message per command), `buildTerminalNewSessionArgs` (the `tmux new-session` argv: shell-command + `-c workDir` + size flags, no `--session-id`/permission/MCP), and the named constants (`terminalPaneCols` 200, `terminalPaneRows` 50, `terminalTmuxPrefix` `term`, `defaultShell`) |
| `utils/claudeStreamJson.ts` | Pure stream-json event core for `claudeJsonStreamAdapter`: newline-delimited JSON reader (partial-line buffering across chunks) + classifier mapping `system` / `stream_event` text_delta / `assistant` / `result` / `control_request` lines to adapter events |
| `utils/claudeRuntimeInfo.ts` | Bounded Claude transcript-tail reader for `/status`: parses the newest main-session model usage and version, derives documented context limits, and always closes its file descriptor |
| `utils/threadStatusReport.ts` | The per-topic `/status` render + model resolution, kept out of `bot.ts` so both are unit-testable (importing `bot.ts` runs its module-scope `parseEnv()`, which exits the process without a bot token): `getThreadStatusReport` (session-only rows are dropped once the session stopped; unknown runtime data degrades to the localised unknown marker) and `getThreadStatusModel` (live adapter value → the runtime's self-reported model → the persisted pick; the middle step is the Claude tmux backend's ONLY model source) |
| `utils/jsonStreamHost.ts` | Host layout + IO primitives for the json-stream EXTERNAL transport (tmux `cjson-…` prefix binding): per-thread dir under `DATA_DIR/jsonstream/`, the probe-proven `#!/bin/sh` wrapper builder (`0<>` FIFO hold, `env -u ANTHROPIC_API_KEY`, pid/exitcode capture), the `O_NONBLOCK` FIFO write-open guard (`ENXIO`→null, never a blocking open) + bounded `EAGAIN` write retry, byte-exact stdout tail state (stateful utf8 decode across split chars, line-boundary offset for restart persistence, truncation reseed), and the orphan-dir janitor sweep |
| `types.ts` | Shared types incl. the `AgentAdapter` contract and `ThreadKey` |

### Adapters (`src/adapters/`) — the proxy boundary

| File | Responsibility |
|------|----------------|
| `createAdapter.ts` | Factory: pick adapter by tool kind; wire adapter events → bot. Also the DI hub: `registerDisplayPrefsReader` (display prefs at PRODUCE time), `registerSeenWatermarkWriter` / `registerJsonStreamTailWriter` (persistence), `registerThreadLocaleReader` (adapter-side `t(...)` locale context) — same late-wiring idiom for all |
| `claudeCliAdapter.ts` | Claude Code via `tmux` (keystroke driving, adaptive capture-pane polling/scraping; the poll tick also tails the on-disk sub-agent transcripts for `/subagent full`). Owns the Claude-TUI scrape logic + table stabilizer; the GENERIC tmux/ANSI/diff primitives now live in `utils/tmuxExec`, `utils/ansiClean`, `utils/paneDiff`, `utils/tmuxSessionName` (shared with the terminal backend) and are re-exported here for back-compat. **Auto-dismisses Claude's end-of-turn feedback survey** (never relayed to the topic; one Escape per appearance, signature-deduped): the detector (`extractClaudeSurvey`) is two-factor — a whole-line-anchored header + the `N: Label` option row (≥2 options) — and accepts a CLOSED alternation of the two known header wordings (`How is Claude doing this session?` and `How well is Claude following the instructions you gave earlier in this conversation?`, optional leading `●`/`⏺` bullet + trailing `(optional)`); keep it a closed list, never an open prose pattern (a quoted header once spammed bogus surveys). Wedge symptom of an UNRECOGNISED wording: the survey sits on the pane and swallows the Enter of the next forwarded prompt — the text strands unsubmitted in the TUI input box and the topic looks hung (live 2026-07-02, topic 202); the fix is adding the new wording to the alternation |
| `claudeJsonStreamAdapter.ts` | 2nd Claude backend — drives `claude -p --input-format stream-json --output-format stream-json` (structured events, NO tmux scrape) as an EXTERNAL tmux-hosted process (`cjson-…`): a wrapper reroutes stdin to a FIFO claude holds `0<>` and stdout to an append-only `stdout.jsonl` the adapter tails, so bot restarts never kill the session — boot ADOPTS it and replays the downtime tail (host layout/primitives in `utils/jsonStreamHost.ts`; transport details in `src/adapters/README.md`). The **DEFAULT** Claude backend (`getDefaultClaudeBackendName` / `resolveClaudeBackendName`): `/login` is handled OUT-OF-BAND by the bot (`claude auth login --claudeai` in a pty — `getLoginCommandRoute` + `startClaudeAuthLogin`, see the `/login` command section), so it no longer needs a TUI to sign in. Switchable per-topic on the fly via `/claude_mode` (the pick persists as the thread's adapter name; the switch is a SEAMLESS resume — both backends share the on-disk transcript). Hidden from the generic `/start` agent list (`hiddenAdapterNames`) — reached via the default + `/claude_mode`, not a start entry. (The old `CLAUDE_JSON_STREAM_THREADS` env gate is RETIRED.) Subscription-billed (non-`--bare`, no `ANTHROPIC_API_KEY`; proof: `system/init` `apiKeySource:"none"` + a `seven_day` `rate_limit_event`). Interactive questions ride a REVERSE-ENGINEERED stdio control protocol (`--permission-prompt-tool stdio` + `initialize` handshake + `can_use_tool`/`control_response`) — full wire format in `src/adapters/README.md`. Sessions cross-resumable with the tmux backend (shared transcript readers) |
| `openCodeAdapter.ts` | OpenCode via HTTP + SSE (POST prompts; ONE multiplexed `/global/event` stream for the whole server, every event parsed once + routed by envelope `directory` + `sessionID`). **Wedged-turn detection + auto-recovery** (live-fixed 2026-08-16, the my-news digest schedule: «триггер срабатывает, а агент не запускается»): a bloated session accepted every prompt (`prompt_async` 204) but its agent loop exited at step 0 — `session.idle` arrived with ZERO assistant activity, and even a server-side `/summarize` hit the same dead loop, so the session is unrecoverable IN PLACE. A prompt arms `awaitingTurnResponse`; the first own-session idle with no `sawTurnActivity` emits a `noResponse` event → the bot **auto-recovers in 3 escalating tiers** (one attempt each per prompt episode, so the last dialog is preserved where possible): `resend` (same session, transient stall) → `fork` (fork the session into a fresh one carrying the FULL conversation via `adapter.forkSession`, so context isn't lost) → `restart` (blank `releaseThreadSession`+`startAgentSession`, dialog dropped — for a bloated session that re-wedges even forked) → `agent.no_response` give-up (`bot.ts handleNoResponse` + pure `utils/wedgeRecovery.ts decideWedgeRecovery`; replay rides `isRecoveryReplay` so the tier only advances). **`sawTurnActivity` is ASSISTANT-`message.updated`-only** — NOT parts: `prompt_async` echoes the USER prompt as `message.part` events, and counting those masked every wedge (the live miss). Guarded against a legit compaction idle and a still-pending provider retry (`Boolean(providerRetrySignature)`, so a reattached session's `undefined` field doesn't suppress it). Pure decisions in `utils/openCodeTurnActivity.ts` (`checkIsWedgedTurn`) + `utils/wedgeRecovery.ts`. **The idle is not the only trigger:** a prompt sent while a provider-managed retry is in flight ABORTS that retry and posts a replacement into the same session, and since `session.status` carries no turn id the adapter must ignore own idles until the replacement's own `busy` identifies it. A wedged session never sends that `busy`, so the wait is BOUNDED (`providerRetryReplacementStartTimeoutMs`, derived from the SSE stall + max reconnect delay so a stream hiccup is never mistaken for a dead turn); on expiry the boundary is released, the optimistic busy state cleared, and the SAME `noResponse` escalation runs. Pre-bound that flag latched forever: every own idle was swallowed, the topic stayed busy and wedge detection stayed disarmed with nothing able to recover it. **Background sub-agents (unblock a topic during a long delegation).** OpenCode's `task` tool is SYNCHRONOUS — the parent session is LOCKED for the whole sub-agent run, so a new message queues behind it and the topic looks hung (verified live: a 2nd prompt during a 75s sub-agent was answered only after it finished; even `abort` doesn't free the parent, though it does NOT kill the sub-agent). Fix uses OpenCode's built-in experimental feature (no fork): the server is spawned with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` (`installManager.ts`), and `forwardPromptToAgent` calls `adapter.detachRunningSubagents(key)` before `sendInput` — `POST /experimental/session/:id/background` detaches any sub-agent currently blocking the session (no-op if none) so the message is answered promptly while the sub-agent keeps running in the background; OpenCode auto-injects the sub-agent's result back into the parent when it finishes. Best-effort, gated on `session.busyChildSessionIds.size > 0` |
| `terminalAdapter.ts` | A raw interactive `$SHELL` in `tmux` — a third adapter sibling to claude/opencode (NO AI logic). Types the user's text in as keystrokes (`send-keys`) and streams the scraped pane back as ONE rolling message per command (generic capture → line-set-diff → `cleanOutput` → emit; no question/survey/sub-agent/tool-result/effort/MCP/resume machinery). Restart-safe: `listExistingTmuxSessions`/`adoptExistingTmuxSession` re-adopt a live `term-…` session at boot (current pane seeds the baseline, no flood). Does NOT extend `ClaudeCliAdapter` and leaves `outputsDeltas` falsy, so the Claude liveness loop never fires for it |

The `AgentAdapter` interface (in `types.ts`) is the seam. Per-backend agent
controls (`setModel`, `getCurrentModel`, `getRuntimeInfo`, `sendInput`,
`sendSignal`, `sendEnter`/`sendArrow`/`sendTab`, lifecycle
`startSession`/`stopSession`/`resumeSession`/`checkIsActive`) are optional
methods; the bot checks for them before calling. New per-backend capabilities are added here first, then surfaced
as a command in `bot.ts`.

### Output transport (`src/output/`) — the per-mode output boundary

| File | Responsibility |
|------|----------------|
| `createOutputTransport.ts` | Factory: pick the output transport by `CHAT_MODE` (the single mode decision); thin group impl (`queueOutput` + `finalizeInFlight` reconcile — drains the coalesced-but-unsent buffer to a permanent message on teardown so the final answer is never discarded under 429, S2), DM delegates to `createDmOutputTransport`, `both` returns a per-key dispatcher (`checkIsDmKey`) over both impls |
| `dmOutputTransport.ts` | The DM draft-cursor manager (relocated out of `bot.ts`): `deliverOutput` 3-way route (draft / `isComplete` one-shot / `queueOutput` baseline), `finalizeInFlight`, `disposeThread`, and the whole draft state + send/pace/idle machinery — built from injected `bot.ts` primitives |

The `OutputTransport` interface (in `types.ts`) is the seam, selected once at boot
(`registerOutputTransport`, mirroring `registerDisplayPrefsReader`). `queueOutput`
and `sendAgentChunks` stay shared primitives in `bot.ts` (group + the DM Claude
baseline / one-shot use them too). Thinking frames, sub-agent status, and pinned
status are NOT part of this seam — they are mode-orthogonal (`displayPrefs` /
OpenCode events / bindings).

## Commands (all registered in `bot.ts`)

- **Session lifecycle:** `/claude`, `/opencode` (`/oc`), `/terminal`, `/new`
  (`/clear_session`), `/quit` (`/q`), `/quit-all`, `/sessions`
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
    (completion), `/enter`. `/new`·`/quit`·leaving a folder work as for
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
    Reuses the release path (`releaseThreadSession`) then
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
  `/tool_results`, `/subagent`, `/output`, `/schedule`, `/claude_mode`, and raw TUI
  keys `/c`, `/y`, `/n`, `/enter`, `/up`, `/down`, `/tab`, `/esc` (`/escape`)
  - `/claude_mode [json|tmux]` switches THIS topic's Claude Code backend between
    the tmux-scrape adapter (`'claude'`) and the structured stream-json adapter
    (`claudeJsonStreamAdapterName`) — the two share the on-disk transcript, so a
    live switch STOPS the old backend and RESUMES the same conversation on the new
    one (`applyClaudeBackendSwitch` → `switchThreadAdapter` keeps `claudeSessionId`
    for both backends). Bare `/claude_mode` shows a picker (✓ on current); persists
    as the thread's adapter name, so ▶️ Claude / `/claude` reopen the picked backend
    (default **json-stream**, `resolveClaudeBackendName`; its `/login` is handled
    out-of-band, see the `/login` command section). Only
    for Claude topics (OpenCode/terminal → a hint). Replaces the retired
    `CLAUDE_JSON_STREAM_THREADS` env gate.
  - `/esc` (alias `/escape`) sends a raw Escape keystroke to the live agent
    (Claude: interrupt the current turn / dismiss a selector via
    `sendEscape` → `tmux send-keys Escape`, a fire-and-forget one-shot, NOT a
    wait-for-idle interrupt; OpenCode: "not supported").
  - `/schedule <free text>` is a **thin prompt wrapper** — the bot owns NO
    scheduling logic. It wraps the request in an agent-facing instruction
    (`schedule.forwardPromptTemplate`; bare `/schedule` →
    `schedule.interviewPromptTemplate`, agent asks what + when) and delivers it
    EXACTLY like a plain user message: `ensureAgentSession` does the
    bind-check + start (unbound → bind-required reply; a bound topic that
    never started an agent → `no-adapter`, surfaced as the schedule-specific
    `schedule.noAgent` warning «start /claude or /opencode first» instead of
    the generic `agent.no_session`, since a scheduled run needs an agent to
    launch), then `deliverPromptOrBuffer` forwards to the live agent or buffers it
    mid-startup. The agent does all the work (parse time → cron/one-shot, call
    the `schedule_create` / `schedule_list` / `schedule_cancel` MCP tools).
    Template instructions stay English in all locales (agent-facing, not
    user-read), but the TARGET reply language is baked per locale (for example,
    ru → Russian, en → English, de → German): a fresh session's only user-language signal
    is the resolved chat locale (live 2026-06-06: "in their language" made the agent
    interview in English). The agent's `schedule_*` MCP tools are injected
    into every bot-started session (see "Agent scheduling tools" above).
  - While a Claude TUI selector is on screen (`isQuestionPending`), a bare
    digit / `y` / `n` reply drives the menu in place (`sendInput`, no
    interrupt Escape); any other text breaks out as a fresh prompt. Pre-fix
    the digit was forwarded as a prompt and its Escape cancelled the menu
    ("Login interrupted").
  - While an **OpenCode** question is pending, the same rule holds via the
    shared `deliverActivePrompt` choke point (used by BOTH the text and voice
    handlers): a bare in-range digit ANSWERS that option (a button tap too), any
    other free-form text OR voice CANCELS the question (clear pending state →
    relabel the buttons message to «❌ … cancelled» — that IS the single
    cancellation notice; the standalone `agent.question_cancelled_for_prompt`
    line fires ONLY when there was no bubble to relabel, since posting both was
    the reported duplicate → **reject the question server-side**
    (`adapter.rejectQuestion` → `POST /question/:id/reject`) → `SIGINT` abort of
    the wedged turn — the abort's OWN error result is SWALLOWED, never surfaced
    as a bogus `OpenCode error: Aborted` / `Error: Aborted`
    (`checkIsOpenCodeAbortError`, both the `session.error` and message `info.error`
    channels) or json-stream `Claude error: API error` (the contentless
    `is_error` result of an interrupt we issued; `swallowNextAbortError` one-shot
    armed in `sendInterrupt`)) and is delivered as a fresh prompt. Pre-fix the voice handler had NO question
    handling, so a voice note queued behind the blocked question-turn and the
    user got no reply (live 2026-06-25, topic «ProjectB app 1»). Route decision:
    `getQuestionReplyRoute`. **Abandoning a question ALSO rejects it on the
    server** — not just on abandon-by-prompt but on session teardown while it is
    pending (`/new`, `/quit`, leaving the folder), each rejecting BEFORE the
    session is stopped. Without the reject the question stayed "open" in
    OpenCode's registry and `restoreOpenQuestion` (`GET /question` on every
    reattach) re-posted the stale question after a restart (live 2026-07-01,
    topic 203). Claude has no server-side question concept → no reject. Pure
    reject is the OpenCode adapter's `rejectQuestion` (mirrors `answerQuestion`,
    empty body).
  - **`/login` — per-backend.** The two Claude backends host the OAuth sign-in
    differently:
    - **tmux-scrape** (`'claude'`): `/login` is forwarded to the TUI. Its last
      step shows `Paste code here if prompted >` (a plain `>` box, not `❯`/a
      selector); while it is up (`isLoginPastePending`, `checkIsClaudeLoginPaste`
      off the last pane) ANY text reply is typed VERBATIM via `sendInput` — no
      Escape, no thread-context preamble — then the user's message is deleted
      from the topic (the code is a single-use secret) and a `🔐 code relayed`
      confirmation is posted. Pre-fix the long code fell to the prompt path,
      whose Escape cancelled the login and whose preamble corrupted the code.
    - **json-stream** (`claudeJsonStreamAdapterName`, the default): has no TUI to
      host `/login`, so the bot runs it OUT-OF-BAND. `getLoginCommandRoute`
      (reads the thread's RAW backend pick, so OpenCode/terminal threads are
      never wrongly intercepted) routes `/login` to `startClaudeAuthLogin`, which
      spawns `claude auth login --claudeai` in a bot-owned **pty** (via
      `node-pty`; `ANTHROPIC_API_KEY` stripped → subscription login), relays the
      sign-in URL to the topic (`agent.login_url`) once the "paste code" prompt
      renders, then arms per-thread pending state — the next plain text is the
      OAuth code: written into the pty, the message deleted, `🔐 code relayed`
      posted. On exit `claude auth status --json` is authoritative (exit code is
      the fallback): success → clear the pinned logged-out notice + confirm
      (`agent.login_success`); else a distinct `agent.login_failed`. A 120s
      URL-timeout covers a firewall-held OAuth-init call. Pending state is
      cleared on success/failure and on any teardown (`/quit`/`/new`/unbind —
      `cancelClaudeAuthLogin`); the pty is a bot child (NOT restart-safe — a
      restart drops the in-flight login, which is correct). Pure parse/decision
      helpers in `utils/claudeAuthLogin.ts`; impure pty driver + state in
      `bot.ts`.
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
    - **Default reasoning effort is `xhigh`** (hard-coded `defaultEffortLevel`
      in `effortLevels.ts`, no env var). It auto-applies on session start /
      resume / `/model` change whenever the thread has NO explicit `/effort`
      pick — an explicit pick always wins and is never overwritten, and the
      default is never persisted as a pref. OpenCode clamps it to the resolved
      model's variants (`clampEffortToAvailable`, since not every model ships
      `xhigh`); Claude types `/effort xhigh` and self-clamps per model. NOT
      applied on Claude adopt/reattach (the surviving TUI keeps its effort).
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
    of the chain-of-thought — the live `•••` indicator (`thinking.live`, a
    STATIC three-bullet glyph in every locale — the minimal "agent is working"
    cue; the animated cue stays the native typing action) shows in ALL
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
  `/doctor`, `/mcp`, `/trace`, `/timestamps`, `/language` (`/lang`)
  - `/language [locale|auto]` shows or changes the bot UI language for the
    current Telegram chat (DM or whole forum group). Bare `/language` opens a
    SINGLE-PAGE inline picker (pure builder in `utils/languagePicker.ts`): one
    ENDONYM button per locale (each language written in itself — `中文, English,
    Français, …`), sorted A→Z by the language's ENGLISH name (Chinese first …
    Uzbek last; only the DISPLAY order is sorted — `localeCodes` stays `en`-first
    canonical), two per row, `✓` on the current selection, and a
    full-width `🌐 Auto` reset row (`lang_<code>` / `lang_auto` callbacks). All 12
    locales fit in ONE message (Telegram allows ~100 inline buttons), so there is
    NO pagination / nav row. Tapping a locale sets the override, tapping `🌐 Auto`
    clears it — and either way the picker message is edited to a short
    confirmation in the resolved language and the KEYBOARD DISAPPEARS (no
    re-showable menu once a choice is made). The confirmation / status line shows
    ONLY the resolved language via `formatLanguageDisplay` (`i18n.ts`) — the
    endonym for an explicit override (`🌐 Language: Русский`), `auto (English)`
    for any auto source (`🌐 Language: auto (English)`); no Telegram-profile /
    source label is shown. Endonyms live in CODE (`localeEndonyms`), NOT the
    per-key dict, so key parity is unaffected. The `/language <locale>` /
    `/language auto` text commands keep working. Resolution order: explicit
    override → Telegram `from.language_code` → last supported Telegram locale seen
    in that chat → `en`; logs stay English.
  - `/timestamps on|off` (bare → status) toggles the per-thread prompt
    timestamp: when ON, every prompt forwarded to the agent gets its send time
    prepended as the very top line (`2026-06-27T19:42:10+04:00` — local-offset
    ISO from `formatIsoLocalOffset` in `utils/isoTimestamp.ts`, never `Z`),
    above the on-change thread-context preamble. **Agent-facing only** — never
    posted to the topic, and the Claude echo gates strip it with the rest of
    the echo. The time is the Telegram message's real `date` (plumbed from the
    text/voice handlers as `sentAtMs`); prompts with no live message (scheduled
    runs, buffered replay, api-retry nudge, file intake) fall back to now.
    Slash commands are never timestamped (same skip rule as the preamble).
    Default OFF; persisted in `state.json` (`timestampThreads`, mirrors
    `/trace`'s shape), lifecycle-independent. Use case: long multi-day sessions
    where the agent needs absolute time for "yesterday" / "2-3 days ago".
  - `/trace on|off` toggles the output-trace recorder for THIS topic; `/trace
    on all` / `/trace off all` flips the every-thread flag (and `off all`
    clears the per-thread set too); bare `/trace` reports status. Persisted in
    `state.json`, lifecycle-independent (session stop/new/quit/resume/unbind
    never touch it). Replaces the retired boot-time `OUTPUT_TRACE` env var.
    **Always-on by default:** the every-thread flag defaults ON (so every
    thread's recv/emit/send is recorded with zero setup); `/trace off all`
    turns it off DURABLY (survives restart — `false` is persisted explicitly,
    not confused with "never set"). Trace lands in hourly bucket files
    `DATA_DIR/output-trace-*.jsonl`. Separately, the bot's stdout/stderr is
    TEE'd to `DATA_DIR/bot-console-*.log` (also hourly buckets). BOTH are
    pruned at 6h by the file-sweep janitor (boot + interval).

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

## Privacy gate — the repo is public

History was scrubbed of real operator identifiers (2026-07-11) — keep it that way:

- Never commit real instance identifiers (chat/topic/user ids, group names,
  `t.me/c/…` links, home paths with a real username, private project
  names/remotes, tokens) — in code, tests, docs, plans, or commit messages.
  Quoting live-debug output is the usual leak path: replace ids first.
- Examples use the repo's placeholders (`-1001111111111`, `ExampleGroup`,
  `/home/user/…`); real values live only in untracked `CLAUDE.local.md` / `agent/tmp/`.
- Pre-commit review sweeps the diff for real-looking identifiers — any hit is a FAIL.

## Deployment — only committed `main` ships

After resuming an interrupted session, inspect recent commits and the worktree before continuing; another agent may have already advanced the task.

This checkout is the SOURCE other agent accounts on this host mirror: each has
its `origin` pointing at this checkout and pulls on a timer via
`scripts/self-update.sh`. What that means while you work here:

- **Only committed `main` propagates.** Anything left uncommitted in this tree
  never reaches the mirrors, however finished it looks — landing it on `main`
  IS the deploy step.
- The pull is **fast-forward only** and skips a dirty or diverged tree, so a
  rewritten or force-moved `main` silently stalls every mirror until each one
  is re-pointed by hand.
- Touching a hot-supervisor file (`src/cli.ts`, `src/cli/hot.ts`,
  `nodemon.json`) makes the mirrors restart the whole service, because nodemon
  never reloads the process that spawned it; any other change rides the normal
  hot reload.

## Tests & build

- `yarn test` — unit/integration (`src/__tests__/**/*.test.ts`, node test runner + tsx)
- `yarn typecheck` — `tsc --noEmit`
- `yarn build` — `tsc` → `dist/`
- `yarn dev` — `tsx watch src/cli.ts` (fast dev — TS errors crash the process)
- `yarn hot` / `telegramcode hot` — hot-reload mode: `tsc -w` + `nodemon`
  on compiled `dist/`. The supervisor starts nodemon's internal
  `dist/cli/botEntry.js` worker only after the first watch compile, avoiding an
  immediate duplicate boot. A broken intermediate edit can't take the bot down
  (no emit until the build is green), and `nodemon` waits for the old PID's
  graceful shutdown before respawning so the lock changes hands cleanly.
  Agents survive the reload: tmux sessions are external, while the long-lived
  hot supervisor pre-starts the initial `opencode serve` outside nodemon's
  replaceable worker subtree (using the checkout `.env`, not the launch-directory
  config). Any later server generation started by crash recovery, credential
  reload, or a late install goes through a one-shot host and is reparented
  outside that subtree before startup returns. An endpoint-bound `DATA_DIR`
  process-identity file records bot-started generations as `starting` before host
  release and promotes them to `ready` after health succeeds, so a successor can
  stop a pre-bind startup by process-group identity. `ready`/adopted ownership is
  revalidated against the exact hostname+port before signaling, without trusting
  a reused PID or group-signaling an adopted listener. Hot
  mode supports Linux/macOS and refuses to start on Windows,
  where nodemon cannot gracefully drain its worker tree.
  `reattachExistingSessions()` on the next boot re-adopts
  them silently if the downtime gap is short (hot reload), with a
  per-topic notice if it's long (cold start). Globally-installed bin
  resolves the project root via `fs.realpathSync(__dirname)`, so
  `telegramcode hot` works from any CWD.

- **Verifying code you wrote is YOUR job — do it yourself, never hand the check
  back to the user.** Run it, exercise it, drive the real surface. If the usual
  tool is missing (e.g. `telegram-mcp` not connected), find another path to
  exercise the change — hit the live OpenCode server over HTTP, drive/capture a
  real `tmux` claude pane, run the bot code path directly — don't offload the
  check. Asking the user to test what you built is the failure mode, not the
  fallback. (User instruction, 2026-06-21.)

- **Live-verify on the test thread BEFORE you commit — this is the EXECUTING
  (sub-)agent's job, not deferred to the orchestrator or the user.** A change
  that touches relay / output / rendering must be exercised live on the
  "Telegram code testing" topic (root `111`) and confirmed via the always-on
  trace / `get_history` *before* its commit lands. If `telegram-mcp` (the client
  that drives a topic by sending prompts) is not connected, that is a BLOCKER:
  say so explicitly, do NOT commit the change as "verified", and do NOT silently
  skip or claim done. Do not brief sub-agents to "leave on-host to the
  orchestrator". (User instruction, 2026-06-23.)

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
  `111` in the served group `-1001111111111` — placeholder ids; the real
  instance values live in untracked `CLAUDE.local.md`). Never send commands,
  prompts, or button presses to any other topic — those are the user's working
  threads with live agent sessions. (User instruction, 2026-06-04.)

- **Decode a `t.me/c/<internalId>/…` link the user pastes → query directly, no
  `list_topics`/guessing.** `chat_id` = `-100` + `<internalId>` (e.g.
  `1111111111` → `-1001111111111`). Two segments `t.me/c/<id>/<msgId>`: last is
  the `message_id` → `get_message_context(chat_id, message_id, context_size=N)`.
  Three segments `t.me/c/<id>/<topicId>/<msgId>`: middle is the topic (thread)
  root id, last is the `message_id` inside it. A topic's `threadId` (for
  `ThreadKey`/trace lookups) IS that topic root id. (User instruction, 2026-06-30.)

- **For send-path / responsiveness / ordering verification, use the output
  trace** — it is ON for all threads BY DEFAULT now (no `/trace on` needed),
  recorded into hourly bucket files `DATA_DIR/output-trace-*.jsonl` (read the
  current hour's bucket; older ones prune at 6h). Assert against the trace, not
  just `get_history`: recv→sendOk latency per command, `sendErr` 429s with
  `retryAfterSec`, emit-vs-sendOk order per topic. `/trace off all` stops it
  durably; `/trace` reports status. The toggle is persisted in `state.json`, so
  it survives a hot rebuild mid-debug — no `.env` edit, no restart. The bot's
  stdout/stderr is also TEE'd to `DATA_DIR/bot-console-*.log` (same hourly
  buckets, 6h prune) — readable post-incident without the operator's terminal.
  - **Diagnosing "a message never reached the user"** (dropped agent output,
    missing question / option buttons) — the `output-trace-*.jsonl` buckets are
    the SOURCE OF TRUTH (not the bot's terminal stdout, though that is now also
    captured in `bot-console-*.log`). Method: reproduce in the topic → follow
    the chain per
    message and localize the loss:
    `recv` (update arrived) → `emit` (adapter produced output/question) →
    `sendTry` → `sendOk` / `sendErr`.
      - no `emit` → lost in the adapter (SSE event not routed/handled);
      - `emit` but no `sendTry`/`sendOk` → lost in the bot's send path;
      - `sendErr` (429 `retryAfterSec`) → rate-limited / dropped under load
        (the prime suspect for *intermittent* loss — event-loop saturation);
      - `sendOk` but absent in `get_history` → spilled into / edited onto
        another message.
    `editMessageText` trace records carry NO thread id — when auditing a
    thread's sends never filter the trace by thread key alone (the edits vanish
    from the filtered view; this produced a wrong "statuses were never sent"
    diagnosis on 2026-07-02).
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
