/**
 * @description The single source of the scheduler MCP server entry injected into
 * every bot-started agent session (plan S6). Both backends get the SAME bot-owned
 * `telegramBot` server, just shaped for their respective MCP-config formats:
 *   - Claude reads a `--mcp-config` file with a streamable-HTTP `mcpServers` entry
 *     (thread-scoped token).
 *   - OpenCode is registered at runtime via `POST /mcp?directory=` with a `remote`
 *     server entry (directory-scoped token).
 *
 * This server is bot-owned plumbing — it is NOT part of the user-editable `/mcp`
 * hierarchy (`mcpConfig.ts`) and is never written into the user's group/thread
 * config files.
 *
 * INERT until S8 calls {@link configureSchedulerMcpInjection} at boot: unconfigured,
 * every builder returns `null`, so the `prepareMcpFlags` / OpenCode-registration
 * call sites behave byte-identically to before the scheduler existed. The module
 * imports nothing from `bot.ts`; the secret + port arrive through the config
 * singleton, mirroring how `mcpSurface.ts` takes its deps injected.
 */

import { randomUUID } from 'node:crypto';
import { keyToString, type ThreadKey } from '../types';
import {
  buildSchedulerMcpToken,
  schedulerMcpClientIdHeader,
  schedulerMcpPath,
  type SchedulerScope,
} from './mcpSurface';

/** The fixed MCP server name both backends register the injected entry under. */
export const schedulerMcpServerName = 'telegramBot';

/**
 * @name SchedulerInjectionConfig
 * @description The boot-supplied dependencies (S8 wires these). `getSecret`
 * returns the persisted HMAC secret used to mint scope tokens (same secret the
 * server verifies against in {@link mcpSurface}); `port` is the bound listen
 * port (resolved after the server starts, since a `0` request port becomes an
 * ephemeral one) so the injected url points at the real listener.
 */
interface SchedulerInjectionConfig {
  getSecret: () => Promise<string>;
  port: number;
}

/**
 * Module-level singleton. `null` = unconfigured = inert: every builder returns
 * `null` and the call sites add nothing. Set exactly once by S8 at boot.
 */
let injectionConfig: SchedulerInjectionConfig | null = null;

/**
 * @description Activate scheduler MCP injection (plan S8 calls this at boot,
 * after the MCP server's `start()` resolves so the bound port is known). Until
 * called, all builders are inert. Re-calling overwrites the config (e.g. a
 * server restart that rebinds a different ephemeral port).
 */
export function configureSchedulerMcpInjection(config: SchedulerInjectionConfig): void {
  injectionConfig = config;
}

/**
 * @description Reset to the inert state. Intended for tests (and a future
 * shutdown path) so a configured singleton can't leak across cases.
 */
export function resetSchedulerMcpInjection(): void {
  injectionConfig = null;
}

/** The loopback url the injected entry points at: `http://127.0.0.1:<port>/mcp`. */
function buildSchedulerMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}${schedulerMcpPath}`;
}

/**
 * @description Mint a bearer token for a scope using the configured secret.
 * Reuses {@link buildSchedulerMcpToken} (and via it `serializeSchedulerScope`)
 * so the token math lives in exactly one place. Returns `null` when inert.
 */
async function buildBearerHeader(scope: SchedulerScope): Promise<string | null> {
  if (!injectionConfig) return null;
  const secret = await injectionConfig.getSecret();
  return `Bearer ${buildSchedulerMcpToken(secret, scope)}`;
}

/**
 * @name ClaudeSchedulerMcpConfig
 * @description The exact JSON shape written to the bot-generated `--mcp-config`
 * file for Claude: a single streamable-HTTP `mcpServers` entry keyed by
 * {@link schedulerMcpServerName}, carrying the thread-scoped bearer token.
 */
export interface ClaudeSchedulerMcpConfig {
  mcpServers: {
    [schedulerMcpServerName]: {
      type: 'http';
      url: string;
      headers: {
        Authorization: string;
        [schedulerMcpClientIdHeader]: string;
      };
    };
  };
}

/**
 * @description Build the Claude `--mcp-config` payload for a thread, scoped to
 * that exact thread (`thread:<key>`). Returns `null` when injection is inert
 * (S8 not wired) so the caller adds no extra flag. The thread key is serialised
 * with {@link keyToString} — the same canonical form `serializeSchedulerScope`
 * signs — so the token the server later verifies resolves to this exact thread.
 */
export async function buildClaudeSchedulerMcpConfig(
  threadKey: ThreadKey,
): Promise<ClaudeSchedulerMcpConfig | null> {
  if (!injectionConfig) return null;
  const scope: SchedulerScope = { kind: 'thread', threadKey: keyToString(threadKey) };
  const authorization = await buildBearerHeader(scope);
  if (authorization === null) return null;
  return {
    mcpServers: {
      [schedulerMcpServerName]: {
        type: 'http',
        url: buildSchedulerMcpUrl(injectionConfig.port),
        headers: {
          Authorization: authorization,
          [schedulerMcpClientIdHeader]: randomUUID(),
        },
      },
    },
  };
}

/**
 * @name OpenCodeSchedulerMcpRegistration
 * @description The body posted to OpenCode's runtime `POST /mcp?directory=` to
 * register the injected server for a bound folder, scoped to that directory
 * (`dir:<path>`). OpenCode's runtime MCP shape is `remote` (vs Claude's `http`),
 * `enabled: true`, with the directory-scoped bearer token in `headers`.
 */
export interface OpenCodeSchedulerMcpRegistration {
  name: typeof schedulerMcpServerName;
  config: {
    type: 'remote';
    url: string;
    enabled: true;
    headers: {
      Authorization: string;
      [schedulerMcpClientIdHeader]: string;
    };
  };
}

/**
 * @description Build the OpenCode runtime MCP registration body for a directory,
 * scoped to that directory (`dir:<path>`). Returns `null` when injection is
 * inert. The directory is the bound folder (the OpenCode instance selector); the
 * server resolves the single bound thread implicitly, or requires `threadKey`
 * when the folder has more than one bound thread (see `resolveTargetThreadKey`).
 */
export async function buildOpenCodeSchedulerMcpRegistration(
  directory: string,
): Promise<OpenCodeSchedulerMcpRegistration | null> {
  if (!injectionConfig) return null;
  const scope: SchedulerScope = { kind: 'dir', directory };
  const authorization = await buildBearerHeader(scope);
  if (authorization === null) return null;
  return {
    name: schedulerMcpServerName,
    config: {
      type: 'remote',
      url: buildSchedulerMcpUrl(injectionConfig.port),
      enabled: true,
      headers: {
        Authorization: authorization,
        [schedulerMcpClientIdHeader]: randomUUID(),
      },
    },
  };
}
