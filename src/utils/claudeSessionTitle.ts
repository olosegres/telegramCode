/**
 * @description Derive a human-readable title for a Claude session from its
 * stored user prompts, so the `/sessions` picker shows the session's TOPIC
 * instead of noise.
 *
 * Why this exists: current Claude Code (2.1.201) no longer writes the
 * LLM-generated `type:"summary"` line the old picker relied on, so
 * {@link listClaudeSessionsForWorkDir} always fell back to the LAST stored
 * prompt — which for bot-driven sessions is almost always garbage (the
 * `[Telegram thread context]` preamble, a `/effort` command echo, a
 * `<task-notification>`, or a bare `yes`/`commit`/`...`). We instead pick the
 * FIRST *meaningful* prompt: preamble/marker stripped, tooling noise skipped.
 *
 * Pure (string-in, string-out) so it is unit-tested in isolation.
 */

import { stripThreadContextPreamble } from '../threadContextPreamble';

/**
 * @description Leading `[Scheduled run "<name>"]` marker a scheduled run glues
 * ahead of its prompt (see `scheduler/delivery.ts`). Anchored + single `\n`,
 * matching how it is written.
 */
const scheduledRunMarkerRe = /^\[Scheduled run "[^"]*"\]\n/;

/**
 * @description Prompt prefixes that mark a stored user turn as bot/tooling
 * plumbing rather than a real topic — never a session title. Matched after the
 * preamble/marker is stripped and whitespace collapsed.
 */
const noisePromptPrefixes = [
  '[Telegram thread context]', // a preamble with no prompt after it (strip failed)
  '[Telegram file]',
  '[Telegram album]',
  '[Request interrupted',
  '<local-command-', // stdout / stderr / caveat wrappers around a slash command
  '<command-',
  '<task-notification>',
  '<system-reminder>',
  '<tool-use-',
  'Base directory for this skill:',
  'Caveat: The messages below',
];

/**
 * @description Whole-prompt values that are follow-up chatter, never a topic:
 * bare affirmations / short control words (RU + EN) and the "continue" dots.
 */
const noiseExactPrompts = new Set([
  '...', '..', '.', 'yes', 'no', 'ok', 'okay', 'y', 'n', 'go', 'go ahead',
  'да', 'нет', 'ага', 'угу', 'давай', 'да, давай', 'да, давай.',
  'commit', 'commit.', 'push', 'пуш', 'коммить', 'коммит', 'обнови my',
]);

/** Effort / model slash-command stdout that lost its `<local-command-*>` wrapper. */
const commandEchoRe = /^set (effort level|model) /i;

/**
 * @description Strip the bot's service wrappers (thread-context preamble first —
 * it is the outermost, then the scheduled-run marker) off a stored prompt and
 * collapse it to a single display line. No noise filtering — the raw topic line.
 */
export function getSessionTitleLine(rawPrompt: string): string {
  let text = rawPrompt.trim();
  text = stripThreadContextPreamble(text);
  text = text.replace(scheduledRunMarkerRe, '');
  return text.replace(/\s+/g, ' ').trim();
}

/** @description Whether a stripped single-line prompt is tooling noise, not a topic. */
function checkIsNoisePrompt(line: string): boolean {
  const lower = line.toLowerCase();
  if (noiseExactPrompts.has(lower)) return true;
  if (/^\.+$/.test(line)) return true; // pure dots ("continue" signal)
  if (commandEchoRe.test(line)) return true;
  return noisePromptPrefixes.some(prefix => line.startsWith(prefix));
}

/**
 * @description A session-title candidate from ONE stored prompt: the stripped
 * single-line topic, or `null` when the prompt is empty or tooling noise.
 */
export function getSessionTitleCandidate(rawPrompt: string): string | null {
  const line = getSessionTitleLine(rawPrompt);
  if (!line) return null;
  if (checkIsNoisePrompt(line)) return null;
  return line;
}
