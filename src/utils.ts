export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @description Strip the `@botusername` Telegram appends to a slash command in
 * a group/supergroup.
 *
 * In groups, the Telegram client turns `/compact` into
 * `/compact@my_bot` (always, when the command is in the bot's command menu;
 * also whenever multiple bots are present). We forward un-owned slash commands
 * verbatim to the agent's CLI, which does NOT recognise the `@my_bot` suffix —
 * so `/compact` silently no-ops. Strip the mention from the FIRST token only,
 * preserving any arguments: `/compact@my_bot keep notes` → `/compact keep notes`.
 *
 * Only touches a leading `/command@mention`; ordinary text and mid-text `@`s
 * (e.g. `email me @ foo`) are left untouched. Pure + exported for unit tests.
 */
export function stripCommandBotMention(text: string): string {
  return text.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+/, '$1');
}
