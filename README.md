<table border="0">
  <tr>
    <td><h2> Telegram bot server for interacting with Claude CLI via tmux session</h2>

### Features

- Run Claude CLI through Telegram messages
- Voice messages support (transcription via Groq/OpenAI Whisper)
- Auto-accept bypass permissions dialog
- Auto-press Enter for login prompts
- Filter TUI elements (status line, input field, spinners, thinking indicators)
- Message update instead of spam (edit in place)
- Inline buttons for numbered options
    </td>
<td width="280"><img src="./demo.gif" width="320" /></td>
  </tr>
</table>

## How It Works

### Architecture

```
Telegram <-> Bot (Node.js) <-> tmux session <-> Claude CLI
```

1. **Bot** runs as Node.js process, connects to Telegram via long polling
2. **Claude CLI** runs inside a tmux session (one per user)
3. **Polling** every 300ms captures tmux pane content and detects changes
4. **Output** is filtered (TUI elements removed) and sent to Telegram

### Key Components

- `bot.ts` - Telegram bot logic, message handling, output queue
- `claudeManager.ts` - tmux session management, output polling, TUI filtering

## Development

### No Build Required

The project runs directly from TypeScript sources using `ts-node` or `tsx`. Changes to `.ts` files take effect after container restart - no build step needed.

```bash
# Restart to apply changes
docker compose restart telegram-code

# Or full recreate if restart doesn't help
docker compose down telegram-code && docker compose up -d telegram-code
```

### Local Development

```bash
yarn dev  # Uses tsx watch for hot reload
```

### Scripts

- `yarn dev` - Development with hot reload (tsx watch)
- `yarn build` - Compile TypeScript to dist/ (only needed for standalone deployment)
- `yarn start` - Run compiled version from dist/
- `yarn typecheck` - Type check without emitting

## Message Update Logic

When Claude produces output:
1. If user hasn't sent anything yet - create a new message
2. If user sent input - create a new message for the response
3. Otherwise - update the existing message (edit in place)

This prevents spam when Claude is "thinking" and producing multiple small updates.

### How It Works Internally

The bot tracks a `needsNewMessage` flag per user:
- Set to `true` when user sends any input (text, voice, button click, commands)
- Set to `false` after sending a new message
- When `true` or no previous message exists - send new message
- When `false` - edit existing message

### Race Condition Prevention

The bot uses a queue-based approach with debouncing to handle rapid output updates:
- Multiple outputs arriving within 150ms are batched into a single update
- Only one Telegram API call is in flight at a time per user
- If new output arrives while sending, it's queued and processed after current send completes

This prevents multiple new messages being created when Claude produces rapid updates.

## TUI Filtering

The following TUI elements are stripped from output before sending to Telegram:

| Element | Example | Why Filtered |
|---------|---------|--------------|
| Status line | `⏵⏵ bypass permissions on` | UI chrome |
| Input borders | `────────────────────────` | UI chrome |
| Input prompt | `❯ ` | Not useful in Telegram |
| Tab hints | `❯ push to origin ... ↵ send` | UI chrome |
| Spinner-only lines | `·✽✢✶✻` | Animation artifacts |
| Thinking indicators | `✽ Discombobulating… (thinking)` | Transient state |

Tool calls (Bash, Read, Write, etc.) are preserved and normalized with status icons:
- `⏳` - tool running
- `✓` - tool completed

## Commands

| Command | Description |
|---------|-------------|
| `/claude` | Start Claude session (optionally with args: `/claude --resume`) |
| `/stop` | Stop Claude session |
| `/status` | Show current status |
| `/output` | Show last 500 lines of raw output |
| `/c` | Send Ctrl+C (interrupt) |
| `/y` | Send "y" (yes) |
| `/n` | Send "n" (no) |
| `/enter` | Press Enter |
| `/up` | Arrow Up |
| `/down` | Arrow Down |
| `/tab` | Tab (autocomplete) |
| `/clear` | Delete chat messages |

### Natural Language Start

You can also start Claude by typing phrases like:
- "claude", "клод", "клауд"
- "claude fix the bug" (starts with initial prompt)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `ALLOWED_USERS` | Yes | Comma-separated Telegram user IDs |
| `WORK_DIR` | No | Working directory (default: `/workspace`) |
| `GROQ_API_KEY` | No | For voice transcription (free, preferred) |
| `OPENAI_API_KEY` | No | For voice transcription (fallback) |

## Running with Docker

```bash
docker compose up -d telegram-code
```

### Expected Behavior

When everything works correctly:
1. Send a message to the bot
2. Bot shows `⏳` processing indicator
3. Claude processes your request
4. Bot updates the **same message** with Claude's response as it streams
5. When you send another message, a **new message** is created for the response
6. Subsequent updates edit that new message

### Troubleshooting

**Multiple messages appearing instead of updates:**
- Check container logs for errors
- Restart container: `docker compose restart telegram-code`
- Verify the queue logic is working (look for `[Bot] output` logs)

**Voice messages not working:**
- Set `GROQ_API_KEY` (free) or `OPENAI_API_KEY`
- Check logs for transcription errors

**Claude not responding:**
- Check if tmux session exists: `docker exec telegram-code-bot tmux list-sessions`
- Check Claude CLI is installed in container
- Verify `WORK_DIR` path exists and is accessible
