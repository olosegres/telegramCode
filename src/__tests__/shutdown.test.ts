/**
 * @description Coverage for `src/shutdown.ts` — ordered shutdown
 * orchestrator.
 *
 * Ordering is the whole point of this module: the *old* bot had two
 * SIGTERM handlers (one in `cli/lock.ts`, one in `bot.ts:4116`) where the
 * lock handler — registered first — called `releaseLock(); process.exit(0)`
 * synchronously, preempting the bot's async `state.flush()`. These tests
 * pin down the new contract:
 *
 *   - bot.stop fires before state.flush is awaited (so Telegraf stops
 *     pulling fresh updates while we drain pending state)
 *   - state.flush() FULLY resolves before releaseLock() runs (the bug fix
 *     — losing the last debounce window of state was the real-world
 *     symptom)
 *   - releaseLock() runs before exit() so the next nodemon respawn can
 *     reclaim
 *   - watchdog fires on a hung flush so a wedged FS can't block forever
 *   - cleanupTimers() runs on the happy path (otherwise GC interval
 *     wakes up mid-shutdown and re-dirties state)
 *
 * Dependencies are injected so we don't need real Telegraf / state /
 * lock — every callback records its order into a shared `events` array.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { gracefulShutdown, type ShutdownDeps } from '../shutdown';

interface TestHandle {
  deps: ShutdownDeps;
  events: string[];
  exitCode: () => number | null;
  /**
   * Resolves once the (potentially long) mock `state.flush()` promise
   * actually completes. Callers MUST await it before returning from the
   * test, otherwise node's test runner reports "Promise resolution is
   * still pending" for the orphan flush. Default mocks resolve nearly
   * synchronously, so this is essentially free; the watchdog-test path
   * deliberately makes flush slow and uses this to clean up.
   */
  drained: () => Promise<void>;
}

function makeDeps(overrides: Partial<ShutdownDeps> & {
  flushDelayMs?: number;
  /** Force flush to take *longer* than the watchdog. Resolves after `flushDelayMs`. */
  flushSlowerThanWatchdog?: boolean;
} = {}): TestHandle {
  const events: string[] = [];
  let recordedExit: number | null = null;
  let flushDone: () => void = () => {};
  const flushDrain = new Promise<void>((resolve) => { flushDone = resolve; });

  // If the caller asked for "slower than watchdog", default the delay to
  // a value safely above the default watchdogMs. Callers can override.
  const effectiveDelay =
    overrides.flushDelayMs ??
    (overrides.flushSlowerThanWatchdog ? 200 : 0);

  const deps: ShutdownDeps = {
    signal: 'SIGTERM',
    bot: {
      stop: (signal?: string) => {
        events.push(`bot.stop(${signal ?? ''})`);
      },
    },
    state: {
      flush: async () => {
        events.push('state.flush:start');
        if (effectiveDelay > 0) {
          await new Promise((r) => setTimeout(r, effectiveDelay));
        }
        events.push('state.flush:resolved');
        flushDone();
      },
    },
    releaseLock: () => events.push('releaseLock'),
    exit: (code: number) => {
      if (recordedExit !== null) return; // first exit wins
      recordedExit = code;
      events.push(`exit(${code})`);
    },
    cleanupTimers: () => events.push('cleanupTimers'),
    log: () => { /* silence */ },
    watchdogMs: 50,
    ...overrides,
  };

  return {
    deps,
    events,
    exitCode: () => recordedExit,
    drained: () => flushDrain,
  };
}

test('happy path: cleanupTimers → bot.stop → state.flush → releaseLock → exit(0)', async () => {
  const { deps, events, exitCode, drained } = makeDeps({ flushDelayMs: 20 });

  await gracefulShutdown(deps);
  await drained();

  assert.deepEqual(events, [
    'cleanupTimers',
    'bot.stop(SIGTERM)',
    'state.flush:start',
    'state.flush:resolved',
    'releaseLock',
    'exit(0)',
  ]);
  assert.equal(exitCode(), 0);
});

