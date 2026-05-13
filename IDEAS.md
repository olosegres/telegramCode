# tgcode — multi-workspace Telegram agent gateway

Captured 2026-05-08 — research notes + user requirements + architecture
sketch. Picked up from the conversation that started as "add `yarn
telegram` for projectAlpha" and grew into a redesign of the bot.

This file is the seed for a future planning session. NOT a plan yet —
ideas, options, open questions. Read top-to-bottom; the "Open
decisions" section at the end is the next-action checklist.

---

## 1. User requirements (paraphrased from chat)

1. The Telegram bot should be a **portable executable** — run
   `tgcode` from any directory, on any machine, and it connects to
   Telegram. Not a docker compose service that's bolted onto a
   specific repo.
2. From inside Telegram, the user wants **a single group / chat with
   threads** ("group with topics"). Each thread is bound to a
   specific working directory.
3. Each thread runs **its own agent** (claude / opencode / etc.) in
   the bound `cwd`.
4. From one Telegram surface, the user wants to **manage multiple
   repositories simultaneously** without switching bots, machines,
   or chats.

The current setup (overview's `yarn telegram` + the freshly added
projectAlpha copy) is one bot per repo, one docker compose service
per repo, hardcoded `WORK_DIR=/workspace`. That doesn't scale to
"manage 10 repos from Telegram".

---

## 2. Relevant Bot API capabilities (researched 2026-05-08)

Source: <https://core.telegram.org/bots/api-changelog>. Latest API
version at time of writing: **9.6 (April 3, 2026)**.

### The two killer features for our use case

**Bot API 9.3 (December 31, 2025) — topics in private chats.**
Until 9.3, "forum topics" only existed in supergroups configured as
forums. 9.3 brought the same primitive into 1-on-1 chats with a
bot:

- `createForumTopic` works in private chats with the bot.
- `Message` carries `message_thread_id` and `is_topic_message` in
  private chats with topic mode enabled.
- `User.has_topics_enabled` flag on the bot — toggled by the bot
  owner via `@BotFather`'s mini app
  (`/mybots → Bot Settings → Configure Topics`).
- `editForumTopic`, `deleteForumTopic`, `unpinAllForumTopicMessages`
  all accept `message_thread_id` in private chats now.
- All `send*` methods accept `message_thread_id` for private-chat
  topic targeting.
- New: `sendMessageDraft` — **stream partial messages to the user
  while the agent is still generating**. Replaces the
  spam-`editMessageText` hack for live agent output.

**Bot API 9.4 (February 9, 2026) — bots can manage private-chat
topics.**

- Bots can call `createForumTopic` themselves in private chats
  (previously only the user could create; bot could only edit).
- New `@BotFather` setting: prevent users from creating / deleting
  topics in private chats (so the bot stays the sole topic
  manager — exactly what we want).
- `User.allows_users_to_create_topics` reflects that setting.
- `KeyboardButton.icon_custom_emoji_id` and `style` (color) — useful
  for cleaner inline UIs (Apply diff / Reject / Re-run buttons).

**Bot API 9.5 (March 1, 2026) — `sendMessageDraft` is now allowed
for ALL bots.** Previously it was an opt-in / allow-listed method;
9.5 unlocks it universally. This is the streaming-output unlock.

Other 9.5 bits worth noting:
- `MessageEntity` type `date_time` — render formatted timestamps
  inline.
- Member `tag` field + `setChatMemberTag` method — useful if we
  go the shared-supergroup route and want to color-code teammates.

**Bot API 9.6 (April 3, 2026) — Managed Bots.** Less directly
relevant but interesting for the "ship as a SaaS" path:
- A bot can register a "child" bot via
  `t.me/newbot/{manager}/{suggested}` link.
- `getManagedBotToken` / `replaceManagedBotToken`.
- Could automate "give every user their own personal `tgcode` bot
  with no manual `@BotFather` step".

### What this means concretely for the design

- **Solo developer flow** does NOT require a supergroup anymore.
  Just open a 1-on-1 chat with `@yourTgcodeBot`. The bot creates
  one topic per registered workspace. Each topic has its own
  scrollback, its own pinned message, its own agent state. No
  admin rights needed, no chat configuration.
- **Streaming agent output is finally a first-class API call** —
  `sendMessageDraft` instead of edit-spam. UX gets dramatically
  better.
- **Forum supergroups stay relevant for the "shared with team"
  flow** — multiple humans + bot in one supergroup, each topic
  is a workspace, anyone in the group can talk to it. That just
  needs the bot added as admin with `can_manage_topics`.

---

## 3. Architecture sketch (current thinking)

```
┌─ Local machine ──────────────────────────────────────┐
│                                                       │
│  $ tgcode init        ← run inside any repo:          │
│                         registers cwd as a workspace  │
│  $ tgcode start       ← boots the daemon (idempotent) │
│  $ tgcode list        ← prints workspace + topic map  │
│  $ tgcode logs        ← tail daemon stdout            │
│  $ tgcode bind <topic># manual rebind                 │
│                                                       │
│  ┌─ tgcode daemon (single instance per machine) ─┐   │
│  │  • SQLite ~/.tgcode/state.db                   │   │
│  │     workspaces:  id, path, default_agent, ...  │   │
│  │     bindings:    topic_id → workspace_id       │   │
│  │     sessions:    topic_id → claude/opencode    │   │
│  │                  session id                    │   │
│  │  • Telegram Bot API client (telegraf)          │   │
│  │  • Per-topic agent worker (lazy-spawned, LRU)  │   │
│  │  • Pinned-message updater (cwd, branch, agent) │   │
│  └────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────┘
                       ↕ Telegram (Bot API 9.5+)
