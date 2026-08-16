/**
 * @description Pure decision for recovering a WEDGED OpenCode session (one that
 * accepted a prompt but ran no turn — see `openCodeTurnActivity.ts`).
 *
 * Three escalating tiers, one attempt each per prompt episode, so the last
 * dialog is preserved when at all possible and a persistently-wedging session
 * still cannot loop forever:
 *
 *   tier 0 → `resend`  — re-send the prompt to the SAME session (a transient
 *                        stall recovers here; dialog fully intact, zero cost).
 *   tier 1 → `fork`    — FORK the session into a fresh one that carries the full
 *                        conversation, then replay (recovers an instance-level
 *                        wedge while keeping the dialog). Falls back to `restart`
 *                        when the adapter can't fork.
 *   tier 2 → `restart` — blank fresh session + replay (the conversation itself is
 *                        the poison, e.g. a bloated session — dialog is dropped,
 *                        but the trigger still runs; verified live on the my-news
 *                        digest, which is stateless so this is safe).
 *   else   → `giveUp`  — surface the actionable notice instead of looping.
 *
 * `tier` = how many recovery attempts were ALREADY made this episode; it resets
 * to 0 when a genuine new prompt is forwarded. With no cached prompt to replay
 * there is nothing to recover → give up.
 */
export type WedgeRecoveryAction = 'resend' | 'fork' | 'restart' | 'giveUp';

export interface WedgeRecoveryState {
  /** Recovery attempts already made this prompt episode (0, 1, 2, …). */
  tier: number;
  /** A raw prompt is cached and can be replayed. */
  hasReplayPrompt: boolean;
  /** The adapter can fork its session (carries the dialog); else tier 1 restarts. */
  canFork: boolean;
}

export function decideWedgeRecovery(state: WedgeRecoveryState): WedgeRecoveryAction {
  if (!state.hasReplayPrompt) return 'giveUp';
  if (state.tier === 0) return 'resend';
  if (state.tier === 1) return state.canFork ? 'fork' : 'restart';
  if (state.tier === 2) return 'restart';
  return 'giveUp';
}
