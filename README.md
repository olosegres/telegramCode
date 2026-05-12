<table border="0">
  <tr>
    <td><h2>Drive Claude Code / OpenCode from a Telegram forum supergroup</h2>

One bot per forum supergroup. Each topic is bound to a subfolder under
`WORK_ROOT` and runs its own `claude` or `opencode` session — fully isolated.
Open as many topics as you need; you can even pin two threads to the same
project for parallel work.

### Features

- **Multi-thread routing** — one topic per task, isolated tmux + opencode sessions
- **Two AI backends** — Claude Code (tmux+pty) and OpenCode (HTTP+SSE), per-thread
- **Voice input** — Whisper transcription via Groq (preferred) or OpenAI
- **MCP hierarchy** — user / group / project / thread, with `${VAR}` env expansion
- **Restart-safe** — `state.json` + tmux re-attach (claude) + SSE re-connect (opencode)
- **Two-instance ready** — pet vs work, isolated DATA_DIR, group, port
    </td>
<td width="280"><img src="./demo.gif" width="320" /></td>
  </tr>
</table>

> **Breaking 2.0** — the old "one bot = one private chat = one folder" mode
> is gone. The bot now requires a Telegram forum supergroup; `WORK_DIR` was
> renamed to `WORK_ROOT` (parent folder containing your projects). See
> [Migration from 1.x](#migration-from-1x).

## Quick Start

### 1. Create the bot

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow prompts.
2. Save the token (`123456789:ABCdef...`).
3. **Disable privacy mode** — same chat: `/setprivacy` → pick this bot →
   `Disable`. Without this the bot only sees `/commands`, not free-form text.

### 2. Create the forum supergroup

1. In Telegram client: `New Group` → name it → add the bot.
2. Open group settings → enable **Topics** (Forum mode).
3. Promote the bot to admin with these rights:
   - `Manage Topics` (required — bind/create threads)
   - `Delete Messages` (for `/clear`)
   - `Pin Messages` (per-thread status banner — `/doctor` warns if missing
     but the bot still operates without it)
4. **Remove the bot from the group and add it again.** Telegram caches the
   privacy-mode flag on join; without re-adding the bot keeps the old
   private-mode and ignores free-form messages. See
   [Troubleshooting → Bot doesn't see text](#bot-doesnt-see-text).

### 3. Find your user id and group id

- Your user id: send `/start` to [@userinfobot](https://t.me/userinfobot).
- Group id: add the bot, send `/whoami` inside the group — the reply
  contains the `chatId` (starts with `-100…`).

### 4. Run with Docker

```bash
git clone https://github.com/anomalyco/telegramCode
cd telegramCode/examples
cp .env.example .env       # edit values
docker compose up -d
```

The compose file ships **two services** — `telegramcode-pet` and
`telegramcode-work`. If you only need one, comment out the other or copy
just the block you want. The pair is set up so they cannot collide
(separate tokens, groups, data volumes, opencode ports — see
[Two instances on one host](#two-instances-on-one-host)).

### 5. Use it

1. Open the group in Telegram.
2. In the General topic, send `/ls` — bot lists subfolders under `WORK_ROOT`.
3. Create a topic (`+` button, or `/new <name> [subdir]` in General).
4. In the new topic: `/bind <subdir>` (auto-bound if the topic name
   matches a subdir).
5. `/claude` or `/opencode` → talk to the agent.
6. `/stop` to kill the session; `/where` to inspect; `/clear` to delete the
   topic's bot messages.

## Architecture

```
WORK_ROOT=/home/user/src                ← one host folder per instance
├── projectAlpha/      ← Topic "projectAlpha"        (claude)
├── overview/         ← Topic "projB-frontend"       (claude)
│                     ← Topic "projB-backend"        (opencode)   ← one folder, two topics
│                     ← Topic "projB-refactor"       (claude)
└── telegramCode/     ← Topic "telegramCode"       (claude)

Telegram forum supergroup
├── Bot is admin with can_manage_topics + can_delete_messages + can_pin_messages
└── Routes by ThreadKey = (chatId, threadId)  →  src/state.ts persists bindings
```

Routing key is `(chatId, threadId)` everywhere. Per-thread state lives in
`${DATA_DIR}/state.json` (atomic writes with `fsync`, archived on
corruption). tmux sessions are named `claude-${chatId}-${threadId}` and
opencode sessions are keyed by the same string — two topics on the same
folder stay independent.

### Adapter pattern

```
Telegram <-> bot.ts <-> AgentAdapter <-> { Claude CLI (tmux+pty), OpenCode (HTTP+SSE) }
                            │
                            └── state.ts  (bindings, claudeSessionId, opencodeSessionId,
                                           messages, MCP per-thread overrides)
```

Each adapter implements `AgentAdapter` from `src/types.ts`:
- `startSession(key, workDir, args?)` / `stopSession(key)` / `resumeSession(key, workDir, sessionId)`
- `sendInput(key, text)` / `sendSignal(key, signal)`
- events: `output`, `status`, `question`, `closed`, `started`, `stopped`, `error`
  (all emit `ThreadKey` first)

## Commands

### In any topic (after `/bind`)

| Command | Description |
|---|---|
| `/claude`, `/opencode`, `/oc` | Start agent in this topic's bound folder |
| `/agent` | Pick agent inline |
| `/model` | Switch model |
| `/sessions` | List & resume previous sessions in this folder |
| `/stop` | Kill current agent |
| `/status` | This thread's status |
| `/output` | Last 500 lines of agent output |
| `/c`, `/y`, `/n` | Ctrl+C / "y" / "n" |
| `/enter`, `/up`, `/down`, `/tab` | tmux key passthrough |
| `/clear` | Delete bot messages in this topic (up to 48h, Telegram limit) |
| `/where` | Show bound folder, branch, agent, status |
| `/unbind` | Stop agent, drop binding |
| `/mcp` | List MCP servers active for this thread |

### In the General topic

| Command | Description |
|---|---|
| `/help` | Context-aware help |
| `/ls` | List subdirs under `WORK_ROOT` |
| `/list` | List existing topics and their bindings |
| `/new <name> [subdir]` | Create a topic (auto-bound if subdir given) |
| `/status` | Global view of all topics + active agents |
| `/doctor` | Self-diagnose: admin rights, privacy mode, paths, CLIs |
| `/version` | Versions: bot, claude, opencode, node, tmux |
| `/whoami` | Show userId, chatId, threadId, isAllowed, binding |

### Natural language

In a bound topic you can also type:
- `claude fix the bug` / `opencode add tests`
- A plain message after `/claude` is already running → routed as input.

Voice messages are transcribed via Groq Whisper (free) or OpenAI Whisper
(fallback) and follow the same routing.

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `ALLOWED_USERS` | Comma-separated Telegram user IDs (numeric) |
| `ALLOWED_GROUP_ID` | The forum supergroup id (`-100…`). Get from `/whoami` |
| `WORK_ROOT` | Host parent folder; topics bind to its subdirs |

### Optional

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `~/.telegramCode` | Per-instance state. **Mandatory** if you run two bots on the same host — otherwise both share `state.json` and `mcp.json` and corrupt each other |
| `DEFAULT_AGENT` | `claude` | `claude` or `opencode` |
| `BOT_LANG` | `ru` | `ru` or `en` |
| `OPENCODE_URL` | `http://localhost:4096` | OpenCode server URL — must differ per instance on the same host |
| `OPENCODE_BIN` | (auto) | Custom opencode binary path |
| `ANTHROPIC_API_KEY` | — | For Claude Code |
| `GROQ_API_KEY` | — | Voice transcription (free, preferred) |
| `OPENAI_API_KEY` | — | Voice transcription (fallback) |

> `WORK_DIR` (1.x) is **fatal** in 2.0 — set `WORK_ROOT` to the parent
> instead. The bot reports a clear error on boot, see
> [Migration from 1.x](#migration-from-1x).

## MCP servers — user / group / project / thread

The bot integrates with [Claude's MCP system](https://docs.anthropic.com/en/docs/build-with-claude/mcp)
through four layers, additively merged:

| Layer | File | Scope | How loaded |
|---|---|---|---|
| **User** | `~/.claude/settings.json` | All claude invocations of this Linux user | claude auto-loads |
| **Group** | `${DATA_DIR}/mcp.json` | All threads of this bot instance | bot passes `--mcp-config` |
| **Project** | `${workDir}/.mcp.json` | All threads bound to this folder | claude auto-loads from cwd |
| **Thread** | `${DATA_DIR}/threads/<chatId>:<threadId>.json` | One specific thread | bot passes `--mcp-config` |

Group + thread files go through `${VAR}` expansion (read from
`process.env`) before claude sees them — the CLI doesn't shell-expand
inside `--mcp-config` JSON. The expanded copy is written to
`${DATA_DIR}/tmp/` with mode `0600` and cleaned up on `stopSession`.

Example `${DATA_DIR}/mcp.json`:

```jsonc
{
  "mcpServers": {
    "corp-jira": {
      "command": "npx",
      "args": ["-y", "@atlassian/mcp-jira"],
      "env": { "JIRA_API_TOKEN": "${JIRA_API_TOKEN}" }
    },
    "corp-confluence": {
      "type": "http",
      "url": "https://mcp.corp.com/confluence",
      "headers": { "Authorization": "Bearer ${CONFLUENCE_TOKEN}" }
    }
  }
}
```

Inspect what's actually active in a thread with `/mcp`. Adding/removing
servers in MVP is by editing JSON directly (or `claude mcp add` for the
user layer); UI commands are planned for Phase 9.

> **OpenCode MCP** is currently configured at the opencode-server level
> only — one fleet per instance, no per-thread override. Per-thread MCP
> for opencode is on the Phase 9 roadmap.

## Two instances on one host

The example `docker-compose.yml` runs **pet** and **work** side by side.
Each pair of variables below must differ to avoid silent corruption:

| What | Why it must differ |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram routes updates to a single long-poller per token; sharing → message loss |
| `ALLOWED_GROUP_ID` | The bot gates by group id; sharing → cross-instance leakage |
| `WORK_ROOT` | Each instance manages its subtree; sharing → tmux name collisions |
| `DATA_DIR` | `state.json` / `mcp.json` / `threads/` per instance; sharing → corrupted JSON |
| `OPENCODE_URL` port | OpenCode server binds the port; second start fails with `EADDRINUSE` and you'd silently share sessions |

The shipped compose uses ports `4096` (pet) and `4097` (work). If you run
both as different Linux users with separate Docker networks, the port
isolation is already handled by the network — but keeping ports explicit
is the safer default.

## Restart behaviour

On boot the bot:

1. Loads `state.json` (archives to `state.json.corrupted-<ts>` if parse
   fails, then starts fresh and notifies in General).
2. Walks `tmux ls`, finds sessions named `claude-<chatId>-<threadId>`,
   and re-attaches the ones still in `state.json`. Orphan tmux sessions
   are killed.
3. For each thread with a stored `opencodeSessionId`, re-opens the SSE
   stream via `resumeSession(...)` so opencode threads survive the restart
   as well.
4. Posts a "bot restarted, session is still alive, continuing" notice
   in each re-attached topic (see `i18n.ts → agent.reattached`).
5. Schedules `setMyCommands` so the Telegram client picks up the menu.

Closed-but-not-deleted topics keep their binding; only `400: message
thread not found` from a send triggers binding cleanup. Closed topics
are detected by `TOPIC_CLOSED` errors and surface a friendly message
asking the user to reopen.

## Troubleshooting

### Bot doesn't see text

You disabled privacy mode in @BotFather **after** adding the bot. The
flag is cached on join. Fix:

1. Remove the bot from the group.
2. (Re-confirm in @BotFather → `/setprivacy` → this bot → `Disable`.)
3. Add the bot back.

Verify with `/doctor` — the privacy line should report it as disabled.

### `/bind` says "folder not found"

`WORK_ROOT` doesn't contain a subfolder with that name (or it's a
symlink pointing outside `WORK_ROOT`). Run `/ls` to see what's available,
or fix the host path. Path-traversal attempts (`../`, absolute paths,
NUL bytes, NFC-vs-NFD mismatches) are rejected by design — see
`validateSubdir` in `src/bot.ts`.

### "Missing right" / `/clear` does nothing

The bot needs admin rights `can_delete_messages` and `can_pin_messages`
in addition to `can_manage_topics`. Open group settings → admins →
the bot → tick the missing boxes. `/doctor` shows the exact gap.

### Two instances on the same machine fight each other

You forgot to set distinct `DATA_DIR` and `OPENCODE_URL`. The bot logs
`[startup] DATA_DIR=<path>` on boot — if both instances log the same
path, fix `.env` and `docker compose down && up -d`.

### Claude opens a session picker instead of resuming

The 1.x adapter invoked `claude --resume` with no UUID and relied on the
interactive picker, which doesn't survive a non-interactive pty. 2.0
generates a UUID with `crypto.randomUUID()`, passes it via
`--session-id`, and resumes via `--resume <uuid>`. If you see a picker
anyway, your local claude CLI is older than 2.1.x — upgrade with
`npm i -g @anthropic-ai/claude-code` (the bot also auto-installs on
first use, see `src/installManager.ts`).

### OpenCode "address already in use"

Two instances on the same host with the same `OPENCODE_URL`. Pick a
different port for the second instance (e.g. `4097`).

## Development

```bash
yarn install
yarn dev          # tsx watch
yarn typecheck    # strict tsc --noEmit
```

The Docker dev loop:

```bash
docker compose restart telegramcode-pet     # pick up code changes
docker compose logs -f telegramcode-pet     # tail logs
```

Key files:

- `src/bot.ts` — Telegraf entry, commands, message handling
- `src/state.ts` — JSON state, atomic writes, per-key async lock
- `src/types.ts` — `ThreadKey`, `AgentAdapter`
- `src/adapters/claudeCliAdapter.ts` — tmux + pty, session re-attach
- `src/adapters/openCodeAdapter.ts` — HTTP + SSE
- `src/mcpConfig.ts` — `${VAR}` expansion, tmp-file plumbing
- `src/rateLimiter.ts` — token-bucket per chat
- `src/i18n.ts` — `t()` / `errorMessage()` (ru/en)
- `agent/tasks/actual/2026-05-11-multi-thread-routing.md` — the plan
  that this README is the docs face of

## Migration from 1.x

The 1.x "one bot = one private chat = one folder" mode is **removed**.
There is no in-place upgrade; the steps are:

1. Stop the old bot.
2. Create a forum supergroup, add the bot, follow [Quick Start §2-3](#2-create-the-forum-supergroup).
3. Rename `WORK_DIR` → `WORK_ROOT` in your env and point it at the
   parent folder (e.g. `/home/user/src`).
4. Add `ALLOWED_GROUP_ID` (`/whoami` in the group reveals it).
5. Set `DATA_DIR` if you run two instances on the same host.
6. The old `~/.telegram-bot-messages.json` is moved to `.bak` on first
   start — no migration of message ids, fresh `state.json`.

Release notes:

- Routing key is `(chatId, threadId)`, persisted in `state.json`.
- tmux sessions renamed `claude-${chatId}-${threadId}`.
- `claude --session-id <uuid>` is hardcoded — no more interactive picker.
- `--dangerously-skip-permissions` is hardcoded (symmetry with
  opencode's auto-approve).
- Privacy mode must be disabled and the bot re-added.

## License

MIT
