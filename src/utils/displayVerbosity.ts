/**
 * @description THE single source of truth for the unified display-verbosity
 * vocabulary (`minimal | short | full`) shared by `/thinking`,
 * `/tool_results` and `/subagent`: the picker option order, the locked
 * default, the type guard, and the legacy-name normalization. Per-command
 * SEMANTICS stay in their own helper modules (`thinkingRender.ts`,
 * `toolResultRender.ts`, `subagentRender.ts`); this module only owns the
 * vocabulary itself, so the three commands can never drift apart again.
 */
import type { DisplayVerbosityMode } from '../types';

/** Every selectable display-verbosity mode, in picker-button order (quiet →
 * loud). Single source of truth for arg validation and the mode keyboards of
 * all three display commands. */
export const displayVerbosityModeOptions: readonly DisplayVerbosityMode[] = ['minimal', 'short', 'full'];

/**
 * @description Locked default for EVERY display pref (user decision
 * 2026-06-11: "по умолчанию минимум"). `state.ts` resolves absent persisted
 * fields to it, and the adapters fall back to it for reads that happen before
 * the bot injects its mode reader at boot.
 */
export const defaultDisplayVerbosityMode: DisplayVerbosityMode = 'minimal';

/**
 * @description Type guard: is `value` one of the {@link DisplayVerbosityMode}
 * options? Narrows a free-form string to the union WITHOUT a cast. Accepts
 * ONLY the new vocabulary — legacy names go through
 * {@link normalizeDisplayVerbosityMode}.
 */
export function checkIsDisplayVerbosityMode(value: string): value is DisplayVerbosityMode {
  return (displayVerbosityModeOptions as readonly string[]).includes(value);
}

/**
 * @description The retired per-command mode names mapped onto the unified
 * vocabulary, preserving each one's behavior:
 *
 * - `detailed` → `full`    (thinking: keep the streamed reasoning)
 * - `brief`    → `short`   (thinking: collapse to "thought for {N}s")
 * - `hide`     → `minimal` (thinking/tool-results: nothing permanent remains)
 * - `compact`  → `short`   (subagent: status-only)
 *
 * No name collides across the three commands, so ONE shared map covers them
 * all. Used both for old values persisted in `state.json` and for old names
 * arriving from command args / stale picker buttons.
 */
const legacyDisplayVerbosityAliases: Readonly<Partial<Record<string, DisplayVerbosityMode>>> = {
  detailed: 'full',
  brief: 'short',
  hide: 'minimal',
  compact: 'short',
};

/**
 * @description Normalize a mode string to the unified vocabulary: a new name
 * passes through, a legacy name maps per
 * {@link legacyDisplayVerbosityAliases}, anything else (unknown string,
 * `undefined`) → `null` so the caller decides between "use the default"
 * (read-time normalization of persisted values) and "reject the input"
 * (command arg / callback validation).
 */
export function normalizeDisplayVerbosityMode(value: string | undefined): DisplayVerbosityMode | null {
  if (value === undefined) return null;
  if (checkIsDisplayVerbosityMode(value)) return value;
  return legacyDisplayVerbosityAliases[value] ?? null;
}
