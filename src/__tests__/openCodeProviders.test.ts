/**
 * @description Plan 2026-05-30-effort-command / S4 + R2. `GET /config/providers`
 * is the source of truth for which reasoning-effort *variants* a model exposes,
 * but its JSON shape varies across OpenCode server versions (array of providers
 * vs. an object keyed by provider id). `parseProvidersResponse` must flatten
 * BOTH into the same `provider → model → config` map, and degrade to an
 * empty map (never throw) on garbage — a parse crash here would take down the
 * whole prompt path.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseProvidersResponse } from '../adapters/openCodeAdapter';

test('parses the ARRAY shape ({ providers: [{ id, models }] })', () => {
  const raw = {
    providers: [
      {
        id: 'anthropic',
        models: {
          'claude-opus-4-8': { variants: { high: {}, max: {} }, limit: { context: 1_000_000 } },
          'claude-haiku': {}, // no variants → []
        },
      },
      {
        id: 'openai',
        models: {
          'gpt-5': { variants: { none: {}, minimal: {}, low: {}, medium: {}, high: {}, xhigh: {} } },
        },
      },
    ],
  };
  const cfg = parseProvidersResponse(raw);
  assert.deepEqual(cfg.providers.get('anthropic')?.get('claude-opus-4-8'), {
    variants: ['high', 'max'], contextWindowTokens: 1_000_000,
  });
  assert.deepEqual(cfg.providers.get('anthropic')?.get('claude-haiku'), {
    variants: [], contextWindowTokens: null,
  });
  assert.deepEqual(
    cfg.providers.get('openai')?.get('gpt-5'),
    { variants: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], contextWindowTokens: null },
  );
});

test('parses the OBJECT shape ({ providers: { <id>: { models } } })', () => {
  const raw = {
    providers: {
      anthropic: {
        models: {
          'claude-sonnet-4-6': { variants: { high: {}, max: {} } },
        },
      },
    },
  };
  const cfg = parseProvidersResponse(raw);
  assert.deepEqual(cfg.providers.get('anthropic')?.get('claude-sonnet-4-6'), {
    variants: ['high', 'max'], contextWindowTokens: null,
  });
});

test('a model whose variants is not an object maps to [] (defensive)', () => {
  const raw = {
    providers: [
      { id: 'x', models: { m1: { variants: ['high', 'max'] }, m2: { variants: null } } },
    ],
  };
  // `variants` as an array or null is malformed → treated as "no variants".
  const cfg = parseProvidersResponse(raw);
  assert.deepEqual(cfg.providers.get('x')?.get('m1'), { variants: [], contextWindowTokens: null });
  assert.deepEqual(cfg.providers.get('x')?.get('m2'), { variants: [], contextWindowTokens: null });
});

test('garbage / missing fields yield an empty map, never throw', () => {
  for (const bad of [null, undefined, 42, 'nope', {}, { providers: 7 }, { providers: null }]) {
    const cfg = parseProvidersResponse(bad);
    assert.equal(cfg.providers.size, 0);
  }
});

test('array entries without a string id are skipped', () => {
  const raw = { providers: [{ models: { m: {} } }, { id: 5, models: {} }] };
  const cfg = parseProvidersResponse(raw);
  assert.equal(cfg.providers.size, 0);
});
