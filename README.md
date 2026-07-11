<table border="0">
  <tr>
    <td><h2>Telegram as a terminal for coding agents — every thread is a tab</h2>

telegramCode turns Telegram into a terminal for running agentic CLIs. A forum
supergroup is the terminal window; each topic (thread) is a tab of that
terminal — bound to a subfolder under `WORK_ROOT` and running its own fully
isolated **Claude Code** or **OpenCode** session. Open as many tabs as you
need (even two on the same project for parallel work) and drive the agents
from your phone or tablet, voice messages included.

### Features

- **Multi-thread routing** — one topic per task, isolated tmux + opencode sessions
- **Two chat surfaces** — forum-group topics and/or the owner's bot DM (`CHAT_MODE`), tabs on both
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
> is gone. The bot now requires a Telegram forum supergroup for the group
> surface (`CHAT_MODE=dm` works without one); start
> `telegramCode` from the parent folder containing your projects and that `$PWD`
> becomes the work root. See [Migration from 1.x](#migration-from-1x).

## Two surfaces: group topics, bot DM, or both

The bot serves two Telegram surfaces, selected by `CHAT_MODE`
(`group` | `dm` | `both`, default `both`):

- **Forum supergroup** — every topic is a tab. The most familiar UX: a visible
  topic list, per-topic names and icons, quick switching between agents. The
  trade-off is Telegram's group throughput cap (about 20 messages/min per
  group), so the bot paces and coalesces heavy output streams.
- **The bot's own DM** (owner only, gated by `OWNER_USER_ID`) — the private
  chat runs in topic mode too, so you get the same thread-per-agent tabs
  there, and live output streams through Telegram's native draft "cursor":
  the reply grows in place in one message instead of arriving as a flood of
  separate messages.

With `both` (the default) one instance serves the group and the owner DM at
once; if `OWNER_USER_ID` is not set, the DM surface stays inert and the
instance is effectively group-only.

## Where to run the bot server

The bot runs anywhere the agent CLIs run:

- **Your own working machine** — the simplest start: launch `telegramCode`
  from your projects parent folder and your laptop/desktop becomes the
  backend. The catch: agents are only reachable while the machine is on and
  awake.
