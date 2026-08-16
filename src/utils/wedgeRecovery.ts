/**
 * @description Pure decision for recovering a WEDGED OpenCode session (one that
 * accepted a prompt but ran no turn — see `openCodeTurnActivity.ts`).
 *
 * A wedged session is unrecoverable in place — even a server-side summarize/
 * compact hits the same dead agent loop (verified live 2026-08-15/16 on the
 * my-news digest). The only fix is a FRESH session, then replaying the prompt.
 * Because the digest's real state lives in files (`news-state.json`), a fresh
 * session loses nothing.
 *
 * Loop guard: recover AT MOST once per prompt episode. If the fresh session
 * ALSO wedges (`alreadyRecovering`), or there is no cached prompt to replay,
 * give up and surface the actionable notice instead of restarting forever.
 */
export interface WedgeRecoveryState {
  /** A raw prompt is cached and can be replayed into a fresh session. */
  hasReplayPrompt: boolean;
  /** A fresh-session attempt has already been made for this prompt episode. */
  alreadyRecovering: boolean;
}

export type WedgeRecoveryAction = 'restart' | 'giveUp';

export function decideWedgeRecovery(state: WedgeRecoveryState): WedgeRecoveryAction {
  if (!state.alreadyRecovering && state.hasReplayPrompt) return 'restart';
  return 'giveUp';
}
