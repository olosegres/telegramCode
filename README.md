<table border="0">
  <tr>
    <td><h2>Bot for communicating with AI agents through Telegram</h2>

### Features

- Multiple AI backends: Claude Code, OpenCode
- Switch between agents on the fly (`/agent`)
- Model selection with dynamic list (`/model`)
- Voice messages (transcription via Groq/OpenAI Whisper)
- Session history and resume (`/sessions`)
- Message update instead of spam (edit in place)
- Auto-install tools on first use
    </td>
<td width="280"><img src="./demo.gif" width="320" /></td>
  </tr>
</table>

## Quick Start

### 1. Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow prompts
3. Copy the bot token (looks like `123456789:ABCdef...`)

### 2. Get Your Telegram User ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. It will reply with your user ID (a number like `123456789`)

### 3. Run with Docker

Create a `docker-compose.yml`:

```yaml
services:
  telegram-code:
    image: node:20
    volumes:
      # Your project directory
      - ./my-project:/workspace:rw
      # Persist npm global installs (claude, opencode)
      - telegram-code-npm:/home/agent/.npm-global
      # Host configs for git
      - ~/.gitconfig:/home/agent/.gitconfig:ro
      - ~/.ssh:/home/agent/.ssh:ro
    environment:
      - HOME=/home/agent
      - TELEGRAM_BOT_TOKEN=your-bot-token-here
      - ALLOWED_USERS=your-telegram-id
      - WORK_DIR=/workspace
      # Optional: voice transcription
      - GROQ_API_KEY=your-groq-key
      # Optional: for Claude (or set in container)
      - ANTHROPIC_API_KEY=your-anthropic-key
    working_dir: /workspace
    command: npx -y telegram-code-bot
    restart: unless-stopped

volumes:
  telegram-code-npm:
```

```bash
docker compose up -d
```

### Alternative: Run without Docker

Docker is recommended for environment isolation, but you can run directly:

```bash
# Prerequisites: Node.js 20+, tmux (for Claude CLI)

# Clone and install
git clone https://github.com/anthropics/telegram-code-bot
cd telegram-code-bot
yarn install

# Set environment variables
export TELEGRAM_BOT_TOKEN=your-bot-token
export ALLOWED_USERS=your-telegram-id
export WORK_DIR=/path/to/your/project
export ANTHROPIC_API_KEY=your-key  # for Claude

# Run
yarn start
```

Note: When running without Docker, ensure `claude` and/or `opencode` CLI tools are installed and available in PATH.

### 4. Start Using

1. Open your bot in Telegram
2. Send `/claude` or `/opencode` to start a session
3. Send your coding request
4. Use `/stop` when done

## Supported Agents

| Agent | Command | Description |
|-------|---------|-------------|
| Claude Code | `/claude` | Anthropic's Claude Code CLI (tmux-based) |
| OpenCode | `/opencode` or `/oc` | OpenCode AI agent (HTTP API) |

Switch agents anytime with `/agent` command.

## Commands

| Command | Description |
|---------|-------------|
| `/claude` | Start Claude Code session |
| `/opencode` | Start OpenCode session |
| `/agent` | Choose agent (shows buttons) |
| `/model` | Switch model (shows numbered list) |
| `/sessions` | Show previous sessions to resume |
| `/stop` | Stop current session |
| `/status` | Show current status |
| `/output` | Show last 500 lines of output |
| `/c` | Send Ctrl+C (interrupt) |
| `/y` | Send "y" (yes) |
| `/n` | Send "n" (no) |
| `/enter` | Press Enter |
| `/up` / `/down` | Arrow keys |
| `/tab` | Tab (autocomplete) |
| `/clear` | Delete chat messages |

### Natural Language Start

Start agents by typing phrases like:
- "claude", "claude fix the bug"
- "opencode", "opencode add tests"

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | From @BotFather |
| `ALLOWED_USERS` | Yes | Comma-separated Telegram user IDs |
| `WORK_DIR` | No | Working directory (default: `/workspace`) |
| `DEFAULT_AGENT` | No | Default agent: `claude` or `opencode` |
| `GROQ_API_KEY` | No | Voice transcription (free, preferred) |
| `OPENAI_API_KEY` | No | Voice transcription (fallback) |
| `ANTHROPIC_API_KEY` | No | For Claude Code |
| `OPENCODE_URL` | No | OpenCode server URL (default: `http://localhost:4096`) |
| `OPENCODE_BIN` | No | Custom opencode binary path |

## Architecture

```
Telegram <-> Bot (Node.js) <-> Adapter <-> AI Agent
                                  |
                                  +-> Claude CLI (via tmux)
                                  +-> OpenCode (via HTTP API)
```

### Adapter Pattern

Each AI backend implements the `AgentAdapter` interface:
- `startSession()` / `stopSession()` - lifecycle
- `sendInput()` / `sendSignal()` - communication
- `setModel()` / `getAvailableModels()` - model selection
- Events: `output`, `closed`, `error`

### Key Files

- `src/bot.ts` - Telegram bot, commands, message handling
- `src/adapters/` - Agent adapters (Claude CLI, OpenCode)
- `src/types.ts` - AgentAdapter interface
- `src/rateLimiter.ts` - Telegram API rate limit handling
- `src/installManager.ts` - Auto-install tools

## Development

### Local Development

```bash
yarn install
yarn dev  # Uses tsx watch for hot reload
```

### Docker Development

```bash
# Restart to apply changes
docker compose restart telegram-code

# Full recreate
docker compose down telegram-code && docker compose up -d telegram-code
```

### Scripts

- `yarn dev` - Development with hot reload
- `yarn build` - Compile TypeScript
- `yarn start` - Run compiled version
- `yarn typecheck` - Type check

## How It Works

### Message Updates

The bot edits messages in place instead of spamming:
1. User sends input -> new message created for response
2. AI produces output -> same message is updated
3. Rapid updates are debounced (1s batching)

### Rate Limit Handling

Telegram API rate limits (429) are handled automatically:
- Waits for `retry_after` + jitter
- Retries once, then marks user as rate-limited
- Skips sends during cooldown period

### TUI Filtering (Claude CLI)

Claude CLI TUI elements are stripped from output:
- Status lines, borders, spinners
- Tool calls are preserved with status icons (`⏳` running, `✓` done)

## Troubleshooting

**Bot not responding:**
- Check `TELEGRAM_BOT_TOKEN` is correct
- Verify your user ID is in `ALLOWED_USERS`
- Check container logs: `docker compose logs telegram-code`

**Voice messages not working:**
- Set `GROQ_API_KEY` (free) or `OPENAI_API_KEY`

**Claude not starting:**
- Check `ANTHROPIC_API_KEY` is set
- Verify tmux is installed in container

**OpenCode not starting:**
- Check if server is running: `/status`
- OpenCode auto-starts on first use

## License

MIT
