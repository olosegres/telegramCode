import { t } from './i18n';
import type { RecentTurn } from './types';

/**
 * @description How many recent conversational turns the resume context block
 * shows. Tunable: raising it shows more history, lowering it shows less. Kept
 * small so resuming a long session does not re-flood the topic.
 */
export const resumeContextTurnLimit = 3;

/**
 * @description Per-turn character cap for the resume context block. A single
 * huge old assistant message could itself re-flood the topic, so each rendered
 * turn is truncated to this many characters (ending with `…`). There is no
 * total cap — the existing message-splitting handles three genuinely long
 * turns; this cap only stops one runaway message.
 */
export const resumeContextTurnCharCap = 500;

/** Appended to a turn whose text was cut at {@link resumeContextTurnCharCap}. */
const truncationEllipsis = '…';

/**
 * @description Truncate `text` to {@link resumeContextTurnCharCap}, appending
 * an ellipsis when it was actually cut. Trims trailing whitespace before the
 * ellipsis so the cut never reads as "word …".
 */
function getTruncatedTurnText(text: string): string {
  if (text.length <= resumeContextTurnCharCap) return text;
  return text.slice(0, resumeContextTurnCharCap).trimEnd() + truncationEllipsis;
}

/**
 * @description Render the short resume context block from the last conversational
 * turns of a resumed session. `turns` must already be chronological
 * (oldest→newest) and capped to {@link resumeContextTurnLimit} by the caller
 * (the adapter's `getRecentTurns`).
 *
 * Output is a localized header (with the turn count) followed by one
 * role-labeled line block per turn, each truncated to
 * {@link resumeContextTurnCharCap}. Returns `null` when there are no turns
 * (brand-new / pruned-history session) so the caller emits nothing extra.
 *
 * Pure (only reads i18n, no I/O) so it is unit-testable without a live backend.
 */
export function formatResumeContext(turns: RecentTurn[]): string | null {
  if (turns.length === 0) return null;

  const header = t('resume.context_header', { count: turns.length });
  const userLabel = t('resume.context_user_label');
  const assistantLabel = t('resume.context_assistant_label');

  const renderedTurns = turns.map((turn) => {
    const label = turn.role === 'user' ? userLabel : assistantLabel;
    return `${label} ${getTruncatedTurnText(turn.text)}`;
  });

  return [header, ...renderedTurns].join('\n\n');
}
