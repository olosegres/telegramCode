import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaGroupCollector } from '../utils/mediaGroupCollector';

/** Resolve after `ms` real milliseconds — drives the debounce with real timers. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short debounce so the suite stays fast while exercising real timers. */
const testDebounceMs = 50;

describe('createMediaGroupCollector — debounced batching', () => {
  it('flushes ONE batch with all items in arrival order', async () => {
    const flushes: Array<{ groupKey: string; items: number[] }> = [];
    const collector = createMediaGroupCollector<number>({
      debounceMs: testDebounceMs,
      onFlush: (groupKey, items) => flushes.push({ groupKey, items }),
    });

    collector.collect('g', 1);
    collector.collect('g', 2);
    collector.collect('g', 3);
    assert.equal(flushes.length, 0, 'must not flush before the quiet period');

    await wait(testDebounceMs * 2);
    assert.equal(flushes.length, 1, 'one combined flush, not three');
    assert.deepEqual(flushes[0], { groupKey: 'g', items: [1, 2, 3] });
    assert.equal(collector.size, 0, 'group dropped after flush');
  });

  it('resets the debounce when a late item arrives (no premature flush)', async () => {
    const flushes: number[][] = [];
    const collector = createMediaGroupCollector<number>({
      debounceMs: testDebounceMs,
      onFlush: (_groupKey, items) => flushes.push(items),
    });

    collector.collect('g', 1);
    // Wait almost the full window, then add a late item that must re-arm it.
    await wait(testDebounceMs * 0.6);
    collector.collect('g', 2);
    // Original timer would have fired by now had it NOT reset.
    await wait(testDebounceMs * 0.6);
    assert.equal(flushes.length, 0, 'late item must reset the timer');

    await wait(testDebounceMs);
    assert.deepEqual(flushes, [[1, 2]], 'both items flush together after the reset window');
  });

  it('keeps two groups independent (own timers, own batches)', async () => {
    const flushes: Array<{ groupKey: string; items: number[] }> = [];
    const collector = createMediaGroupCollector<number>({
      debounceMs: testDebounceMs,
      onFlush: (groupKey, items) => flushes.push({ groupKey, items }),
    });

    collector.collect('a', 1);
    collector.collect('b', 10);
    collector.collect('a', 2);
    collector.collect('b', 20);
    assert.equal(collector.size, 2);

    await wait(testDebounceMs * 2);
    const byKey = new Map(flushes.map((f) => [f.groupKey, f.items]));
    assert.deepEqual(byKey.get('a'), [1, 2]);
    assert.deepEqual(byKey.get('b'), [10, 20]);
    assert.equal(flushes.length, 2, 'one flush per group');
  });

  it('starts a fresh group after a flush (same key reused)', async () => {
    const flushes: number[][] = [];
    const collector = createMediaGroupCollector<number>({
      debounceMs: testDebounceMs,
      onFlush: (_groupKey, items) => flushes.push(items),
    });

    collector.collect('g', 1);
    await wait(testDebounceMs * 2);
    collector.collect('g', 2);
    await wait(testDebounceMs * 2);

    assert.deepEqual(flushes, [[1], [2]], 'second album under the same key is its own batch');
  });
});

describe('createMediaGroupCollector — per-group one-shot announcement', () => {
  it('returns true once, then false until the group flushes', async () => {
    const collector = createMediaGroupCollector<number>({
      debounceMs: testDebounceMs,
      onFlush: () => {},
    });

    assert.equal(collector.checkShouldAnnounceOnce('g'), true, 'first claim wins');
    assert.equal(collector.checkShouldAnnounceOnce('g'), false, 'subsequent claims suppressed');
    assert.equal(collector.checkShouldAnnounceOnce('g'), false);

    // An item-less group still exists to hold the claim and flushes on timeout.
    await wait(testDebounceMs * 2);
    assert.equal(collector.size, 0, 'claim-only group is dropped on flush');

    // After the group is gone, the guard re-opens for a brand-new album.
    assert.equal(collector.checkShouldAnnounceOnce('g'), true, 'guard re-opens for a new group');
  });

  it('tracks the announcement guard independently per group', () => {
    const collector = createMediaGroupCollector<number>({
      debounceMs: testDebounceMs,
      onFlush: () => {},
    });

    assert.equal(collector.checkShouldAnnounceOnce('a'), true);
    assert.equal(collector.checkShouldAnnounceOnce('b'), true, 'group b has its own guard');
    assert.equal(collector.checkShouldAnnounceOnce('a'), false);
    assert.equal(collector.checkShouldAnnounceOnce('b'), false);
  });

  it('clears the guard after a flush carrying real items', async () => {
    const collector = createMediaGroupCollector<number>({
      debounceMs: testDebounceMs,
      onFlush: () => {},
    });

    collector.collect('g', 1);
    assert.equal(collector.checkShouldAnnounceOnce('g'), true, 'claimable while the album is open');
    await wait(testDebounceMs * 2);
    assert.equal(collector.checkShouldAnnounceOnce('g'), true, 'guard reset once the album flushed');
  });
});
