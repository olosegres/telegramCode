import path from 'node:path';
import type { BindingData } from '../state';

/**
 * @description Pure bind-gate decision: given a thread's binding (or its
 * absence) and `WORK_ROOT`, resolve the agent's working directory or refuse.
 *
 * The bound folder IS the agent's cwd — an agent must never run outside it, so
 * there is deliberately NO fallback to `WORK_ROOT` itself (the old Этап-3
 * smoke-test behavior is retired). Every agent-facing entry point in `bot.ts`
 * (start / list / resume) routes its unbound case through this rule, so the
 * "no agent without a binding" contract lives in one unit-testable place
 * (same pattern as `statusFlushDecision.ts`).
 *
 * @name BindGateDecision
 * @description
 * - `kind: 'proceed'` — thread is bound: `workDir` is `WORK_ROOT/<subdir>`,
 *   the only folder the agent may run in.
 * - `kind: 'refuse'`  — thread has no binding: the caller must reply with
 *   `thread.bind_required` and start no session.
 */
export type BindGateDecision =
  | { kind: 'proceed'; workDir: string }
  | { kind: 'refuse' };

export function getBindGateDecision(
  binding: BindingData | null,
  workRoot: string,
): BindGateDecision {
  if (!binding) return { kind: 'refuse' };
  return { kind: 'proceed', workDir: path.join(workRoot, binding.subdir) };
}