test('state.flush is FULLY awaited before releaseLock — the historical bug', async () => {
  // If the orchestrator regressed to firing releaseLock during the flush
  // (the old lock.ts behaviour), the `state.flush:resolved` event would
  // appear AFTER `releaseLock`. Pin it.
  const { deps, events, drained } = makeDeps({ flushDelayMs: 50 });

  await gracefulShutdown(deps);
  await drained();

  const flushResolvedIdx = events.indexOf('state.flush:resolved');
  const releaseIdx = events.indexOf('releaseLock');
  assert.notEqual(flushResolvedIdx, -1, 'state.flush:resolved must be recorded');
  assert.notEqual(releaseIdx, -1, 'releaseLock must be recorded');
  assert.ok(
    flushResolvedIdx < releaseIdx,
    `state.flush() must resolve before releaseLock; got events=${JSON.stringify(events)}`,
  );
});

test('watchdog forces exit when state.flush is slower than the watchdog', async () => {
  // Flush takes 200ms, watchdog fires after 50ms → watchdog wins.
  const { deps, events, exitCode, drained } = makeDeps({
    flushSlowerThanWatchdog: true,
    watchdogMs: 50,
  });

  const start = Date.now();
  await gracefulShutdown(deps);
  const elapsed = Date.now() - start;

  // gracefulShutdown must return at the watchdog boundary, not wait the
  // full flush. Allow generous slack for slow CI.
  assert.ok(elapsed < 180, `watchdog should return promptly; got ${elapsed}ms`);
  assert.equal(exitCode(), 0, 'watchdog must still exit(0) so nodemon respawns');
  // releaseLock fires from the watchdog path so the next respawn finds a
  // free lockfile — that's the whole point of having the watchdog.
  assert.ok(events.includes('releaseLock'), `releaseLock missing; events=${JSON.stringify(events)}`);
  // Drain the orphan flush so node:test doesn't flag a pending promise.
  await drained();
});

test('watchdog does NOT fire on a fast flush', async () => {
  const { deps, events, exitCode, drained } = makeDeps({ flushDelayMs: 5, watchdogMs: 500 });
  const start = Date.now();

  await gracefulShutdown(deps);
  await drained();

  const elapsed = Date.now() - start;
  // Way under the 500ms watchdog — proves the happy path didn't wait it out.
  assert.ok(elapsed < 200, `expected fast resolution, got ${elapsed}ms`);
  // exit only recorded once (the watchdog path is suppressed).
  assert.equal(events.filter((e) => e.startsWith('exit')).length, 1);
  assert.equal(exitCode(), 0);
});

test('cleanupTimers is optional — orchestrator copes when it is absent', async () => {
  const { deps, events, exitCode, drained } = makeDeps({ cleanupTimers: undefined });

  await gracefulShutdown(deps);
  await drained();

  assert.ok(!events.includes('cleanupTimers'));
  assert.ok(events.includes('bot.stop(SIGTERM)'));
  assert.equal(exitCode(), 0);
});

test('error thrown by bot.stop does NOT skip state.flush or releaseLock', async () => {
  // Defensive: a misbehaving Telegraf shouldn't strand the lock.
  const { deps, events, exitCode, drained } = makeDeps({
    bot: {
      stop: () => {
        events.push('bot.stop:threw');
        throw new Error('telegraf failure');
      },
    },
  });

  await gracefulShutdown(deps);
  await drained();

  assert.ok(events.includes('state.flush:start'), 'flush must still run');
  assert.ok(events.includes('state.flush:resolved'), 'flush must still resolve');
  assert.ok(events.includes('releaseLock'), 'lock must still be released');
  assert.equal(exitCode(), 0);
});

test('clearTransientFrames runs after cleanupTimers and before state.flush / releaseLock', async () => {
  // The frame sweep must run while Telegram is still up (before bot.stop / the
  // flush) but after the timers are stopped (so no tick re-creates a frame).
  const { deps, events, drained } = makeDeps({
    flushDelayMs: 20,
    clearTransientFrames: async () => {
      events.push('clearTransientFrames');
    },
  });

  await gracefulShutdown(deps);
  await drained();

  const sweepIdx = events.indexOf('clearTransientFrames');
  const cleanupIdx = events.indexOf('cleanupTimers');
  const flushStartIdx = events.indexOf('state.flush:start');
  const releaseIdx = events.indexOf('releaseLock');
  assert.notEqual(sweepIdx, -1, 'clearTransientFrames must run');
  assert.ok(cleanupIdx !== -1 && cleanupIdx < sweepIdx, 'must run AFTER cleanupTimers');
  assert.ok(sweepIdx < flushStartIdx, 'must run BEFORE state.flush');
  assert.ok(sweepIdx < releaseIdx, 'must run BEFORE releaseLock');
});

