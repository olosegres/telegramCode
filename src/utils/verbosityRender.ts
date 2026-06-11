/**
 * @description Pure decision helper for the `/verbosity` umbrella command
 * (plan 2026-06-11 S2). The macro itself just writes the same per-pref store
 * the individual commands (`/thinking`, `/tool_results`, `/subagent`) write —
 * last write per pref wins — so the only /verbosity-specific logic is this
 * read-side question: "do all three prefs currently agree on one level?",
 * which drives the picker's ✓ marker and the "custom" (mixed) rendering.
 */
import type { DisplayVerbosityMode, ResolvedThreadDisplayPrefs } from '../types';

/**
 * @description The single level all three display prefs (thinking,
 * toolResults, subagent) currently share, or `null` when they are mixed.
 * The `/verbosity` picker puts ✓ on an exact match ONLY — a mixed state shows
 * no marker anywhere and is rendered as "custom" with the three values
 * spelled out.
 */
export function getUniformVerbosityLevel(prefs: ResolvedThreadDisplayPrefs): DisplayVerbosityMode | null {
  if (prefs.thinking === prefs.toolResults && prefs.toolResults === prefs.subagent) {
    return prefs.thinking;
  }
  return null;
}
