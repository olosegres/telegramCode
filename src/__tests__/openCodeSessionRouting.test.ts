import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkIsEventForSession,
  updateSessionLineage,
} from '../openCodeSessionRouting';

// `checkIsEventForSession(eventSessionId, ownedSessionId, childToParent)` is
// the pure predicate behind OpenCode SSE routing: an event belongs to a topic
// if it targets the bound session directly OR a subagent (child) session whose
// lineage walks up to it. Each branch below proves a distinct rule so a
// regression fails loudly.

const ownedParent = 'ses_parent';

test('an event for the bound session itself matches', () => {
  assert.equal(checkIsEventForSession(ownedParent, ownedParent, new Map()), true);
});

test('a direct child (subagent) session matches its parent', () => {
  const lineage = new Map([['ses_child', ownedParent]]);
  assert.equal(checkIsEventForSession('ses_child', ownedParent, lineage), true);
});

test('a grandchild matches up the chain', () => {
  const lineage = new Map([
    ['ses_grandchild', 'ses_child'],
    ['ses_child', ownedParent],
  ]);
  assert.equal(checkIsEventForSession('ses_grandchild', ownedParent, lineage), true);
});

test('an unrelated session with no lineage does not match', () => {
  assert.equal(checkIsEventForSession('ses_other', ownedParent, new Map()), false);
});

test('a child of a different parent does not match', () => {
  const lineage = new Map([['ses_child', 'ses_otherParent']]);
  assert.equal(checkIsEventForSession('ses_child', ownedParent, lineage), false);
});

test('cyclic lineage terminates and does not match when no owner is reachable', () => {
  const lineage = new Map([
    ['ses_a', 'ses_b'],
    ['ses_b', 'ses_a'],
  ]);
  assert.equal(checkIsEventForSession('ses_a', ownedParent, lineage), false);
});

test('cyclic lineage still matches when the owner is reachable first', () => {
  const lineage = new Map([
    ['ses_child', ownedParent],
    [ownedParent, 'ses_child'],
  ]);
  assert.equal(checkIsEventForSession('ses_child', ownedParent, lineage), true);
});

// `updateSessionLineage` records child→parent links learned from
// `session.updated`, keeping the map bounded and rejecting ids that aren't
// real sessions. Each case locks in one rule.

const maxLineageEntries = 3;

test('records a new child→parent link and reports it as changed', () => {
  const lineage = new Map<string, string>();
  assert.equal(updateSessionLineage(lineage, 'ses_child', 'ses_parent', maxLineageEntries), true);
  assert.equal(lineage.get('ses_child'), 'ses_parent');
});

test('ignores a root session with no parent', () => {
  const lineage = new Map<string, string>();
  assert.equal(updateSessionLineage(lineage, 'ses_child', undefined, maxLineageEntries), false);
  assert.equal(lineage.size, 0);
});

test('ignores ids without the ses_ prefix (e.g. a msg_ id)', () => {
  const lineage = new Map<string, string>();
  assert.equal(updateSessionLineage(lineage, 'msg_child', 'ses_parent', maxLineageEntries), false);
  assert.equal(updateSessionLineage(lineage, 'ses_child', 'msg_parent', maxLineageEntries), false);
  assert.equal(lineage.size, 0);
});

test('reports an unchanged duplicate link as not changed', () => {
  const lineage = new Map([['ses_child', 'ses_parent']]);
  assert.equal(updateSessionLineage(lineage, 'ses_child', 'ses_parent', maxLineageEntries), false);
  assert.equal(lineage.size, 1);
});

test('evicts the oldest entry once the cap is exceeded', () => {
  const lineage = new Map<string, string>();
  updateSessionLineage(lineage, 'ses_1', 'ses_p', maxLineageEntries);
  updateSessionLineage(lineage, 'ses_2', 'ses_p', maxLineageEntries);
  updateSessionLineage(lineage, 'ses_3', 'ses_p', maxLineageEntries);
  updateSessionLineage(lineage, 'ses_4', 'ses_p', maxLineageEntries);
  assert.equal(lineage.size, maxLineageEntries);
  assert.equal(lineage.has('ses_1'), false);
  assert.equal(lineage.has('ses_4'), true);
});
