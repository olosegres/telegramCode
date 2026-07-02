/**
 * @description Unit coverage for the pane-RESIZE scrape guard
 * (`utils/paneResizeGuard.ts`) — live incident 2026-07-02, topic 39933: an
 * interactive `tmux attach` resized the pane, tmux re-wrapped the whole
 * scrollback, and the line-SET diff relayed ragged fragments of OLD
 * conversation into the topic on every width flap. The guard must swallow the
 * repaint polls (re-seed, emit nothing), exit as soon as the pane settles, and
 * never wedge a busy pane into permanent silence.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getPaneResizeGuardDecision,
  parsePaneSize,
  resizeSettleMaxPolls,
} from '../utils/paneResizeGuard';

test('parsePaneSize accepts the display-message shape and rejects garbage', () => {
  assert.equal(parsePaneSize('300x50\n'), '300x50');
  assert.equal(parsePaneSize('  210x48  '), '210x48');
  assert.equal(parsePaneSize(''), null);
  assert.equal(parsePaneSize('no server running'), null);
  assert.equal(parsePaneSize('300x'), null);
  assert.equal(parsePaneSize('300x50 extra'), null);
});

test('first successful size read is a baseline, never a resize', () => {
  const decision = getPaneResizeGuardDecision({
    lastSize: null,
    currentSize: '300x50',
    isSettling: false,
    settlePolls: 0,
    isRawChanged: true,
  });
  assert.deepEqual(decision, { action: 'proceed', nextIsSettling: false, nextSettlePolls: 0 });
});

test('unchanged size on a normal poll proceeds', () => {
  const decision = getPaneResizeGuardDecision({
    lastSize: '300x50',
    currentSize: '300x50',
    isSettling: false,
    settlePolls: 0,
    isRawChanged: true,
  });
  assert.equal(decision.action, 'proceed');
  assert.equal(decision.nextIsSettling, false);
});

test('a size change suppresses the poll and enters settling', () => {
  const decision = getPaneResizeGuardDecision({
    lastSize: '300x50',
    currentSize: '210x48',
    isSettling: false,
    settlePolls: 0,
    isRawChanged: true,
  });
  assert.deepEqual(decision, { action: 'suppress', nextIsSettling: true, nextSettlePolls: 1 });
});

test('settling holds while the capture keeps changing at the new size', () => {
  const decision = getPaneResizeGuardDecision({
    lastSize: '210x48',
    currentSize: '210x48',
    isSettling: true,
    settlePolls: 1,
    isRawChanged: true,
  });
  assert.deepEqual(decision, { action: 'suppress', nextIsSettling: true, nextSettlePolls: 2 });
});

test('settling exits when the capture stops changing', () => {
  const decision = getPaneResizeGuardDecision({
    lastSize: '210x48',
    currentSize: '210x48',
    isSettling: true,
    settlePolls: 2,
    isRawChanged: false,
  });
  assert.deepEqual(decision, { action: 'proceed', nextIsSettling: false, nextSettlePolls: 0 });
});

test('flapping back to the original size starts a new suppress cycle', () => {
  const decision = getPaneResizeGuardDecision({
    lastSize: '210x48',
    currentSize: '300x50',
    isSettling: false,
    settlePolls: 0,
    isRawChanged: true,
  });
  assert.deepEqual(decision, { action: 'suppress', nextIsSettling: true, nextSettlePolls: 1 });
});

test('the settle cap force-exits so a busy pane is never wedged silent', () => {
  const decision = getPaneResizeGuardDecision({
    lastSize: '210x48',
    currentSize: '210x48',
    isSettling: true,
    settlePolls: resizeSettleMaxPolls - 1,
    isRawChanged: true,
  });
  assert.deepEqual(decision, { action: 'proceed', nextIsSettling: false, nextSettlePolls: 0 });
});

test('a failed size query mid-settle stays suppressed (bounded by the cap)', () => {
  const held = getPaneResizeGuardDecision({
    lastSize: '210x48',
    currentSize: null,
    isSettling: true,
    settlePolls: 1,
    isRawChanged: true,
  });
  assert.deepEqual(held, { action: 'suppress', nextIsSettling: true, nextSettlePolls: 2 });

  const capped = getPaneResizeGuardDecision({
    lastSize: '210x48',
    currentSize: null,
    isSettling: true,
    settlePolls: resizeSettleMaxPolls - 1,
    isRawChanged: true,
  });
  assert.equal(capped.action, 'proceed');
});

test('a failed size query outside settling never suppresses', () => {
  const decision = getPaneResizeGuardDecision({
    lastSize: '300x50',
    currentSize: null,
    isSettling: false,
    settlePolls: 0,
    isRawChanged: true,
  });
  assert.deepEqual(decision, { action: 'proceed', nextIsSettling: false, nextSettlePolls: 0 });
});

test('incident replay: attach → repaint polls → settle → detach → settle', () => {
  // 300x50 steady state, then attach resizes to 210x48, TUI repaints for two
  // polls, settles, streams normally, then detach flaps back to 300x50.
  const steps: Array<{
    size: string | null;
    isRawChanged: boolean;
    expectAction: 'proceed' | 'suppress';
  }> = [
    { size: '300x50', isRawChanged: false, expectAction: 'proceed' }, // baseline read
    { size: '210x48', isRawChanged: true, expectAction: 'suppress' }, // attach re-wrap
    { size: '210x48', isRawChanged: true, expectAction: 'suppress' }, // SIGWINCH repaint
    { size: '210x48', isRawChanged: false, expectAction: 'proceed' }, // settled
    { size: '210x48', isRawChanged: true, expectAction: 'proceed' }, // real output relays
    { size: '300x50', isRawChanged: true, expectAction: 'suppress' }, // detach re-wrap
    { size: '300x50', isRawChanged: false, expectAction: 'proceed' }, // settled again
  ];

  let lastSize: string | null = null;
  let isSettling = false;
  let settlePolls = 0;
  for (const [index, step] of steps.entries()) {
    const decision = getPaneResizeGuardDecision({
      lastSize,
      currentSize: step.size,
      isSettling,
      settlePolls,
      isRawChanged: step.isRawChanged,
    });
    assert.equal(decision.action, step.expectAction, `step ${index}`);
    if (step.size !== null) lastSize = step.size;
    isSettling = decision.nextIsSettling;
    settlePolls = decision.nextSettlePolls;
  }
});
