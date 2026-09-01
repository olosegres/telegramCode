/** Return the signal's Error reason, including a stable fallback for non-Error reasons. */
export function getAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** Sleep for the requested duration, rejecting promptly when the caller aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(getAbortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);
    const handleAbort = () => {
      clearTimeout(timer);
      if (signal) reject(getAbortError(signal));
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
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
