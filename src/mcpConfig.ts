/**
 * @description MCP-config plumbing for the Claude CLI.
 *
 * Claude resolves MCP servers from four places:
 *   1. `~/.claude/settings.json` — user level, picked up automatically.
 *   2. `${DATA_DIR}/mcp.json` — group level (this instance), passed via
 *      `--mcp-config` so two bot instances under the same Linux user can
 *      have different MCP fleets.
 *   3. `${workDir}/.mcp.json` — project level, picked up automatically
 *      from cwd.
 *   4. `${DATA_DIR}/threads/<key>.json` — optional per-thread override,
 *      passed via a second `--mcp-config`.
 *
 * Plan §19.1 / §19.7 / D25-D33.
 *
 * This module owns two responsibilities:
 *   - **`${VAR}` expansion**. Claude CLI does NOT shell-expand placeholders
 *     inside `--mcp-config` JSON (plan §13.18, T2), so the bot resolves
 *     them itself against `process.env` and writes the expanded copy to a
 *     short-lived tmp file (mode 0600) before passing the tmp path to
 *     Claude.
 *   - **Lifecycle**. Tmp files are stable per ThreadKey (one for group
 *     scope, one for thread scope), so multiple `startSession` calls don't
 *     pile up junk. `cleanupMcpTempFiles` is called from
 *     `claudeCliAdapter.stopSession` to remove them once the session ends.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ThreadKey } from './types';
import { keyToString } from './types';

export interface PrepareMcpOptions {
  key: ThreadKey;
  dataDir: string;
}

/**
 * @description Recursively replace `${VAR}` placeholders in every *string*
 * value of a JSON-shaped value. Unknown env-vars are left as-is — that lets
 * a half-configured environment surface the placeholder verbatim instead of
 * silently substituting empty strings (which often pass auth checks).
 *
 * Only the `${VAR}` form is supported; `$VAR` is intentionally ignored
 * because it'd false-match shell substitutions baked into command strings
 * (e.g. `bash -c '$HOME/...'`).
 */
export function expandEnvVars<T>(node: T): T {
  if (typeof node === 'string') {
    // Only the uppercase `${VAR}` form is recognised — matches POSIX env-var
    // convention and dodges false matches inside command strings that
    // happen to contain `${path}`-shaped placeholders for downstream tools.
    return node.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (m, name) => {
      const value = process.env[name];
      return value !== undefined ? value : m;
    }) as unknown as T;
  }
  if (Array.isArray(node)) {
    return node.map(expandEnvVars) as unknown as T;
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = expandEnvVars(v);
    }
    return out as unknown as T;
  }
  return node;
}

/**
 * @description Read a JSON file, apply `${VAR}` expansion and write the
 * expanded copy to a sibling tmp path with `0600` perms. The tmp directory
 * is created with `0700` so other users on the same host can't sniff
 * secrets even briefly.
 *
 * Returns the absolute tmp path on success, `null` if the source file
 * doesn't exist (legitimate — the operator just hasn't configured this
 * level), or if parsing failed (we surface a console warning rather than
 * propagating, so a broken config can't gate the whole agent start).
 */
function writeExpandedTmp(sourcePath: string, tmpPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sourcePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn(`[mcp] cannot read ${sourcePath}:`, e);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`[mcp] invalid JSON in ${sourcePath}, skipping:`, e);
    return null;
  }

  const expanded = expandEnvVars(parsed);
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true, mode: 0o700 });
  // Truncating write into a fixed per-key path: one tmp file per (key,
  // scope) means a second startSession overwrites the previous one rather
  // than piling up junk. `chmodSync` immediately after the write tightens
  // perms in case the umask widened the openSync mode.
  try {
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(expanded)); }
    finally { fs.closeSync(fd); }
    fs.chmodSync(tmpPath, 0o600);
  } catch (e) {
    console.warn(`[mcp] cannot write tmp ${tmpPath}:`, e);
    return null;
  }
  return tmpPath;
}

function groupMcpSource(dataDir: string): string {
  return path.join(dataDir, 'mcp.json');
}

function threadMcpSource(dataDir: string, key: ThreadKey): string {
  return path.join(dataDir, 'threads', `${keyToString(key)}.json`);
}

function groupMcpTmp(dataDir: string, key: ThreadKey): string {
  return path.join(dataDir, 'tmp', `mcp-${keyToString(key)}-group.json`);
}

function threadMcpTmp(dataDir: string, key: ThreadKey): string {
  return path.join(dataDir, 'tmp', `mcp-${keyToString(key)}-thread.json`);
}

/**
 * @description Build the `--mcp-config <path>` argument pairs to interleave
 * into the Claude CLI invocation for a fresh or resumed session. Returns
 * an empty array when neither group nor thread level has a config — claude
 * will then rely solely on the auto-loaded user + project files, which is
 * the right default for a bot that hasn't been configured with bespoke
 * tooling yet.
 *
 * The function is sync (`fs.*Sync`) on purpose — startSession is already
 * sequenced before tmux send-keys, and the synchronous block (≈ low ms on
 * small JSON files) is cheaper than the await ceremony. Both source files
 * combined are kept under a few KB by design.
 */
export function prepareMcpFlags(opts: PrepareMcpOptions): string[] {
  const flags: string[] = [];

  const groupPath = writeExpandedTmp(
    groupMcpSource(opts.dataDir),
    groupMcpTmp(opts.dataDir, opts.key),
  );
  if (groupPath) flags.push('--mcp-config', groupPath);

  const threadPath = writeExpandedTmp(
    threadMcpSource(opts.dataDir, opts.key),
    threadMcpTmp(opts.dataDir, opts.key),
  );
  if (threadPath) flags.push('--mcp-config', threadPath);

  return flags;
}

/**
 * @description Remove the tmp MCP files we wrote for this thread. Called
 * from `claudeCliAdapter.stopSession` so secrets don't linger after the
 * session ends. Missing files are silently ignored — `stopSession` may run
 * for a thread that never had MCP configured.
 */
export function cleanupMcpTempFiles(opts: PrepareMcpOptions): void {
  for (const tmp of [groupMcpTmp(opts.dataDir, opts.key), threadMcpTmp(opts.dataDir, opts.key)]) {
    try { fs.unlinkSync(tmp); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[mcp] failed to remove ${tmp}:`, e);
      }
    }
  }
}
