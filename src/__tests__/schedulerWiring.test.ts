/**
 * @description S8 pure helpers: the directory→threads inversion the scheduler
 * MCP server's `dir:` scope resolution rides, and the rebind-resume decision
 * for jobs paused by an /unbind.
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getThreadKeysForDirectory } from '../scheduler/directoryThreads';
import { getRebindResumeAction } from '../scheduler/rebindResume';
import { createScheduleRecord } from '../scheduler/store';
import type { ThreadKey } from '../types';
import type { BindingData } from '../state';

const workRoot = '/work/root';

function buildBinding(chatId: number, threadId: number, subdir: string): { key: ThreadKey; data: BindingData } {
  return { key: { chatId, threadId }, data: { subdir, createdAt: '2026-06-06T00:00:00.000Z' } };
}

describe('getThreadKeysForDirectory', () => {
  const bindings = [
    buildBinding(-100, 11, 'projectA'),
    buildBinding(-100, 22, 'projectA'),
    buildBinding(-100, 33, 'projectB'),
  ];

  it('returns every thread bound to the directory (shared folders share scope)', () => {
    assert.deepEqual(getThreadKeysForDirectory(bindings, workRoot, '/work/root/projectA'), [
      '-100:11',
      '-100:22',
    ]);
  });

  it('a single-thread directory resolves to exactly that thread', () => {
    assert.deepEqual(getThreadKeysForDirectory(bindings, workRoot, '/work/root/projectB'), ['-100:33']);
  });

  it('an unknown directory resolves to no threads', () => {
    assert.deepEqual(getThreadKeysForDirectory(bindings, workRoot, '/work/root/other'), []);
  });

  it('matches the RESOLVED workDir, not the raw subdir', () => {
    // The dir-scope token carries the absolute instance directory; comparing
    // against the relative subdir would miss every match.
    assert.deepEqual(getThreadKeysForDirectory(bindings, workRoot, 'projectA'), []);
  });
});

describe('getRebindResumeAction', () => {
  const nowMs = new Date(2026, 5, 6, 12, 0, 0).getTime();

  it('a recurring job resumes at its next occurrence FROM NOW (no catch-up)', () => {
    const record = createScheduleRecord({
      threadKey: { chatId: -100, threadId: 11 },
      name: 'daily',
      spec: { kind: 'cron', cronExpr: '0 9 * * *' },
      prompt: 'p',
      createdBy: 'user',
      nowMs: nowMs - 86_400_000,
    });
    const action = getRebindResumeAction(record, nowMs);
    assert.equal(action.kind, 'resume');
    if (action.kind === 'resume') {
      // Next 09:00 strictly after 12:00 today is tomorrow's.
      assert.equal(action.nextRunAt, new Date(2026, 5, 7, 9, 0, 0).getTime());
    }
  });

  it('a one-shot whose instant passed while unbound is removed (cannot resume the past)', () => {
    const record = createScheduleRecord({
      threadKey: { chatId: -100, threadId: 11 },
      name: 'once',
      spec: { kind: 'once', onceAtIso: new Date(nowMs - 60_000).toISOString() },
      prompt: 'p',
      createdBy: 'user',
      nowMs: nowMs - 3_600_000,
    });
    assert.deepEqual(getRebindResumeAction(record, nowMs), { kind: 'remove' });
  });

  it('a one-shot still ahead resumes at its own instant', () => {
    const onceAtMs = nowMs + 3_600_000;
    const record = createScheduleRecord({
      threadKey: { chatId: -100, threadId: 11 },
      name: 'later',
      spec: { kind: 'once', onceAtIso: new Date(onceAtMs).toISOString() },
      prompt: 'p',
      createdBy: 'user',
      nowMs: nowMs - 3_600_000,
    });
    assert.deepEqual(getRebindResumeAction(record, nowMs), { kind: 'resume', nextRunAt: onceAtMs });
  });
});

test('schedule pause/resume i18n keys exist with the {count} placeholder', async () => {
  const { checkKeyInAllLangs } = await import('../i18n');
  assert.ok(checkKeyInAllLangs('schedule.pausedUnbound'), 'schedule.pausedUnbound missing in some locale');
  assert.ok(checkKeyInAllLangs('schedule.resumedRebind'), 'schedule.resumedRebind missing in some locale');
});
