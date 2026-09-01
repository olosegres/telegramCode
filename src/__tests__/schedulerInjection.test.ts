/**
 * @description Coverage for `scheduler/injection.ts` (plan S6) — the single
 * source of the bot-owned `telegramBot` MCP entry injected into both backends.
 *
 *   - INERT until configured: both builders return `null` so the call sites add
 *     nothing (byte-identical pre-scheduler behavior; S8 not wired).
 *   - CONFIGURED: exact config shapes per backend (Claude `http`, OpenCode
 *     `remote`), url carries the configured port + `/mcp` path, and the bearer
 *     token verifies against the secret via the mcpSurface verify helper to the
 *     CORRECT scope kind (thread for Claude, dir for OpenCode).
 *   - reset returns to inert.
 *
 * Load-bearing: the token is round-tripped through `verifySchedulerMcpToken`, so
 * a wrong secret, wrong scope kind, or malformed token fails the assertion — not
 * just "a string is present".
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyToString, type ThreadKey } from '../types';
import {
  configureSchedulerMcpInjection,
  resetSchedulerMcpInjection,
  buildClaudeSchedulerMcpConfig,
  buildOpenCodeSchedulerMcpRegistration,
  schedulerMcpServerName,
} from '../scheduler/injection';
import {
  schedulerMcpClientIdHeader,
  verifySchedulerMcpToken,
} from '../scheduler/mcpSurface';

const secret = 'a'.repeat(64);
const port = 4097;
const threadKey: ThreadKey = { chatId: -1001234567890, threadId: 11 };
const threadKeyString = keyToString(threadKey);
const directory = '/work/project-x';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Strip the `Bearer ` prefix from an Authorization header. */
function bearerToken(authorization: string): string {
  assert.match(authorization, /^Bearer /);
  return authorization.slice('Bearer '.length);
}

afterEach(() => {
  resetSchedulerMcpInjection();
});

describe('scheduler MCP injection — inert (unconfigured)', () => {
  it('Claude builder returns null', async () => {
    assert.equal(await buildClaudeSchedulerMcpConfig(threadKey), null);
  });

  it('OpenCode builder returns null', async () => {
    assert.equal(await buildOpenCodeSchedulerMcpRegistration(directory), null);
  });

  it('reset returns to inert after a config', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    assert.notEqual(await buildClaudeSchedulerMcpConfig(threadKey), null);
    resetSchedulerMcpInjection();
    assert.equal(await buildClaudeSchedulerMcpConfig(threadKey), null);
    assert.equal(await buildOpenCodeSchedulerMcpRegistration(directory), null);
  });
});

describe('scheduler MCP injection — Claude config (configured)', () => {
  it('builds the exact http shape with a thread-scoped token', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const config = await buildClaudeSchedulerMcpConfig(threadKey);
    assert.ok(config);

    const entry = config.mcpServers[schedulerMcpServerName];
    assert.ok(entry, 'entry keyed by the scheduler server name');
    assert.equal(entry.type, 'http');
    assert.equal(entry.url, `http://127.0.0.1:${port}/mcp`);
    assert.match(entry.headers[schedulerMcpClientIdHeader], uuidPattern);

    // Token verifies to the EXACT thread scope.
    const scope = verifySchedulerMcpToken(secret, bearerToken(entry.headers.Authorization));
    assert.deepEqual(scope, { kind: 'thread', threadKey: threadKeyString });
  });

  it('uses the configured port in the url', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port: 5099 });
    const config = await buildClaudeSchedulerMcpConfig(threadKey);
    assert.ok(config);
    assert.equal(config.mcpServers[schedulerMcpServerName].url, 'http://127.0.0.1:5099/mcp');
  });

  it('mints a token a wrong secret cannot verify', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const config = await buildClaudeSchedulerMcpConfig(threadKey);
    assert.ok(config);
    const token = bearerToken(config.mcpServers[schedulerMcpServerName].headers.Authorization);
    assert.equal(verifySchedulerMcpToken('b'.repeat(64), token), null);
  });

  it('generates a fresh client identity for each Claude config', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const firstConfig = await buildClaudeSchedulerMcpConfig(threadKey);
    const secondConfig = await buildClaudeSchedulerMcpConfig(threadKey);
    assert.ok(firstConfig);
    assert.ok(secondConfig);

    const firstClientId = firstConfig.mcpServers[schedulerMcpServerName]
      .headers[schedulerMcpClientIdHeader];
    const secondClientId = secondConfig.mcpServers[schedulerMcpServerName]
      .headers[schedulerMcpClientIdHeader];
    assert.match(firstClientId, uuidPattern);
    assert.match(secondClientId, uuidPattern);
    assert.notEqual(firstClientId, secondClientId);
  });
});

describe('scheduler MCP injection — OpenCode registration (configured)', () => {
  it('builds the exact remote shape with a dir-scoped token', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const registration = await buildOpenCodeSchedulerMcpRegistration(directory);
    assert.ok(registration);

    assert.equal(registration.name, schedulerMcpServerName);
    assert.equal(registration.config.type, 'remote');
    assert.equal(registration.config.enabled, true);
    assert.equal(registration.config.url, `http://127.0.0.1:${port}/mcp`);
    assert.match(registration.config.headers[schedulerMcpClientIdHeader], uuidPattern);

    // Token verifies to the EXACT directory scope.
    const scope = verifySchedulerMcpToken(secret, bearerToken(registration.config.headers.Authorization));
    assert.deepEqual(scope, { kind: 'dir', directory });
  });

  it('scopes the token to the given directory, not a thread', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const registration = await buildOpenCodeSchedulerMcpRegistration('/work/other');
    assert.ok(registration);
    const scope = verifySchedulerMcpToken(secret, bearerToken(registration.config.headers.Authorization));
    assert.deepEqual(scope, { kind: 'dir', directory: '/work/other' });
  });

  it('generates a fresh client identity for each OpenCode registration', async () => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
    const firstRegistration = await buildOpenCodeSchedulerMcpRegistration(directory);
    const secondRegistration = await buildOpenCodeSchedulerMcpRegistration(directory);
    assert.ok(firstRegistration);
    assert.ok(secondRegistration);

    const firstClientId = firstRegistration.config.headers[schedulerMcpClientIdHeader];
    const secondClientId = secondRegistration.config.headers[schedulerMcpClientIdHeader];
    assert.match(firstClientId, uuidPattern);
    assert.match(secondClientId, uuidPattern);
    assert.notEqual(firstClientId, secondClientId);
  });
});
