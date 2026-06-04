/**
 * Pure helpers for naming bot-created OpenCode sessions.
 *
 * Primary mechanism (R1, verified live 2026-06-04): a session created WITHOUT
 * an explicit `title` lets opencode auto-name it from the first prompt's LLM
 * turn — nicer than any raw snippet, and it ignores the glued thread-context
 * preamble. A session created WITH a title is treated as user-set and never
 * auto-renamed, so the bot only passes a title for the explicit `/opencode
 * <args>` case.
 *
 * Fallback mechanism: if auto-title never lands (the title stays the bare
 * `New session - <ts>` placeholder — e.g. the server failed to generate one),
 * the adapter renames the session itself via `PATCH /session/:id {title}` on
 * the first MEANINGFUL prompt, using {@link buildSessionTitleSnippet}. The
 * snippet always derives from the RAW user text (the caller strips the
 * preamble first), so it can never carry the service header.
 */

import { stripThreadContextPreamble } from './threadContextPreamble';

/**
 * Minimum length (chars, after trim) for a prompt to count as "meaningful"
 * enough to name a session after. Short acknowledgements ("да", "go", "ok")
 * sit below it and leave the name to be decided by a later, substantial
 * prompt. 10 is the locked value from the plan's IDEAL.
 */
export const meaningfulPromptMinLength = 10;

/** Max length (chars) of a fallback snippet title; longer text is truncated. */
export const sessionTitleSnippetMaxLength = 60;

/** Marker appended when a snippet is truncated, so the cut is visible. */
const truncationEllipsis = '…';

/**
 * Placeholder titles opencode assigns to a session that has no real name yet:
 * the `New session - <ISO timestamp>` form (untitled create) and the legacy
 * `Telegram session <key>` the bot used to set. A title matching either is
 * "not yet meaningfully named", so the fallback rename may overwrite it; any
 * other title is a real name (auto-generated or user-set) and is left alone.
 */
const untitledPlaceholderPrefix = 'New session - ';
const legacyBotTitlePrefix = 'Telegram session ';

/**
 * @description Whether a forwarded prompt is substantial enough to name a
 * session after. A slash command (`/clear`, `/model …`) is a control token,
 * never a name source; anything shorter than {@link meaningfulPromptMinLength}
 * is a throwaway acknowledgement. The argument MUST be the RAW user text —
 * strip the thread-context preamble before calling (see
 * {@link buildSessionTitleSnippet} for the same requirement).
 */
export function checkIsMeaningfulPrompt(rawText: string): boolean {
  const trimmed = rawText.trim();
  if (trimmed.startsWith('/')) return false;
  return trimmed.length >= meaningfulPromptMinLength;
}

/**
 * @description Build a fallback session-title snippet from the first
 * meaningful prompt. Collapses all internal whitespace (incl. newlines) to
 * single spaces, trims, and truncates to {@link sessionTitleSnippetMaxLength}
 * with an ellipsis. The thread-context preamble is stripped first so the title
 * reflects what the USER said, never the bot's glue.
 */
export function buildSessionTitleSnippet(rawText: string): string {
  const withoutPreamble = stripThreadContextPreamble(rawText);
  const collapsed = withoutPreamble.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= sessionTitleSnippetMaxLength) return collapsed;
  // Reserve one char for the ellipsis so the result never exceeds the cap.
  return collapsed.slice(0, sessionTitleSnippetMaxLength - 1).trimEnd() + truncationEllipsis;
}

/**
 * @description Whether `title` is one of opencode's "no real name yet"
 * placeholders, so the fallback rename is allowed to overwrite it. A real
 * auto-generated or user-set title returns `false` and is left untouched.
 */
export function checkIsPlaceholderTitle(title: string | undefined): boolean {
  if (!title) return true;
  return title.startsWith(untitledPlaceholderPrefix) || title.startsWith(legacyBotTitlePrefix);
}
