/**
 * @description Reasoning-effort level catalogs and per-backend helpers.
 *
 * Plan 2026-05-30-effort-command / S2. The bot's `/effort` command and both
 * adapters share this module so the level vocabularies stay in one place
 * and stay easy to unit-test.
 *
 * **Two vocabularies, on purpose** (plan D7).
 *
 * - **Claude** has a native `/effort` slash command with a small fixed set
 *   (`low medium high xhigh max auto ultracode`). claude itself clamps an
 *   unsupported level for the current model down to the nearest supported
 *   one, so the bot offers the canonical set unconditionally — the adapter
 *   has no way to read claude's live model (plan D2).
 * - **OpenCode** encodes reasoning effort as the `variants` map on a model
 *   in `provider.models.<m>.variants` (e.g. anthropic ships `high`/`max`,
 *   openai ships `none…xhigh`). The legal set therefore depends on which
 *   model the thread is currently using; the catalog cannot be hard-coded.
 *   See `openCodeAdapter.ts` for the per-prompt application path.
 */

// ── Claude (canonical set) ──────────────────────────────────────────────────

/**
 * @description Claude `/effort` slash-command levels, in the order they're
 * shown to the user. Verified against `claude 2.1.158` (plan research
 * 2026-05-30).
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
 * @description Canonical Claude effort levels (plan D2). Returns a fresh
 * mutable copy so callers can safely sort/filter without mutating the
 * frozen module-level constant.
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

// ── OpenCode (per-model variants) ────────────────────────────────────────────

/**
 * @description Env var that names the custom OpenCode command the bot
 * invokes (per-prompt) to apply the chosen effort level. Plan D3/D4.
 *
 * When unset, OpenCode `/effort` is disabled and the bot replies with a
 * one-line configure hint instead of an empty picker. The decision rule
 * is fully defined in both states — there are no open questions left.
 *
 * The shipped fallback documented in the plan is opencode's own native
 * `--variant` / `variant_cycle`; the bot does not re-implement that.
 */
export const OPENCODE_EFFORT_COMMAND_ENV = 'OPENCODE_EFFORT_COMMAND';

/**
 * @description Optional env var that NARROWS the per-model variant set
 * down to a configured allow-list. When unset, the bot offers every
 * variant exposed by `GET /config/providers` for the current model
 * (plan D5).
 *
 * Format: comma-separated, whitespace tolerated, empty entries dropped.
 * E.g. `OPENCODE_EFFORT_LEVELS=low,medium,high,xhigh`.
 */
export const OPENCODE_EFFORT_LEVELS_ENV = 'OPENCODE_EFFORT_LEVELS';

/**
 * @description Parse the comma-separated env value into a clean list.
 *
 * Pure helper (no `process.env` read) so callers can pass the value
 * explicitly in tests. Empty / undefined input yields `[]`, which means
 * "no allow-list configured" downstream — NOT "no levels allowed".
 */
export function parseConfiguredLevels(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * @description Combine a model's available `variants` with the optional
 * `OPENCODE_EFFORT_LEVELS` allow-list (plan D5).
 *
 * Rules:
 * - `configured` empty → return `variants` unchanged (no narrowing).
 * - `configured` non-empty → keep only those `variants` also present in
 *   `configured`, preserving the original `variants` order so the picker
 *   shows them in the provider's intended order (high → max, not max →
 *   high).
 *
 * Both inputs are de-duplicated cheaply via `Set` so configuration typos
 * (`high,high`) don't double up the picker.
 */
export function intersectVariants(variants: string[], configured: string[]): string[] {
  const uniqueVariants: string[] = [];
  const seen = new Set<string>();
  for (const v of variants) {
    if (!seen.has(v)) { seen.add(v); uniqueVariants.push(v); }
  }
  if (configured.length === 0) return uniqueVariants;
  const allowed = new Set(configured);
  return uniqueVariants.filter(v => allowed.has(v));
}
