/**
 * @description Pure decision logic for the `/sessions` number-reply picker.
 *
 * Extracted from `bot.ts` so it can be unit-tested without booting Telegraf
 * (mirrors `agentTrigger.ts` / `threadRouting.ts`). Given the raw reply text
 * and how many sessions were shown, it decides what the bot should do — it
 * does NOT touch any state or perform the resume itself.
 */

/**
 * @name SessionPickAction
 * @description Discriminated outcome of interpreting a reply while a thread
 * is armed in session-pick mode.
 *
 * - `cancel`     — user typed `0` (or `/cancel` is handled separately); exit pick-mode.
 * - `select`     — a valid 1-based number; `index` is the 0-based list index to resume.
 * - `invalid`    — a number outside `1..listLength`; stay armed, show an error.
 * - `passthrough`— non-numeric text; exit pick-mode and let normal handling run.
 */
export type SessionPickAction =
  | { kind: 'cancel' }
  | { kind: 'select'; index: number }
  | { kind: 'invalid' }
  | { kind: 'passthrough' };

/** Matches a reply that is ONLY an optional-whitespace-wrapped run of digits. */
const bareNumberPattern = /^\s*(\d+)\s*$/;

/** The sentinel number a user sends to cancel the picker without resuming. */
const cancelNumber = 0;

/**
 * @description Decide how to treat `text` for a thread armed in session-pick
 * mode, given that `listLength` sessions were shown.
 *
 * Rules:
 *   - "0"               → cancel
 *   - "n" (1..len)      → select index n-1
 *   - "n" (out of range)→ invalid (caller keeps the thread armed)
 *   - anything else     → passthrough (caller disarms, normal flow continues)
 *
 * Surrounding whitespace on a bare number is tolerated ("  3 " → select 2).
 */
export function checkSessionPickAction(text: string, listLength: number): SessionPickAction {
  const match = bareNumberPattern.exec(text);
  if (!match) return { kind: 'passthrough' };

  const picked = Number(match[1]);
  if (picked === cancelNumber) return { kind: 'cancel' };
  if (picked >= 1 && picked <= listLength) return { kind: 'select', index: picked - 1 };
  return { kind: 'invalid' };
}