test('a slow clearTransientFrames still hits the watchdog and forces exit', async () => {
  // A frame sweep slower than the watchdog (e.g. wedged Telegram API) must NOT
  // strand the shutdown: the outer watchdog wins and we still exit(0) +
  // releaseLock, even though the flush is blocked behind the sweep at that point.
  const { deps, events, exitCode, drained } = makeDeps({
    watchdogMs: 50,
    clearTransientFrames: () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
  });

  const start = Date.now();
  await gracefulShutdown(deps);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 180, `watchdog should return promptly; got ${elapsed}ms`);
  assert.equal(exitCode(), 0, 'watchdog must still exit(0) so nodemon respawns');
  assert.ok(events.includes('releaseLock'), `releaseLock must fire; events=${JSON.stringify(events)}`);
  assert.ok(
    !events.includes('state.flush:start'),
    'flush is blocked behind the slow sweep when the watchdog fires',
  );

  // Let the orphan sweep + its trailing flush settle so node:test doesn't flag a
  // pending promise.
  await drained();
});

test('drainPendingUpdates runs AFTER bot.stop and BEFORE state.flush', async () => {
  // The off-loop update queues must drain while polling is already halted
  // (after bot.stop → no new enqueue) but before the flush (so the drained
  // handlers' state writes land in it). Pin that exact slot.
  const { deps, events, exitCode, drained } = makeDeps({
    flushDelayMs: 10,
    drainPendingUpdates: async () => {
      events.push('drainPendingUpdates');
    },
  });

  await gracefulShutdown(deps);
  await drained();

  const stopIdx = events.indexOf('bot.stop(SIGTERM)');
  const drainIdx = events.indexOf('drainPendingUpdates');
  const flushStartIdx = events.indexOf('state.flush:start');
  assert.notEqual(drainIdx, -1, 'drainPendingUpdates must run');
  assert.ok(stopIdx !== -1 && stopIdx < drainIdx, 'must run AFTER bot.stop');
  assert.ok(drainIdx < flushStartIdx, 'must run BEFORE state.flush');
  assert.equal(exitCode(), 0);
});

test('drainPendingUpdates is optional — orchestrator copes when it is absent', async () => {
  // Back-compat: a deps object without the new hook still shuts down cleanly.
  const { deps, events, exitCode, drained } = makeDeps({ flushDelayMs: 5 });

  await gracefulShutdown(deps);
  await drained();

  assert.ok(!events.includes('drainPendingUpdates'));
  assert.ok(events.includes('bot.stop(SIGTERM)'));
  assert.ok(events.includes('state.flush:resolved'));
  assert.equal(exitCode(), 0);
});

test('a thrown drainPendingUpdates does NOT skip state.flush or releaseLock', async () => {
  // A wedged drain must not strand the flush/lock — same defensive contract as
  // the other steps.
  const { deps, events, exitCode, drained } = makeDeps({
    flushDelayMs: 5,
    drainPendingUpdates: async () => {
      events.push('drainPendingUpdates:threw');
      throw new Error('drain failure');
    },
  });

  await gracefulShutdown(deps);
  await drained();

  assert.ok(events.includes('state.flush:start'), 'flush must still run');
  assert.ok(events.includes('state.flush:resolved'), 'flush must still resolve');
  assert.ok(events.includes('releaseLock'), 'lock must still be released');
  assert.equal(exitCode(), 0);
});

test('error thrown by state.flush does NOT skip releaseLock or exit', async () => {
  // Custom state.flush below replaces the default, so its `drained()`
  // contract no longer applies — we hand-await the orchestrator and
  // there's nothing extra to drain.
  const events: string[] = [];
  let exitCode: number | null = null;
  const deps: ShutdownDeps = {
    signal: 'SIGTERM',
    bot: { stop: (s) => events.push(`bot.stop(${s ?? ''})`) },
    state: {
      flush: async () => {
        events.push('state.flush:threw');
        throw new Error('disk full');
      },
    },
    releaseLock: () => events.push('releaseLock'),
    exit: (code) => { if (exitCode === null) { exitCode = code; events.push(`exit(${code})`); } },
    log: () => {},
    watchdogMs: 100,
  };

  await gracefulShutdown(deps);

  assert.ok(events.includes('releaseLock'), `releaseLock missing; events=${JSON.stringify(events)}`);
  assert.equal(exitCode, 0, 'we still exit so nodemon can respawn');
});
