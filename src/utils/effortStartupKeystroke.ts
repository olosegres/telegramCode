/**
 * @description Decide the `/effort` slash-command keystroke to replay into a
 * freshly spawned Claude TUI, given the thread's stored effort pref.
 *
 * WHY: claude persists effort GLOBALLY in its own settings.json, so a fresh
 * TUI (start / `/new` / resume) comes up with the LAST globally-set level —
 * possibly chosen in another topic. The bot keeps the real per-thread choice
 * in `.claude-effort-prefs.json`; on every fresh spawn it must re-apply that
 * choice by typing claude's native `/effort <level>` once the TUI is ready,
 * BEFORE any buffered user prompt is replayed. This pure helper owns the tiny
 * decision (which keystroke, or none) so it is unit-testable without driving
 * a real tmux pane.
 *
 * No stored pref → `null` → type nothing (claude's own default stands). A
 * stored level claude can't honour for the current model is returned as-is:
 * claude clamps unsupported levels per model (documented behavior), so the
 * adapter does NOT validate here — same contract as a manual `/effort`.
 */
export function getEffortStartupKeystroke(storedLevel: string | null): string | null {
  const level = storedLevel?.trim();
  if (!level) return null;
  return `/effort ${level}`;
}