┌─ In Telegram ────────────────────────────────────────┐
│  Private chat with @yourTgcodeBot                    │
│   ├─ 📁 projectAlpha      ← cwd=/Users/user/src/projectAlpha │
│   ├─ 📁 overview         ← cwd=/Users/user/src/overview    │
│   ├─ 📁 telegramCode     ← cwd=/Users/user/src/telegramCode│
│   └─ ⚙️  System          ← /list /add /remove /help        │
└──────────────────────────────────────────────────────┘
```

### Components

1. **`tgcode` CLI binary** — invokable from any working directory.
   Subcommands:
   - `tgcode init` — create `.tgcode/config.json` in cwd, register
     workspace in `~/.tgcode/state.db`, ask the daemon to create a
     topic for it.
   - `tgcode start` / `tgcode daemon` — boot the daemon if not
     running. Idempotent.
   - `tgcode stop` — graceful shutdown.
   - `tgcode list` — workspaces + their topic ids + bound branches.
   - `tgcode bind <topic_id>` — bind cwd to an existing topic
     (e.g. user manually created one).
   - `tgcode logs` — `tail -f` the daemon log.
   - `tgcode link` — print the `t.me/yourTgcodeBot?...` deeplink for
     the current workspace's topic.

2. **Daemon** — long-lived single instance per machine.
   - Source of truth: `~/.tgcode/state.db` (SQLite).
   - Connects to Telegram (Bot API; MTProto only if needed).
   - Routes incoming messages by `message_thread_id` →
     `(workspace, agent worker)`.
   - Maintains a per-topic pinned message with live status
     (`cwd`, branch, ahead/behind, current agent, last commit
     subject).
   - Writes structured logs to `~/.tgcode/logs/`.

3. **Per-topic agent worker** — one `claude` or `opencode` process
   per active topic, kept warm. Streams stdout chunks back to the
   topic via `sendMessageDraft`. Gets killed by an LRU policy when
   too many sit idle.

4. **Telegram surface — two modes:**
   - **Private-chat topics** (Bot API 9.3+). Default for solo dev.
   - **Forum supergroup topics** (older, universal). For shared /
     team use. Same routing code, different chat type.

### What's in `.tgcode/config.json` per workspace

```jsonc
{
  "workspaceId": "projectAlpha",
  "defaultAgent": "claude",
  "agentModel": "claude-opus-4-7",
  "envFile": ".env",
  "shellInit": ["nvm use 22"],   // optional pre-command hook
  "topicTitle": "📁 projectAlpha",
  "topicEmojiId": "5417915203100613993" // optional custom emoji
}
```

### What's in `~/.tgcode/state.db`

Tables:
- `workspaces(id, path, config_json, created_at, last_used_at)`
- `topic_bindings(topic_id, chat_id, workspace_id, created_at)`
- `agent_sessions(topic_id, agent, agent_session_id,
  last_msg_id_streaming, started_at, last_active_at)`
- `outbox(message_id, topic_id, payload, status)` — for retry on
  Telegram transient errors.
- `meta(key, value)` — bot token (or path to env), schema version.

---

## 4. Distribution — how `tgcode` becomes a binary

Goal: `curl … | sh` puts `/usr/local/bin/tgcode` on the user's
machine. No Node, no docker, no yarn install ceremony.

Options:

| Approach | Pros | Cons |
|---|---|---|
| **Bun `bun build --compile`** | Single ~60–80MB binary, includes Bun runtime + your TS. Ships fast. | Bun's `node-pty` story is still rough; need to verify all deps work. |
| `pkg` / `nexe` (Node) | Mature, every Node API works. | Larger binary (~100MB), slower startup. |
| `npm install -g tgcode` | Trivial to publish. | Requires Node on host. |
| Homebrew tap | Mac-friendly, easy upgrade path. | Mac only. |
| Docker image (current model) | Reproducible, isolates deps. | Heavy; defeats the "drop on laptop" goal. |

Working assumption: **Bun `--compile` as primary**, `npm i -g`
secondary, brew tap when polished. Docker stays as an option for
"run on a tiny VPS".

---

## 5. Decision matrix — open questions

These five questions block the planning step. We resolve them, then
write a concrete `agent/tasks/actual/...` plan.

### Q1. Where does the daemon live?

| Option | Pros | Cons |
|---|---|---|
| **(A) Laptop / dev machine** | Direct fs access, no SSH, zero infra | Sleeps when laptop closes; bot offline when you're offline |
| **(B) VPS / home server** | 24/7 availability | Repos must be on the server (git clone, SSH, …) — you no longer edit "your local files" |
| **(C) Hybrid: per-machine daemons + relay** | Local fs + always-on | Most complex; needs a "which machine has projectAlpha?" router |

Working preference: **(A)** for v1. **(B)** is a copy-paste from
(A). **(C)** only if real demand emerges.

### Q2. Private-chat topics, forum supergroup, or both?

| Option | Pros | Cons |
|---|---|---|
| **Private chat with bot + topics** (9.3+) | Zero setup. Open chat → done. No admin rights. | Solo only. Can't hand a workspace to a teammate. Requires updated TG client. |
| **Forum supergroup** | Shareable; team can all see / talk | User must create supergroup, enable forum mode, add bot as admin with `can_manage_topics` |
| **Both** | Universal | Slightly more routing code |

Working preference: **private chat as default, optional forum
mode** (`tgcode init --forum=<chat_id>` to bind a workspace to a
forum supergroup topic instead of the private-chat surface).

### Q3. Bot API or MTProto?

Current `telegramCode` uses Bot API via telegraf. Bot API 9.5+ has
everything we listed above. MTProto would only be needed for:
- reading message history before the bot was added (we don't need)
- logging in as a real user instead of a bot (then we wouldn't
  need a bot at all — different product)
- bypassing limits like 4096 chars per message

Working preference: **Bot API (telegraf)**. Stay simple.

### Q4. How many agents kept alive at once?

Each active topic = one agent process. Memory cost:
- claude-cli ≈ 150 MB
- opencode-server ≈ 200 MB
- 5 active workspaces ≈ 1 GB

Strategies:
- **eager** — all registered workspaces always loaded
- **warm-LRU** — last N used kept warm, idle ones recycled
- **on-demand** — every request spawns fresh (slow but cheap)

Working preference: **warm-LRU, N=3** by default,
`tgcode config max_warm 5` to bump.

### Q5. Bot capabilities inside a topic — minimum viable verbs

Baseline:
- Plain text → routed to agent → streamed reply
- `/cd <subdir>` — chroot inside the workspace
- `/agent claude | opencode | codex | aider` — switch
- `/git status`, `/git diff`, `/git log -5` — shortcuts
- `/run <cmd>` — exec in cwd, stream stdout
- File upload → save to cwd (configurable subpath)
- `/screenshot` — capture dev server if one is running

On top of these, 9.4's custom-emoji + colored inline keyboards
let us add inline action buttons cheaply (Apply diff / Reject /
Re-run / Open in IDE / Copy to clipboard). The pinned message in
each topic is the live status board (`cwd`, branch, agent, model,
`ahead 2 / behind 0`, last commit).

---

## 6. Repo question — new project or evolve `telegramCode/`?

`telegramCode/` today is the bot that overview's `yarn telegram`
service runs (and now projectAlpha's, after the May 8 fix in this
conversation). It was designed as one bot per repo, one
`WORK_DIR`. Turning it into a multi-workspace daemon with a CLI
front-end is a much bigger change of shape.

Options:

| Option | Pros | Cons |
|---|---|---|
| **New repo `tgcode`** | Clean slate, no legacy, can use Bun-native APIs from day 1, Bot API 9.5 baseline | Two repos to maintain during transition; old setup needs to keep working until new one is proven |
| **Evolve `telegramCode/`** | One codebase, fewer moving parts | Drag along legacy single-workspace assumptions; bigger refactor risk |

Working preference: **new repo**, freeze `telegramCode/` as the
"overview-era" bot. When `tgcode` is feature-complete + stable,
overview and projectAlpha switch their compose services to use
`tgcode` instead.

---

## 7. Outstanding loose ends

Stuff we touched on but didn't fully resolve. Surface again in the
next planning session:

- **`form-data` fix in `telegramCode/package.json`** — committed
  locally, not yet pushed to `gitlab.com/example/telegram-code`.
  Either push it, or carry the fix forward into `tgcode` and
  retire `telegramCode` once `tgcode` ships.
- **`claude-node-git` image dependency** — projectAlpha's
  `yarn telegram` currently builds it from `../overview/Dockerfile.claude`.
  `tgcode` (as a binary) shouldn't need a Docker image at all —
  the daemon runs natively on the host.
- **Token conflict** — overview and projectAlpha share
  `TELEGRAM_BOT_TOKEN`. With the multi-workspace `tgcode` model,
  this becomes a non-issue: ONE bot covers ALL workspaces.
- **MCP integration** — the existing flow has `MCP_AUTH_TOKEN`
  passed into the claude container so it can talk to overview's
  MCP server. In the multi-workspace world, MCP wiring is
  per-workspace (projectAlpha may not use MCP at all). Move it
  into the per-workspace `.tgcode/config.json`.
- **OpenCode binary** — currently mounted from `../opencode-fork`.
  For native daemon, either ship `opencode` as a sibling binary
  alongside `tgcode`, or `tgcode install-opencode` subcommand
  fetches and pins a known-good build.
- **Per-workspace `.env`** — agents like claude often need
  `ANTHROPIC_API_KEY`; per-workspace overrides should be supported
  (e.g. one workspace uses oauth, another uses an explicit key).

---

## 8. Roadmap / backlog

Small, scoped features captured during regular work. Move into
`agent/tasks/actual/...` when picked up. Items here are *not yet
done* — once shipped, the code is the record (drop the bullet or
move it to `CHANGELOG.md`).

- **Telegraf `setMyCommands` for the bot.** So `/quit`, `/stop`,
  `/c`, `/y`, `/n`, `/enter`, `/clear`, `/status`, `/bind`, … are
  autocompleted in the Telegram input. Today the user has to
  remember them. One call at boot, after `bot.launch`.
- **Process-level double-`Ctrl+C` in the daemon itself.** First
  press warns "press Ctrl+C again within 2s to exit", second
  triggers `shutdown('SIGINT')` (`src/bot.ts:3234`). Today a single
  `Ctrl+C` exits the daemon — fine in docker, error-prone when
  running locally and the user just meant to interrupt a foreground
  log tail.

---

## 9. Next action

Don't start coding. Resolve **Q1–Q5 + the "new vs evolve" repo
question** with the user, then create
`agent/tasks/actual/<date>-tgcode-multi-workspace.md` with concrete
phases:

1. Minimal daemon + ONE workspace (functional parity with current
   `telegramCode`).
2. CLI: `tgcode init / start / list / logs`.
3. Multi-workspace + private-chat topic auto-creation.
4. `sendMessageDraft` streaming.
5. Single-binary distribution (`bun build --compile`).
6. Forum-supergroup mode (optional, for shared use).
7. Cutover: overview + projectAlpha switch their `yarn telegram`
   to use the new binary instead of docker compose.
