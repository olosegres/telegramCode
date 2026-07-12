# Migrating from 1.x to 2.0

The 1.x "one bot = one private chat = one folder" mode is **removed**.
There is no in-place upgrade; the steps are:

1. Stop the old bot.
2. Create a forum supergroup, add the bot, follow [Quick Start §3](README.md#3-set-up-a-group-optional-or-dm).
3. Remove the old `WORK_DIR` env and launch from the projects parent:
   `cd /home/user/src && telegramcode`.
4. Leave `ALLOWED_GROUP_ID` empty to auto-pair on first contact (or set
   the numeric id by hand).
5. Set `DATA_DIR` if you run two instances on the same host.
6. The old `~/.telegram-bot-messages.json` is moved to `.bak` on first
   start — no migration of message ids, fresh `state.json`.

## Release notes

- Routing key is `(chatId, threadId)`, persisted in `state.json`.
- tmux sessions renamed `claude-${chatId}-${threadId}` (the tmux-scrape
  backend; the json-stream host uses the `cjson-` prefix, terminal `term-`).
- `claude --session-id <uuid>` is hardcoded — no more interactive picker.
- `--dangerously-skip-permissions` is hardcoded (symmetry with
  opencode's auto-approve).
- Privacy mode must be disabled and the bot re-added.
