import { t } from '../i18n';
import type { AgentRuntimeInfo } from '../types';

export interface ThreadStatusReportInput {
  agentLine: string;
  subdir: string;
  isActive: boolean;
  workDir: string | null;
  model: string | null;
  effort: string | null;
  startedAt: string | null;
  runtime: AgentRuntimeInfo | null;
}

/**
 * @description Render the per-topic `/status` report. Pure (locale comes from
 * the caller's async i18n context) and kept OUT of `bot.ts` so it is unit-testable
 * without importing the bot module, whose module-scope `parseEnv()` exits the
 * process when `TELEGRAM_BOT_TOKEN` is unset.
 *
 * Model / effort / start date / runtime rows are session properties: they are
 * meaningless once the session stopped, so a stopped thread renders only the
 * header and the bound working directory.
 */
export function getThreadStatusReport({
  agentLine,
  subdir,
  isActive,
  workDir,
  model,
  effort,
  startedAt,
  runtime,
}: ThreadStatusReportInput): string {
  const lines = [
    t('status.thread_report', {
      agent: agentLine,
      subdir,
      session: isActive ? t('status.thread_running') : t('status.thread_stopped'),
    }),
  ];
  if (workDir !== null) lines.push(t('status.thread_workdir', { workDir }));
  if (!isActive) return lines.join('\n');

  if (model) lines.push(t('status.thread_model', { model }));
  if (effort) lines.push(t('status.thread_effort', { effort }));
  if (startedAt) lines.push(t('status.thread_started', { started: startedAt }));
  const unavailable = t('version.unknown');
  lines.push(t('status.thread_runtime_version', { version: runtime?.version ?? unavailable }));
  lines.push(t('status.thread_context', {
    used: runtime?.contextUsedTokens ?? unavailable,
    limit: runtime?.contextWindowTokens ?? unavailable,
  }));

  return lines.join('\n');
}

export interface ThreadStatusModelSources {
  /** Live model the adapter itself can name right now (`getCurrentModel`). */
  adapterModel: string | null;
  /** Model the runtime reports it ACTUALLY ran last ({@link AgentRuntimeInfo.model}). */
  runtimeModel: string | null;
  /** Model persisted on the agent row when the session was started. */
  persistedModel: string | null;
}

/**
 * @description Resolve the model `/status` names for a live session, most
 * authoritative source first.
 *
 * The runtime report sits in the MIDDLE on purpose: the Claude tmux backend
 * keeps its model inside the TUI, so its `getCurrentModel` is permanently null
 * and the runtime's self-report is the only model source there — without this
 * step `/status` named no model at all on that whole backend. It must still lose
 * to a live adapter value, which knows about a model switch the runtime has not
 * yet written a turn for.
 *
 * Each step falls through on any FALSY value, not just `null`: an adapter that
 * answers with an empty string knows no model either, and `??` let that empty
 * string win over a real runtime-reported one, rendering a blank `/status` row.
 */
export function getThreadStatusModel({
  adapterModel,
  runtimeModel,
  persistedModel,
}: ThreadStatusModelSources): string | null {
  return adapterModel || runtimeModel || persistedModel || null;
}
