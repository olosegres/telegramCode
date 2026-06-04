import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearThreadOutputQueues,
  type ClearableOutputQueue,
  type ClearableStatusCoalescer,
} from '../utils/clearThreadOutputQueues';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('clearThreadOutputQueues', () => {
  it('drops pendingOutput, cancels the debounce timer, and clears the status frame', async () => {
    let timerFired = false;
    const queue: ClearableOutputQueue = {
      pendingOutput: 'queued delta that must not post after stop',
      // A real armed timer: if clearThreadOutputQueues does NOT cancel it,
      // `timerFired` flips to true and the assertion below fails — this is
      // the load-bearing check (not a synthetic marker).
      debounceTimer: setTimeout(() => {
        timerFired = true;
      }, 10),
    };
    const coalescer: ClearableStatusCoalescer = {
      pendingText: 'Thinking… stale frame that must not surface after stop',
    };

    clearThreadOutputQueues(queue, coalescer);

    assert.equal(queue.pendingOutput, null, 'pendingOutput must be dropped');
    assert.equal(queue.debounceTimer, null, 'debounceTimer handle must be nulled');
    assert.equal(coalescer.pendingText, null, 'status pendingText must be dropped');

    // Wait past the original 10ms timer window: a cancelled timer never fires.
    await delay(30);
    assert.equal(timerFired, false, 'cancelled debounce timer must never fire');
  });

  it('cancels the status defer-retry timer so it never fires after stop', async () => {
    let retryFired = false;
    const coalescer: ClearableStatusCoalescer = {
      pendingText: 'Thinking… deferred during a 429 cooldown',
      // A real armed timer mirroring the cooldown-defer retry: if the clear
      // does NOT cancel it, it fires into a stopped session.
      deferRetryTimer: setTimeout(() => {
        retryFired = true;
      }, 10),
    };

    clearThreadOutputQueues(undefined, coalescer);

    assert.equal(coalescer.pendingText, null, 'status pendingText must be dropped');
    assert.equal(coalescer.deferRetryTimer, null, 'defer-retry timer handle must be nulled');

    await delay(30);
    assert.equal(retryFired, false, 'cancelled defer-retry timer must never fire');
  });

  it('is a no-op on an already-empty queue and coalescer', () => {
    const queue: ClearableOutputQueue = { pendingOutput: null, debounceTimer: null };
    const coalescer: ClearableStatusCoalescer = { pendingText: null };

    clearThreadOutputQueues(queue, coalescer);

    assert.equal(queue.pendingOutput, null);
    assert.equal(queue.debounceTimer, null);
    assert.equal(coalescer.pendingText, null);
  });

  it('tolerates a thread that never queued anything (undefined state)', () => {
    // `clearThreadQueues` in bot.ts looks the maps up with `.get()`, which
    // returns undefined for a thread that never coalesced output — the
    // helper must not throw in that case.
    assert.doesNotThrow(() => clearThreadOutputQueues(undefined, undefined));
  });

  it('clears the output queue even when only the queue exists', () => {
    const queue: ClearableOutputQueue = {
      pendingOutput: 'tail',
      debounceTimer: null,
    };

    clearThreadOutputQueues(queue, undefined);

    assert.equal(queue.pendingOutput, null);
  });

  it('clears the status frame even when only the coalescer exists', () => {
    const coalescer: ClearableStatusCoalescer = { pendingText: 'Thinking…' };

    clearThreadOutputQueues(undefined, coalescer);

    assert.equal(coalescer.pendingText, null);
  });
});
