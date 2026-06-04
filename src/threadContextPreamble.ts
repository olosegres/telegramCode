/**
 * @description Builds the "[Telegram thread context]" preamble the bot glues
 * ahead of a forwarded prompt so the agent knows WHERE it works — which forum
 * topic, in which group, under which thread key, and which bound folder.
 *
 * The preamble is plain English (agent-facing, NOT i18n) and uniform across
 * both backends: the bot just prepends it to the prompt text in
 * `forwardPromptToAgent`, the single choke point for direct texts,
 * startup-buffer replays, and voice transcripts.
 *
 * It is re-injected on the next prompt whenever the built text differs from
 * the per-thread marker the bot last sent — which happens on a fresh
 * session (marker cleared on start/stop/closed), after a topic rename
 * (stored name changed), or after `/clear` (marker reset). See the
 * should-inject decision below.
 */

import { keyToString, type ThreadKey } from './types';

/** First line of every preamble — the agent-recognisable marker. */
export const threadContextPreambleHeader = '[Telegram thread context]';

/**
 * @description Inputs needed to render the preamble. `topicName` and
 * `groupTitle` are optional because the Bot API can't always supply them
 * (pre-existing topics have no learned name; the group title cache is empty
 * until the first authorised update after a restart).
 */
export interface ThreadContextPreambleInput {
  /** Forum-topic display name, when known. */
  topicName?: string;
  /** Group (supergroup) title, when known. */
  groupTitle?: string;
  /** The thread key — its `chatId:threadId` form is exposed to the agent. */
  key: ThreadKey;
  /** Bound subfolder under `WORK_ROOT`. */
  subdir: string;
}

/**
 * @description Render the preamble block. Always includes the `thread:` /
 * `folder:` line; the `topic:` / `group:` line is included only when at
 * least one of those two fields is known (the topic name is dropped when
 * unknown, per the locked decision).
 *
 * Returns a multi-line string WITHOUT a trailing prompt — the caller joins
 * it to the user's text with a blank-line separator.
 */
export function buildThreadContextPreamble(input: ThreadContextPreambleInput): string {
  const { topicName, groupTitle, key, subdir } = input;
  const lines: string[] = [threadContextPreambleHeader];

  const identityParts: string[] = [];
  if (topicName) identityParts.push(`topic: "${topicName}"`);
  if (groupTitle) identityParts.push(`group: "${groupTitle}"`);
  if (identityParts.length > 0) lines.push(identityParts.join(' | '));

  lines.push(`thread: ${keyToString(key)} | folder: ${subdir}`);
  return lines.join('\n');
}

/**
 * @description Whether the forwarded text must NOT get a preamble glued on.
 * Slash commands forwarded to the agent (`/clear`, `/compact`, …) are plain
 * control tokens — prepending the preamble would corrupt them into ordinary
 * text the agent can't act on. The preamble rides only normal prompts.
 */
export function checkShouldSkipPreambleForText(text: string): boolean {
  return text.startsWith('/');
}

/** Separator between the preamble block and the user's prompt text. */
const preamblePromptSeparator = '\n\n';

/**
 * @description Glue a freshly-built preamble ahead of the user's prompt.
 */
export function prependThreadContextPreamble(preamble: string, prompt: string): string {
  return `${preamble}${preamblePromptSeparator}${prompt}`;
}

/**
 * @description Decide whether the preamble must ride the next prompt.
 *
 * The bot keeps an in-memory marker (the last preamble it injected for a
 * thread). We inject when the freshly-built preamble differs from the
 * marker — a missing marker (fresh session, post-`/clear` reset) always
 * differs, and a rename / late group-title discovery changes the built text
 * so it differs too. Identical text means the agent already has up-to-date
 * context this session, so we skip to avoid noise.
 */
export function checkShouldInjectPreamble(
  builtPreamble: string,
  lastInjectedMarker: string | undefined,
): boolean {
  return builtPreamble !== lastInjectedMarker;
}

/**
 * @description Strip a leading preamble block from a stored prompt text.
 *
 * Backend transcripts store the prompt AS FORWARDED — preamble included. When
 * such a turn is shown back to the user (e.g. the "↩️ Resumed — last N
 * messages" context block), the service header is noise: the user wants to
 * see what THEY said, not the bot's glue. The preamble is everything from the
 * marker header up to the first blank line (see
 * {@link prependThreadContextPreamble}).
 */
export function stripThreadContextPreamble(text: string): string {
  if (!text.startsWith(threadContextPreambleHeader)) return text;
  const separatorIndex = text.indexOf(preamblePromptSeparator);
  if (separatorIndex === -1) return text;
  return text.slice(separatorIndex + preamblePromptSeparator.length);
}
