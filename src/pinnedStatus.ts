import type { BindingData } from './state';

/**
 * @description Inputs for {@link formatPinnedStatus}.
 *
 * Kept as a plain data record (no `ThreadKey`, no adapter references) so the
 * formatter is a pure function and can be unit-tested without booting any
 * Telegraf / tmux machinery. The bot's `updatePinnedStatus` helper does the
 * impure plumbing (probing the adapter, reading state, calling Telegram).
 *
 * Plan §11 Этап 7 (polish) / §20.5 — pinned per-thread status banner of
 * the form `📁 <subdir> · <agent> · <state>`.
 */
export interface PinnedStatusInputs {
  /** The persistent binding row for this thread. */
  binding: BindingData;
  /**
   * Adapter display label (e.g. `"Claude Code"`). `null` means no adapter
   * has been chosen yet for this thread — the banner shows `"no agent"`.
   */
  agentLabel: string | null;
  /**
   * Currently selected model id (e.g. `"sonnet"` or
   * `"anthropic/claude-3-5-sonnet"`). Optional — many threads run on the
   * adapter default and never call `/model`.
   */
  model: string | null;
  /**
   * Currently selected reasoning-effort level (e.g. `"high"`, `"xhigh"`).
   * Optional — shown right after the model when set, omitted otherwise.
   */
  effort?: string | null;
  /** True if the adapter reports an active session right now. */
  isActive: boolean;
}

/**
 * @description Compose the one-line pinned status text for a thread.
 *
 * Layout (dot-separated, single line so the Telegram pin stays compact):
 *
 *   📁 <subdir> · <agentLabel|no agent> [· <model>] · <state>
 *
 * The state segment is mutually exclusive: a closed topic always shows
 * `🔒 closed` and suppresses the running/idle dot — once the topic is
 * closed the agent can't run anyway, and the banner is the user's only
 * pointer to that fact.
 *
 * Output is plain text (no Markdown). The pinned banner is permanent UI,
 * not assistant output, so Telegram's MarkdownV2 parsing hazards are not
 * worth the formatting noise.
 */
export function formatPinnedStatus(inputs: PinnedStatusInputs): string {
  const parts: string[] = [];

  parts.push(`📁 ${inputs.binding.subdir}`);
  parts.push(inputs.agentLabel ?? 'no agent');
  if (inputs.model) parts.push(inputs.model);
  if (inputs.effort) parts.push(`⚙️ ${inputs.effort}`);

  if (inputs.binding.closed) {
    parts.push('🔒 closed');
  } else {
    parts.push(inputs.isActive ? '🟢 running' : '⚪ idle');
  }

  return parts.join(' · ');
}
