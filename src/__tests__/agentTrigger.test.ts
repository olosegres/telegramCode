/**
 * @description Audit S19 / #25: regression tests for the NL agent-start
 * regex extracted into `src/agentTrigger.ts`. The synonym list is the
 * kind of thing that silently rots when a contributor "fixes" a
 * spelling — these tests pin the surface.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseAgentTrigger } from '../agentTrigger';

test('bare claude triggers match (ru + en)', () => {
  for (const phrase of ['клод', 'клауд', 'клоуд', 'claude', 'cloud', 'CLAUDE']) {
    const m = parseAgentTrigger(phrase);
    assert.deepEqual(m, { isMatch: true, adapterName: 'claude' }, `failed for "${phrase}"`);
  }
});

test('bare opencode triggers match (ru + en + spacing)', () => {
  for (const phrase of ['opencode', 'OPENCODE', 'опенкод', 'open code', 'опен код']) {
    const m = parseAgentTrigger(phrase);
    assert.deepEqual(m, { isMatch: true, adapterName: 'opencode' }, `failed for "${phrase}"`);
  }
});

test('"запусти <agent>" forms match', () => {
  assert.deepEqual(parseAgentTrigger('Запусти клода'), { isMatch: true, adapterName: 'claude' });
  assert.deepEqual(parseAgentTrigger('запусти opencode'), { isMatch: true, adapterName: 'opencode' });
});

test('trigger word + space + prompt captures the prompt as args', () => {
  const m = parseAgentTrigger('Claude refactor src/bot.ts');
  assert.equal(m.isMatch, true);
  assert.equal(m.adapterName, 'claude');
  assert.equal(m.args, 'refactor src/bot.ts');
});

test('trigger with prompt: opencode + cyrillic args', () => {
  const m = parseAgentTrigger('опенкод почини баг с роутингом');
  assert.equal(m.isMatch, true);
  assert.equal(m.adapterName, 'opencode');
  assert.equal(m.args, 'почини баг с роутингом');
});

test('trailing punctuation on bare trigger is tolerated', () => {
  for (const phrase of ['клод!', 'claude.', 'opencode?', 'опенкод,']) {
    const m = parseAgentTrigger(phrase);
    assert.equal(m.isMatch, true, `failed for "${phrase}"`);
  }
});

test('unrelated text does not match', () => {
  for (const phrase of [
    '',
    'hello',
    'cloudy weather',
    'open browser',
    'where is opencode now',  // not at start
    'cl0d',                    // typo not in list
  ]) {
    const m = parseAgentTrigger(phrase);
    assert.equal(m.isMatch, false, `unexpected match for "${phrase}"`);
  }
});
