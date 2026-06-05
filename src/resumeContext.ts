import { t } from './i18n';
import { stripThreadContextPreamble } from './threadContextPreamble';
import type { RecentTurn } from './types';

/**
 * @description How many recent conversational turns the resume context block
 * shows. Tunable: raising it shows more history, lowering it shows less. Kept
 * small so resuming a long session does not re-flood the topic — this turn
 * count is the only flood bound (each turn is rendered in full; the bot's
 * message-splitting handles turns longer than the Telegram cap).
 */
export const resumeContextTurnLimit = 3;

/**
 * @description Render the short resume context block from the last conversational
 * turns of a resumed session. `turns` must already be chronological
 * (oldest→newest) and capped to {@link resumeContextTurnLimit} by the caller
 * (the adapter's `getRecentTurns`).
 *
 * Output is a localized header (with the turn count) followed by one
 * role-labeled line block per turn, each rendered in FULL — the user expects
 * the complete last messages, and the bot's message-splitting path
 * (`getOutputFlushPlan` → `splitMessage`) chunks a block over the Telegram cap.
 * Returns `null` when there are no turns (brand-new / pruned-history session)
 * so the caller emits nothing extra.
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
    // Stored user prompts include the forwarded "[Telegram thread context]"
    // glue — service noise when shown back to the user, so strip it.
    const visibleText = turn.role === 'user' ? stripThreadContextPreamble(turn.text) : turn.text;
    return `${label} ${visibleText}`;
  });

  return [header, ...renderedTurns].join('\n\n');
}
