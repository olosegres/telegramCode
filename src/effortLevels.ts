/**
 * @description Reasoning-effort level catalogs and per-backend helpers.
 *
 * The bot's `/effort` command and both adapters share this module so the
 * level vocabularies stay in one place and stay easy to unit-test.
 *
 * **Two vocabularies, on purpose.**
 *
 * - **Claude** has a native `/effort` slash command with a small fixed set
 *   (`low medium high xhigh max auto ultracode`). claude itself clamps an
 *   unsupported level for the current model down to the nearest supported
 *   one, so the bot offers the canonical set unconditionally — the adapter
 *   has no way to read claude's live model.
 * - **OpenCode** encodes reasoning effort as the `variants` map on a model
 *   in `provider.models.<m>.variants` (e.g. anthropic ships `high`/`max`,
 *   openai ships `none…xhigh`). The legal set therefore depends on which
 *   model the thread is currently using and cannot be hard-coded — the
 *   OpenCode adapter reads it live from `GET /config/providers` and applies
 *   the chosen variant per-prompt. See `openCodeAdapter.ts`.
 */

// ── Claude (canonical set) ──────────────────────────────────────────────────

/**
 * @description Claude `/effort` slash-command levels, in the order they're
 * shown to the user. Verified against `claude 2.1.158`.
 *
 * `auto` resets back to claude's per-model default; `ultracode` is a heavy
 * coding-focused profile. Both are valid arguments to the TUI slash command.
 */
export const claudeEffortLevels = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
  'ultracode',
] as const;

export type ClaudeEffortLevel = (typeof claudeEffortLevels)[number];

/**
 * @description The bot's default reasoning effort, auto-applied to a
 * bot-started session whenever the thread has NO explicit per-thread
 * `/effort` pref. An explicit pick always wins and is never overwritten;
 * the default is a derived fallback, never persisted as a pref.
 *
 * The only real levels are `low`/`medium`/`high`/`xhigh`/`max` (there is no
 * `xlarge`). OpenCode clamps this to the resolved model's variants via
 * {@link clampEffortToAvailable}; Claude clamps unsupported levels itself.
 */
export const defaultEffortLevel: ClaudeEffortLevel = 'xhigh';

/**
 * @description Internal rank order shared by {@link clampEffortToAvailable}.
 * Spans both vocabularies (`none` is OpenCode-only) low→high.
 */
const effortRankOrder = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * @description Clamp a desired effort level to what a model actually offers.
 *
 * OpenCode effort is a model VARIANT and not every model ships `xhigh`
 * (e.g. opus-4-5 / sonnet-4-6 stop at high/max); sending an unknown variant
 * 400s. This picks the best legal variant:
 *
 * - keep only `available` entries we know how to rank ("known"); none known
 *   → return null (the model has no usable effort concept).
 * - if `desired` is itself available → return it.
 * - else return the highest known variant with rank ≤ rank(desired); if none
 *   are below, return the lowest known variant (closest above).
 *
 * Claude clamps itself, so it never calls this.
 */
export function clampEffortToAvailable(
  desired: string,
  available: readonly string[],
): string | null {
  const known = available.filter((level) =>
    (effortRankOrder as readonly string[]).includes(level),
  );
  if (known.length === 0) return null;
  if (known.includes(desired)) return desired;

  // Rank lookup widens the typed tuple to readonly string[] (the sanctioned
  // typed-array cast) rather than narrowing the argument; -1 for non-members.
  const rankOf = (level: string): number =>
    (effortRankOrder as readonly string[]).indexOf(level);
  const desiredRank = rankOf(desired);

  let bestBelow: string | null = null;
  let lowestKnown: string | null = null;
  for (const level of known) {
    if (lowestKnown === null || rankOf(level) < rankOf(lowestKnown)) {
      lowestKnown = level;
    }
    if (rankOf(level) <= desiredRank) {
      if (bestBelow === null || rankOf(level) > rankOf(bestBelow)) {
        bestBelow = level;
      }
    }
  }
  return bestBelow ?? lowestKnown;
}

/**
 * @description Canonical Claude effort levels. Returns a fresh mutable copy
 * so callers can safely sort/filter without mutating the frozen
 * module-level constant.
 */
export function getClaudeAvailableLevels(): string[] {
  return [...claudeEffortLevels];
}

/**
 * @description Whether `level` is a Claude effort level the TUI accepts.
 * Used by `/effort <bad>` rejection before we type anything into the pane.
 */
export function checkIsClaudeEffortLevel(level: string): level is ClaudeEffortLevel {
  return (claudeEffortLevels as readonly string[]).includes(level);
}
