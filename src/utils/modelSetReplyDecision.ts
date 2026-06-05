/**
 * @description Pure reply-decision for the four `/model`-set paths in `bot.ts`
 * (the `/model <num>` and `/model <name>` commands, the text-handler numeric
 * pick, and the `model_<id>` button callback). All four asked the adapter to
 * set the model and now must build the SAME user-facing reply — so the branchy
 * decision lives here, unit-testable without the Telegraf machinery (same
 * pattern as `statusFlushDecision.ts` / `bindGateDecision.ts`).
 *
 * The no-session decision itself now lives in the adapters (OpenCode persists
 * the pref and returns success; Claude refuses with a notice), so this helper
 * is purely about turning the adapter's outcome into a message — it does NOT
 * gate on session state itself.
 *
 * `isActive` only distinguishes the two SUCCESS copies: a live switch
 * ("Model set to: …") vs a pref saved for the next agent start
 * (`model.saved_for_next_start`). The deferred-success copy comes from i18n, so
 * a `translate` callback is injected (callers pass `t`; tests pass a stub) to
 * keep this module free of the i18n import and trivially testable.
 *
 * @name ModelSetReplyDecision
 * @description
 * - `unsupported` — the adapter has no `setModel`: nothing was changed.
 * - `error`       — `setModel` returned a non-null error string.
 * - success (`isOk: true`) — live switch or deferred-to-next-start save.
 */
export interface ModelSetReplyDecisionInput {
  /** Does the thread's adapter implement `setModel`? */
  hasSetModel: boolean;
  /** Error string returned by `setModel`, or `null` on success. */
  setModelError: string | null;
  /** Is the thread's agent session live right now? */
  isActive: boolean;
  /** Human-facing agent label (e.g. "Claude Code"), for the unsupported copy. */
  adapterLabel: string;
  /** Resolved model label to show on success (current model or the picked id). */
  displayLabel: string;
}

export interface ModelSetReplyDecision {
  isOk: boolean;
  message: string;
}

/**
 * @description Build the reply for a `/model`-set attempt.
 *
 * @param translate i18n lookup (`t`) — only used for the deferred-success key.
 */
export function getModelSetReplyDecision(
  input: ModelSetReplyDecisionInput,
  translate: (code: string, vars?: Record<string, string | number>) => string,
): ModelSetReplyDecision {
  if (!input.hasSetModel) {
    return { isOk: false, message: `Model switching not supported for ${input.adapterLabel}` };
  }
  if (input.setModelError) {
    return { isOk: false, message: `Error: ${input.setModelError}` };
  }
  if (input.isActive) {
    return { isOk: true, message: `Model set to: ${input.displayLabel}` };
  }
  return {
    isOk: true,
    message: translate('model.saved_for_next_start', { model: input.displayLabel }),
  };
}
