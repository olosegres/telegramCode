/**
 * Test case: N/A — telegramCode has no Jira tracker
 *
 * @description OpenCode provider API-key connection through `/connect`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenCodeAdapter,
  buildProviderApiAuthPayload,
  buildProviderAuthPath,
  checkIsValidProviderId,
  checkProviderSupportsSimpleApiAuth,
} from '../adapters/openCodeAdapter';
import type { ThreadKey } from '../types';

interface ApiCall {
  method: string;
  urlPath: string;
  body?: unknown;
}

function createConnectAdapter(providerAuth: unknown): {
  adapter: OpenCodeAdapter;
  calls: ApiCall[];
} {
  const adapter = new OpenCodeAdapter();
  const calls: ApiCall[] = [];

  adapter['ensureProviderAuthServerReady'] = async () => {};
  adapter['apiRequest'] = async (method: string, urlPath: string, body?: unknown) => {
    calls.push({ method, urlPath, body });
    if (method === 'GET' && urlPath === '/provider/auth') return providerAuth;
    if (method === 'PUT') return undefined;
    throw new Error(`unexpected call ${method} ${urlPath}`);
  };

  return { adapter, calls };
}

describe('OpenCode provider connect helpers', () => {
  it('builds the API-key auth route and body without leaking the key into the URL', () => {
    assert.equal(buildProviderAuthPath('openai'), '/auth/openai');
    assert.equal(buildProviderAuthPath('github-copilot'), '/auth/github-copilot');
    assert.deepEqual(buildProviderApiAuthPayload('sk-test-secret'), {
      type: 'api',
      key: 'sk-test-secret',
    });
  });

  it('accepts only provider ids that are safe path segments', () => {
    assert.equal(checkIsValidProviderId('openai'), true);
    assert.equal(checkIsValidProviderId('github-copilot'), true);
    assert.equal(checkIsValidProviderId('cloudflare_workers'), true);
    assert.equal(checkIsValidProviderId('../openai'), false);
    assert.equal(checkIsValidProviderId('OpenAI'), false);
    assert.equal(checkIsValidProviderId(''), false);
  });

  it('detects only API-key auth methods that need no extra prompts', () => {
    const providerAuth = {
      openai: [{ type: 'oauth' }, { type: 'api' }],
      gitlab: [{ type: 'api', prompts: [{ key: 'instanceUrl' }] }],
      xai: [{ type: 'api', prompts: [] }],
    };

    assert.equal(checkProviderSupportsSimpleApiAuth(providerAuth, 'openai'), true);
    assert.equal(checkProviderSupportsSimpleApiAuth(providerAuth, 'xai'), true);
    assert.equal(checkProviderSupportsSimpleApiAuth(providerAuth, 'gitlab'), false);
    assert.equal(checkProviderSupportsSimpleApiAuth(providerAuth, 'missing'), false);
  });
});

describe('OpenCodeAdapter.connectProvider', () => {
  const key: ThreadKey = { chatId: -100, threadId: 9085 };

  it('checks provider auth support then PUTs the API-key auth payload', async () => {
    const { adapter, calls } = createConnectAdapter({ openai: [{ type: 'api' }] });

    const result = await adapter.connectProvider(key, 'openai', ' sk-test-secret ');

    assert.equal(result, null);
    assert.deepEqual(calls, [
      { method: 'GET', urlPath: '/provider/auth', body: undefined },
      {
        method: 'PUT',
        urlPath: '/auth/openai',
        body: { type: 'api', key: 'sk-test-secret' },
      },
    ]);
  });

  it('does not PUT when the provider requires extra auth prompts', async () => {
    const { adapter, calls } = createConnectAdapter({ gitlab: [{ type: 'api', prompts: [{ key: 'instanceUrl' }] }] });

    const result = await adapter.connectProvider(key, 'gitlab', 'glpat-test-secret');

    assert.ok(typeof result === 'string' && result.includes('gitlab'));
    assert.deepEqual(calls, [{ method: 'GET', urlPath: '/provider/auth', body: undefined }]);
  });

  it('rejects an unsafe provider id before any OpenCode request', async () => {
    const { adapter, calls } = createConnectAdapter({ openai: [{ type: 'api' }] });

    const result = await adapter.connectProvider(key, '../openai', 'sk-test-secret');

    assert.ok(typeof result === 'string' && result.length > 0);
    assert.equal(calls.length, 0);
  });
});
