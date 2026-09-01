/**
 * @description Coverage for `mcpConfig.ts` (plan S6 added the bot-generated
 * scheduler `--mcp-config`). Focus on the NEW path; the pre-existing `${VAR}`
 * expansion of user group/thread files is exercised indirectly.
 *
 *   - INERT (injection unconfigured): no scheduler flag is emitted, output is
 *     byte-identical to the pre-scheduler behavior (only user configs, if any).
 *   - CONFIGURED: a third `--mcp-config` is appended; its tmp file round-trips
 *     to the exact Claude config object with a thread-scoped token that verifies
 *     against the secret; the scheduler tmp lives under the bot-owned tmp dir
 *     and never inside the user's group/thread files.
 *   - cleanup removes the scheduler tmp too.
 *
 * Uses a real temp DATA_DIR (no fake HOME needed — prepareMcpFlags takes dataDir
 * explicitly). Load-bearing: the token is verified, not just present, and the
 * inert case asserts the EXACT flag array so a stray flag fails.
 */

/** Test case: N/A — TelegramCode has no Jira tracker. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { keyToString, type ThreadKey } from '../types';
import { prepareMcpFlags, cleanupMcpTempFiles } from '../mcpConfig';
import {
  configureSchedulerMcpInjection,
  resetSchedulerMcpInjection,
  schedulerMcpServerName,
} from '../scheduler/injection';
import {
  schedulerMcpClientIdHeader,
  verifySchedulerMcpToken,
} from '../scheduler/mcpSurface';

const secret = 'a'.repeat(64);
const port = 4097;
const key: ThreadKey = { chatId: -1001234567890, threadId: 11 };
const keyString = keyToString(key);

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-mcpcfg-'));
});

afterEach(() => {
  resetSchedulerMcpInjection();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Pull the `--mcp-config <path>` paths out of the interleaved flag array. */
function configPaths(flags: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === '--mcp-config') paths.push(flags[i + 1]);
  }
  return paths;
}

describe('prepareMcpFlags — scheduler injection inert', () => {
  it('emits NO flags when no user config and injection unconfigured', async () => {
    const flags = await prepareMcpFlags({ key, dataDir });
    assert.deepEqual(flags, []);
  });

  it('emits only the user group config (no scheduler flag) when injection unconfigured', async () => {
    fs.writeFileSync(path.join(dataDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const flags = await prepareMcpFlags({ key, dataDir });
    assert.equal(configPaths(flags).length, 1, 'exactly the group config, no scheduler');
    // The single config is the group tmp, NOT a scheduler tmp.
    assert.match(configPaths(flags)[0], /-group\.json$/);
  });
});

describe('prepareMcpFlags — scheduler injection configured', () => {
  beforeEach(() => {
    configureSchedulerMcpInjection({ getSecret: async () => secret, port });
  });

  it('appends a third bot-generated scheduler config flag', async () => {
    fs.writeFileSync(path.join(dataDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    fs.mkdirSync(path.join(dataDir, 'threads'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'threads', `${keyString}.json`), JSON.stringify({ mcpServers: {} }));

    const flags = await prepareMcpFlags({ key, dataDir });
    const paths = configPaths(flags);
    assert.equal(paths.length, 3, 'group + thread + scheduler');
    // Order: group, thread, scheduler.
    assert.match(paths[0], /-group\.json$/);
    assert.match(paths[1], /-thread\.json$/);
    assert.match(paths[2], /-scheduler\.json$/);
  });

  it('scheduler tmp round-trips to the exact Claude config with a verifiable thread token', async () => {
    const flags = await prepareMcpFlags({ key, dataDir });
    const schedulerPath = configPaths(flags).find((p) => p.endsWith('-scheduler.json'));
    assert.ok(schedulerPath, 'a scheduler config flag is present even with no user configs');

    const written = JSON.parse(fs.readFileSync(schedulerPath, 'utf8'));
    const entry = written.mcpServers[schedulerMcpServerName];
    assert.ok(entry);
    assert.equal(entry.type, 'http');
    assert.equal(entry.url, `http://127.0.0.1:${port}/mcp`);
    assert.match(
      entry.headers[schedulerMcpClientIdHeader],
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const authorization: string = entry.headers.Authorization;
    assert.match(authorization, /^Bearer /);
    const scope = verifySchedulerMcpToken(secret, authorization.slice('Bearer '.length));
    assert.deepEqual(scope, { kind: 'thread', threadKey: keyString });
  });

  it('writes the scheduler tmp under the bot-owned tmp dir, never into user files', async () => {
    const flags = await prepareMcpFlags({ key, dataDir });
    const schedulerPath = configPaths(flags).find((p) => p.endsWith('-scheduler.json'));
    assert.ok(schedulerPath);
    assert.equal(path.dirname(schedulerPath), path.join(dataDir, 'tmp'));
    // The file carries a bearer token — owner-only perms are load-bearing.
    assert.equal(fs.statSync(schedulerPath).mode & 0o777, 0o600, 'token-bearing tmp must be 0600');
    // The user's group/thread source files were never created by us.
    assert.equal(fs.existsSync(path.join(dataDir, 'mcp.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'threads', `${keyString}.json`)), false);
  });

  it('cleanupMcpTempFiles removes the scheduler tmp', async () => {
    const flags = await prepareMcpFlags({ key, dataDir });
    const schedulerPath = configPaths(flags).find((p) => p.endsWith('-scheduler.json'));
    assert.ok(schedulerPath);
    assert.equal(fs.existsSync(schedulerPath), true);

    cleanupMcpTempFiles({ key, dataDir });
    assert.equal(fs.existsSync(schedulerPath), false);
  });
});
