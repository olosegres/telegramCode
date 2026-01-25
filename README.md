# Telegram Claude Bot

Telegram bot for interacting with Claude CLI via tmux session.

## Features

- Run Claude CLI through Telegram messages
- Auto-accept bypass permissions dialog
- Auto-press Enter for login prompts
- Filter TUI elements (status line, input field, spinners)
- Message update instead of spam (see below)

## Message Update Logic

When Claude produces output:
1. If user hasn't sent anything yet - create a new message
2. If user sent input - create a new message for the response
3. Otherwise - update the existing message (edit in place)

This prevents spam when Claude is "thinking" and producing multiple small updates.

The bot tracks a "needsNewMessage" flag per user:
- Set to `true` when user sends any input (text, button click, commands)
- Set to `false` after sending a new message
- When `true` or no previous message exists - send new message
- When `false` - edit existing message

## TUI Filtering

The following TUI elements are stripped from output:
- Status line: `⏵⏵ bypass permissions on (shift+tab to cycle)`
- Input field borders: `────────────────────────`
- Empty input prompt: `❯ `
- Tab completion hints: `❯ push to origin ... ↵ send`
- Spinner characters: `·✽✢✶`

## Commands

- `/claude` - Start Claude session
- `/stop` - Stop Claude session
- `/status` - Show current status
- `/c` - Send Ctrl+C (interrupt)
- `/y` - Send "y" (yes)
- `/n` - Send "n" (no)
- `/clear` - Delete configuration

## Environment Variables

- `TELEGRAM_BOT_TOKEN` - Telegram bot token
- `ALLOWED_USERS` - Comma-separated list of allowed Telegram user IDs
- `WORK_DIR` - Working directory (default: `/workspace`)

## Running with Docker

```bash
docker compose up -d telegram-code
```
