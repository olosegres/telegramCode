/**
 * @description Decision + formatting helpers for sub-agent (OpenCode child
 * session) rendering behind `/subagent` (S4). The mode×part-kind matrix
 * ({@link getSubagentPartAction}) is consulted by the ADAPTER — unlike the
 * thinking / tool-result modes the sub-agent mode decides what is ACCUMULATED
 * (status vs a separate streamed accumulator), which cannot be deferred to the
 * bot's render time. Extracted from the adapter so the matrix is unit-testable
 * without an SSE stream (same pattern as `toolResultRender.ts`). The string
 * builders are pure-ish (they only read i18n), mirroring `buildThinkingFrameText`.
 */
import { t } from '../i18n';
import type { SubagentMode } from '../types';

/** Every selectable sub-agent mode, in picker-button order. Single source of
 * truth for both the `/subagent` arg validation and the mode keyboard.
 * Deliberately 2-state — NO `hide`: the user always wants the "working"
 * indicator visible (locked decision). */
export const subagentModeOptions: readonly SubagentMode[] = ['compact', 'full'];

/**
 * @description Type guard: is `value` one of the {@link SubagentMode} options?
 * Narrows a free-form `/subagent <arg>` (or callback payload) to the enum
 * WITHOUT a cast (mirrors `checkIsToolResultMode`).
 */
export function checkIsSubagentMode(value: string): value is SubagentMode {
  return (subagentModeOptions as readonly string[]).includes(value);
}

/**
 * Locked default sub-agent mode — mirrors `state.ts`'s (unexported)
 * `defaultSubagentMode`. The adapter falls back to it only for reads that
 * happen before the bot injects its mode reader at boot.
 */
export const fallbackSubagentMode: SubagentMode = 'compact';

/** Part kinds a sub-agent (child session) event can carry that the adapter
 * must decide on. `step-start`/`step-finish`/unknown parts are skipped before
 * the matrix is consulted (same as for the parent's own parts). */
export type SubagentPartKind = 'text' | 'tool' | 'reasoning';

/**
 * @name SubagentPartAction
 * @description What the adapter does with one sub-agent part event.
 *
 * - `status` — emit/refresh a transient status only (for `text` that is the
 *   rolling "🤖 sub-agent: <title> …" line; for `tool` the generic 🔧 line).
 * - `stream` — accumulate into the SEPARATE child accumulator and emit as
 *   marked `output` (`meta.isSubagent`). Never the parent accumulator.
 * - `ignore` — drop entirely (no status, no output, no toolResult).
 */
export type SubagentPartAction = 'status' | 'stream' | 'ignore';

/**
 * @description The sub-agent mode×part-kind matrix:
 * ```
 *             compact    full
 * text        status     stream
 * tool        ignore     status
 * reasoning   ignore     ignore
 * ```
 * Reasoning is `ignore` in EVERY mode — child chain-of-thought is never
 * rendered (locked decision). Compact ignores child tool parts because their
 * generic 🔧 statuses would overwrite the single sub-agent status line. Child
 * toolResult bodies are suppressed in BOTH modes (handled by the adapter
 * outside this matrix): the parent's `task` tool output already carries the
 * child's final result.
 */
export function getSubagentPartAction(mode: SubagentMode, partKind: SubagentPartKind): SubagentPartAction {
  if (partKind === 'reasoning') return 'ignore';
  if (partKind === 'text') return mode === 'full' ? 'stream' : 'status';
  return mode === 'full' ? 'status' : 'ignore';
}

/**
 * @description Build the compact-mode rolling status line
 * ("🤖 sub-agent: <title> …"), mirroring the terminal's single "working"
 * indicator. `title` is the current delegation's title recorded from the
 * parent's `task` tool part; `null` (no title/description on the part) falls
 * back to a localized generic label.
 */
export function buildSubagentStatusText(title: string | null): string {
  return t('subagent.status_live', { title: title ?? t('subagent.fallback_title') });
}

/**
 * @description Build the parent-side "Delegating" activity status
 * ("🤖 Delegating: <title> …") rendered while the parent's delegation (`task`)
 * tool part is pending/running (S5) — the counterpart of
 * {@link buildSubagentStatusText} (which is driven by the CHILD's own text
 * events), same compact style. `title` is the part's `state.title` falling
 * back to its `input.description`; `null` (neither present) falls back to the
 * same localized generic label.
 */
export function buildDelegatingStatusText(title: string | null): string {
  return t('subagent.delegating_status', { title: title ?? t('subagent.fallback_title') });
}

/**
 * @description The marker prepended to every full-mode sub-agent chunk
 * ("🤖 ⤷") so a streamed child transcript is visually separated from the main
 * agent's reply.
 */
export function buildSubagentOutputPrefix(): string {
  return t('subagent.chunk_prefix');
}
