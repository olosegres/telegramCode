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
 * @description Render the last conversational turns as role-labeled blocks, each
 * in FULL (no per-turn truncation — the bot's message-splitting handles over-cap
 * blocks). Shared by {@link formatResumeContext} (the `/sessions` resume block)
 * and {@link formatReattachRecap} (the silent-reattach recap) so the turn body
 * looks identical in both. `turns` must be chronological (oldest→newest).
 *
 * Pure (only reads i18n) — the stored user prompts carry the forwarded
 * "[Telegram thread context]" glue, which is service noise when shown back, so
 * it is stripped from user turns only (assistant text is never touched).
 */
export function renderTurns(turns: RecentTurn[]): string[] {
  const userLabel = t('resume.context_user_label');
  const assistantLabel = t('resume.context_assistant_label');
  return turns.map((turn) => {
    const label = turn.role === 'user' ? userLabel : assistantLabel;
    const visibleText = turn.role === 'user' ? stripThreadContextPreamble(turn.text) : turn.text;
    return `${label} ${visibleText}`;
  });
}

/**
 * @description Render the short resume context block from the last conversational
 * turns of a resumed session. `turns` must already be chronological
 * (oldest→newest) and capped to {@link resumeContextTurnLimit} by the caller
 * (the adapter's `getRecentTurns`).
 *
 * Output is a localized header (with the turn count) followed by the
 * role-labeled turn blocks from {@link renderTurns}, each rendered in FULL — the
 * user expects the complete last messages, and the bot's message-splitting path
 * (`getOutputFlushPlan` → `splitMessage`) chunks a block over the Telegram cap.
 * Returns `null` when there are no turns (brand-new / pruned-history session)
 * so the caller emits nothing extra.
 *
 * Pure (only reads i18n, no I/O) so it is unit-testable without a live backend.
 */
export function formatResumeContext(turns: RecentTurn[]): string | null {
  if (turns.length === 0) return null;

  const header = t('resume.context_header', { count: turns.length });
  return [header, ...renderTurns(turns)].join('\n\n');
}

/**
 * @description Anti-spam gate for the silent-reattach recap. Decides whether
 * {@link formatReattachRecap}'s output should actually be posted, given the boot
 * mode. Two trigger paths:
 *
 * - **Known missed output** (`missedCount > 0`) → ALWAYS post: the agent produced
 *   messages the user never saw, regardless of whether the gap was a hot reload
 *   or a cold start. Recovering them is the whole point.
 * - **Fallback** (watermark unknown but there ARE turns) → post ONLY on a COLD
 *   start. On a hot reload (sub-second blink) nothing was actually missed, so
 *   re-showing the last turns is pure noise — and a watermark-less session (first
 *   run after ship, pruned transcript) would otherwise re-spam every active topic
 *   on every hot rebuild (the exact regression the old recent-turns block was
 *   disabled to avoid).
 *
 * Pure (no I/O) so it is unit-testable. A clean reload with a known watermark and
 * no missed output (`missedCount === 0`, known) is always silent.
 */
export function checkShouldPostReattachRecap(args: {
  missedCount: number;
  isWatermarkKnown: boolean;
  hasTurns: boolean;
  isColdStart: boolean;
}): boolean {
  const { missedCount, isWatermarkKnown, hasTurns, isColdStart } = args;
  if (missedCount > 0) return true;
  return isColdStart && !isWatermarkKnown && hasTurns;
}

/**
 * @description Format the post-restart recap shown on a SILENT reattach (the bot
 * re-adopted a session that kept working while the bot was down), so output
 * produced during the downtime is recovered instead of lost. Mirrors
 * {@link formatResumeContext}'s turn body (via {@link renderTurns}) under a
 * scale-conveying header:
 *
 * - `isWatermarkKnown && missedCount > 0` → the count header
 *   ("⚠️ Missed N message(s) …"); the body stays the last few turns regardless
 *   of N (the count conveys scale, the hard turn cap is the flood bound).
 * - otherwise (watermark unknown / untrusted) → the no-number fallback header.
 *
 * A best-effort trailing "still working …" line is appended only when `isActive`.
 * Returns `null` when there are no turns to show (the caller posts nothing).
 *
 * Pure (only reads i18n, no I/O) so it is unit-testable. The caller
 * (`reattachExistingSessions`) owns the anti-spam gate — it invokes this only
 * when `missedCount > 0` OR (watermark unknown AND there are turns).
 */
export function formatReattachRecap(args: {
  missedCount: number;
  turns: RecentTurn[];
  isActive: boolean;
  isWatermarkKnown: boolean;
}): string | null {
  const { missedCount, turns, isActive, isWatermarkKnown } = args;
  if (turns.length === 0) return null;

  const header =
    isWatermarkKnown && missedCount > 0
      ? t('recap.missedCountHeader', { count: missedCount })
      : t('recap.restartedFallbackHeader');

  const lines = [header, ...renderTurns(turns)];
  if (isActive) lines.push(t('recap.stillWorkingLine'));
  return lines.join('\n\n');
}
