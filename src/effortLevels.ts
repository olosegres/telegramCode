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
