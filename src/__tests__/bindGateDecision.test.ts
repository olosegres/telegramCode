/**
 * @description S2 (plan 2026-06-05) — the bind gate: no agent start / session
 * list / resume without a binding, and no fallback to `WORK_ROOT` itself.
 *
 * `getBindGateDecision` is the single pure seam every agent-facing entry point
 * in `bot.ts` (`startAgentSession`, `handleSessionsList`, `resumeSessionByIndex`)
 * funnels its unbound case through. The load-bearing assertions:
 *   - unbound (binding === null) → `refuse` (the caller replies
 *     `thread.bind_required` and starts nothing) — for ALL three entry points
 *     it is the same decision;
 *   - bound → `proceed` with `WORK_ROOT/<subdir>` EXACTLY (never `WORK_ROOT`
 *     itself) — a re-introduced fallback would return `WORK_ROOT` here and fail.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getBindGateDecision } from '../utils/bindGateDecision';
import type { BindingData } from '../state';

const workRoot = '/home/user/src';

function makeBinding(subdir: string): BindingData {
  return { subdir, createdAt: new Date().toISOString() };
}

describe('bind gate decision (S2)', () => {
  it('unbound thread → refuse (start / list / resume all blocked)', () => {
    const decision = getBindGateDecision(null, workRoot);
    assert.equal(decision.kind, 'refuse');
  });

  it('bound thread → proceed with WORK_ROOT/<subdir>, never WORK_ROOT itself', () => {
    const decision = getBindGateDecision(makeBinding('telegramCode'), workRoot);
    assert.equal(decision.kind, 'proceed');
    assert.equal(
      decision.kind === 'proceed' ? decision.workDir : null,
      path.join(workRoot, 'telegramCode'),
    );
    // The retired fallback would have returned WORK_ROOT itself — assert it does not.
    assert.notEqual(decision.kind === 'proceed' ? decision.workDir : null, workRoot);
  });

  it('a nested subdir is joined under WORK_ROOT, not treated as absolute', () => {
    const decision = getBindGateDecision(makeBinding('apps/api'), workRoot);
    assert.equal(decision.kind, 'proceed');
    assert.equal(
      decision.kind === 'proceed' ? decision.workDir : null,
      path.join(workRoot, 'apps/api'),
    );
  });
});