- **A remote server (cloud VPS/VDS or bare metal)** — the more convenient
  setup: organize your working environment there once (git + your repos,
  Claude Code / OpenCode, `telegramCode`) and you get an always-on dev box you
  drive from any device through Telegram — phone, tablet, voice. When picking
  one, a bare-metal server without virtualization beats a virtualized VPS/VDS:
  its NVMe drives are usually much faster, which matters once you also build
  and run a dev server there, not just the agents. Classic terminal access to
  the very same Claude sessions stays available over SSH via
  `telegramCode cli claude` (see [Quick Start §4b](#4b-or-run-as-a-global-cli-telegramcode)).

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
   - `Delete Messages` (for `/clear_messages`)
   - `Pin Messages` (per-thread status banner — `/doctor` warns if missing
     but the bot still operates without it)
4. **Remove the bot from the group and add it again.** Telegram caches the
   privacy-mode flag on join; without re-adding the bot keeps the old
   private-mode and ignores free-form messages. See
   [Troubleshooting → Bot doesn't see text](#bot-doesnt-see-text).

### 3. Find your user id (group id is automatic)

- Your user id: send `/start` to [@userinfobot](https://t.me/userinfobot).
- Group id: **you don't need to find it.** Leave `ALLOWED_GROUP_ID`
  empty. The bot auto-pairs with the first forum supergroup an allowed
  user contacts it from — it captures the `-100…` id, saves it to
  `state.json`, and replies a confirmation. Re-point later with `/pair`
  inside another group.
  - To pin a specific id by hand instead, set `ALLOWED_GROUP_ID` to the
    numeric value (a group **name** is not accepted — Telegram addresses
    chats only by numeric id). A numeric env value disables auto-pairing.

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

### 4b. Or run as a global CLI (`telegramCode`)

Skip Docker entirely and install the bot as a Node binary on the host:

```bash
git clone https://github.com/anomalyco/telegramCode && cd telegramCode
yarn install && yarn build
npm install -g .            # registers the `telegramCode` command

mkdir -p ~/.config/telegram-code
cp .env.example ~/.config/telegram-code/.env
$EDITOR ~/.config/telegram-code/.env   # fill TELEGRAM_BOT_TOKEN (group auto-pairs; access = its admins)

cd ~/projects && telegramCode          # WORK_ROOT defaults to $PWD = ~/projects
```

Shortcut: `yarn install-link` runs `yarn install && yarn build && npm link`
in one shot — `npm link` symlinks the global `telegramCode` to this folder, so
later rebuilds (`yarn build`) are picked up without re-installing.

The wrapper looks for env in two places (in order):

1. `~/.config/telegram-code/.env` — base, set once, used everywhere
2. `$PWD/.env` — per-project override

`telegramCode` should normally be launched from your projects parent; that
directory becomes the work root. A single-instance lockfile
(`$DATA_DIR/instance.lock`) prevents a second bot starting under the same
user; cross-user instances are naturally isolated by `HOME`-derived
`DATA_DIR`. Stale locks (after `kill -9`) are reclaimed automatically.

The wrapper also exposes a CLI passthrough so you can continue the same
sessions from a terminal:

```bash
cd ~/projects/myapp && telegramCode cli claude [args...]
```

This is exactly `claude --dangerously-skip-permissions` in `$PWD` — same
binary, same `~/.claude/projects/` session store the bot uses, so a
session started in a Telegram thread can be picked up in the terminal
and vice versa.

### 5. Use it

1. Open the group in Telegram.
2. In the General topic, send `/ls` — bot lists subfolders under `WORK_ROOT`.
3. Create a topic (`+` button).
4. In the new topic: `/bind <subdir>` (auto-bound if the topic name
   matches a subdir).
5. `/claude` or `/opencode` → talk to the agent.
6. `/quit` to end the session; bare `/bind` to inspect the binding;
   `/clear_messages` to delete the topic's bot messages.

## Architecture

```
$PWD=/home/user/src                     ← launch `telegramCode` here
├── projectAlpha/     ← Topic "projectAlpha"    (claude)
├── projectB/         ← Topic "projB-frontend"  (claude)
│                     ← Topic "projB-backend"   (opencode)   ← one folder, two topics
│                     ← Topic "projB-refactor"  (claude)
└── telegramCode/     ← Topic "telegramCode"    (claude)

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
| `/effort` | Set reasoning effort (per-thread) via inline buttons. Claude: native `/effort` levels (`low…ultracode`). OpenCode: the current model's variants, applied per-prompt. No env configuration |
| `/verbosity` | Output-verbosity macro (`minimal\|short\|full`): sets the thinking, tool-results and sub-agent display prefs at once; `/thinking`, `/tool_results`, `/subagent` point-override afterwards. Mixed prefs show as "custom" in the picker |
| `/sessions` | List & resume previous sessions in this folder |
| `/quit`, `/q` | End the session — Claude: graceful double Ctrl+C; OpenCode/terminal: `stopSession` |
| `/new`, `/clear_session` | End the current session and start a fresh one (same adapter) |
| `/status` | This thread's status |
| `/output` | Last 500 lines of agent output |
| `/c`, `/y`, `/n` | Ctrl+C / "y" / "n" |
| `/enter`, `/up`, `/down`, `/tab` | tmux key passthrough |
| `/clear_messages` | Delete bot messages in this topic (up to 48h, Telegram limit) |
| `/clear` | Forwarded to the agent (Claude wipes context; OpenCode plain text) — not a bot command anymore |
| `/bind` | Bare: current binding + folder picker, with «leave current dir» (the old `/unbind`) and «create new folder» buttons |
| `/mcp` | List MCP servers active for this thread |

### In the General topic

| Command | Description |
|---|---|
| `/help` | Context-aware help |
| `/ls` | List subdirs under `WORK_ROOT` |
| `/list` | List existing topics and their bindings |
| `/quit-all`, `/quitall` | End every active agent in every bound topic |
| `/status` | Global view of all topics + active agents |
| `/doctor` | Self-diagnose: admin rights, privacy mode, paths, CLIs |
| `/version` | Versions: bot, claude, opencode, node, tmux |
| `/whoami` | Show userId, chatId, threadId, isAllowed, binding |
| `/pair` | Bind this forum supergroup to the bot (re-point auto-pairing) |

### Natural language

In a bound topic you can also type:
- `claude fix the bug` / `opencode add tests`
- A plain message after `/claude` is already running → routed as input.

Voice messages are transcribed via Groq Whisper (free) or OpenAI Whisper
(fallback) and follow the same routing.

## Environment Variables

### Set Before Launch

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |

Start from the parent folder containing your projects: `cd ~/projects && telegramCode`.
That `$PWD` is the work root; do not set `WORK_ROOT` for normal use.

**Access control.** There is no user allow-list. Whoever is a **creator or
administrator of the served forum group** may talk to the agent — read live from
Telegram (`getChatAdministrators`) and cached for 1h. Promote someone in the
group to grant access; demote/remove them to revoke it — the bot subscribes to
`chat_member` updates, so an admin change invalidates the cache and takes
effect immediately (the 1h TTL is only the fallback). The bot must be a group
admin itself (it already needs that to create topics and pin). Anonymous admins
can't be matched from their messages, so post non-anonymously. The DM surface
(when enabled) is gated separately: only the configured `OWNER_USER_ID` may
talk to the bot there.

> **Security model — group admin (or the DM owner) ⇒ shell on the host.** The agents run with
> permission checks disabled (`--dangerously-skip-permissions` for Claude,
> auto-approve for OpenCode) and `/terminal` opens a raw `$SHELL` in the bound
> folder, so anyone who can talk to the bot can execute arbitrary commands as
> the bot's OS user. Only promote people you would trust with SSH access to
> that machine, and keep the served group itself private.

### External Optional

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_GROUP_ID` | (auto-pair) | Numeric forum supergroup id (`-100…`). Leave empty to auto-pair with the first forum group a group **admin/creator** contacts the bot from (id is saved to `state.json`; re-point with `/pair`). A **name** is not accepted. A numeric value disables auto-pairing |
| `DATA_DIR` | `~/.telegramCode` | Per-instance state. **Mandatory** if you run two bots on the same host — otherwise both share `state.json` and `mcp.json` and corrupt each other |
| `CHAT_MODE` | `both` | Which surface(s) this instance serves: `group`, `dm`, or `both` — see [Two surfaces](#two-surfaces-group-topics-bot-dm-or-both) |
| `OWNER_USER_ID` | — | Numeric Telegram user id of the owner. **Required** for `CHAT_MODE=dm`; optional for `both` (unset → the DM surface stays inert, group-only) |
| `BOT_LANG` | `ru` | `ru` or `en` |
| `GROQ_API_KEY` | — | Recommended for voice transcription. Without it, voice messages are not transcribed unless you intentionally configure the OpenAI fallback |

Agent provider/auth setup is normally done inside the agents themselves:
`claude login` for Claude CLI and OpenCode's own config/plugins for OpenCode.
No provider API key env var is required by the bot for text sessions. For
OpenCode, install any third-party provider plugins or authentication resolvers
before launch if your chosen providers need them.

### Advanced / Not Normally Needed

| Variable | Default | Set only when |
|---|---|---|
| `WORK_ROOT` | `$PWD` | You cannot control the process cwd; normal launch uses `cd <projects-parent> && telegramCode` |
| `OPENCODE_URL` | `http://localhost:4096` | You use a custom OpenCode port or external server; the port must differ per instance |
| `OPENCODE_USERNAME` | `opencode` | `OPENCODE_PASSWORD` is set for a protected OpenCode server |
| `OPENCODE_PASSWORD` | — | Connecting to a protected OpenCode server |
| `OPENCODE_ALLOW_REMOTE` | — | `OPENCODE_URL` intentionally points outside loopback |
| `OPENCODE_BIN` | (auto) | The `opencode` binary is not on PATH or you use a fork |
| `CLAUDE_BIN` | (auto) | The `claude` binary is not on PATH due to nvm/asdf/systemd PATH differences |
| `OPENAI_API_KEY` | — | You intentionally use OpenAI Whisper as the voice fallback instead of Groq |
| `ANTHROPIC_API_KEY` | — | A custom MCP/OpenCode plugin/auth resolver explicitly reads it; not needed for normal Claude CLI auth |
| `SCHEDULER_MCP_PORT` | `4097` | The default collides with another local port, including this instance's `OPENCODE_URL` port |
| `CLAUDE_SCRAPE_DEBUG` | off | You are debugging Claude tmux scraping and need full RAW/FILTERED chunks |

> `WORK_DIR` (1.x) is retired. Use the wrapper from the desired parent folder
> instead of carrying the old env forward.

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
| `SCHEDULER_MCP_PORT` | Scheduler MCP binds a local port inside the same bot process; it must differ from that instance's `OPENCODE_URL` port |

The shipped compose uses OpenCode ports `4096` (pet) and `4097` (work),
with scheduler MCP on `4097` (pet) and `4107` (work). If you run
both as different Linux users with separate Docker networks, the port
isolation is already handled by the network — but keeping ports explicit
is the safer default.

## Updating a deployment (self-update, no root)

`scripts/self-update.sh` refreshes a checkout in place, running as the
checkout's owning user — no root, no cross-user copying. It is safe to run
blindly (e.g. from cron):

- fast-forward only: it skips silently when the tree has tracked changes, a
  merge/rebase is in progress, or local history diverged from the upstream —
  a dev clone that is ahead of origin is never touched;
- `yarn install --immutable` runs only when `yarn.lock` / `package.json`
  changed;
- a hot-mode instance (`telegramCode hot`) rebuilds and restarts the worker
  by itself (after a dependency install the script touches `tsconfig.json`
  so `tsc -w` recompiles with the new modules); a non-hot instance gets
  `yarn build` plus a restart notice — the script never kills processes;
- changes to the hot supervisor itself (`src/cli.ts`, `src/cli/hot.ts`,
  `nodemon.json`) are flagged with a warning: those need a manual
  `telegramCode hot` restart (nodemon reloads only the worker).

For unattended updates give the deploying user read access to the repo (e.g.
a read-only GitLab deploy key on a passphrase-less SSH key) and add a cron
entry:

```cron
*/10 * * * * /path/to/telegram-code/scripts/self-update.sh >> "$HOME/.local/state/telegram-code/self-update.log" 2>&1
```

(create the log directory once: `mkdir -p ~/.local/state/telegram-code`).

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

If you run the bot under `systemd`/`systemd-run`, set `KillMode=process`.
The default `control-group` mode kills tmux and `opencode serve` children,
which defeats restart/reattach. Process restarts intentionally leave agent
sessions alive; use `/quit` or `/quit-all` when you want to terminate them.

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

### "Missing right" / `/clear_messages` does nothing

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
3. Remove the old `WORK_DIR` env and launch from the projects parent:
   `cd /home/user/src && telegramCode`.
4. Leave `ALLOWED_GROUP_ID` empty to auto-pair on first contact (or set
   the numeric id by hand).
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
