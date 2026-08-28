# Development

Architecture and local-development notes for TelegramCode. User-facing setup
lives in the [README](README.md); for a deep dive into every module and
behavior, see [`CLAUDE.md`](CLAUDE.md).

## Architecture

The per-topic folder layout is in the README under
[Required files structure](README.md#required-files-structure).

Routing key is `(chatId, threadId)` everywhere. Per-thread state lives in
`${DATA_DIR}/state.json` (atomic writes with `fsync`, archived on
corruption). Bot-owned tmux sessions are named per backend —
`claude-<chatId>-<threadId>` (Claude tmux-scrape), `cjson-…` (the Claude
json-stream host process), `term-…` (terminal) — see
`src/utils/tmuxSessionName.ts`; opencode sessions are keyed by the same
`<chatId>:<threadId>` string. Two topics on the same folder stay independent.

### Adapter pattern

```
Telegram <-> bot.ts <-> AgentAdapter <-> { Claude CLI (tmux scrape) | Claude CLI (stream-json) |
                 │           │             OpenCode (HTTP+SSE)      | Terminal ($SHELL in tmux) }
                 │           └── state.ts  (bindings, claudeSessionId, opencodeSessionId,
                 │                          messages, MCP per-thread overrides)
                 └── OutputTransport (src/output/) — how output reaches each surface,
                     picked once at boot by CHAT_MODE: group edit-in-place stream
                     vs the owner-DM native draft "cursor"
```

Each adapter implements `AgentAdapter` from `src/types.ts`:
- `startSession(key, workDir, args?, sessionId?)` / `stopSession(key)` / `resumeSession(key, workDir, sessionId, options?)`
- `sendInput(key, text)` / `sendSignal(key, signal)`
- events: `output`, `status`, `question`, `questionGone`, `thinking`,
  `toolResult`, `subagentStatus`, `apiError`, `started`, `stopped`, `closed`,
  `error` (all emit `ThreadKey` first)

## Local development

```bash
yarn install
yarn dev          # tsx watch (fast dev — TS errors crash the process)
yarn typecheck    # strict tsc --noEmit
yarn build        # tsc → dist/
yarn test         # unit/integration (node test runner + tsx); build first —
                  # some tests exercise the built dist/cli.js
yarn hot          # hot-reload mode: tsc -w + nodemon on dist/ (also
                   # `telegramcode hot` from anywhere) — a broken edit can't
                   # take the bot down; OpenCode generations stay outside the
                   # worker tree, so agent turns survive worker reloads
                   # (Linux/macOS; Windows hot mode is intentionally refused)
```

The Docker dev loop (never `docker compose restart` — it ignores
`depends_on`):

```bash
docker compose down telegramcode-pet && docker compose up -d telegramcode-pet
docker compose logs -f telegramcode-pet     # tail logs
```
