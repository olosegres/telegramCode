import { execSync, execFileSync, exec, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import { sleep } from './utils';

const npmPrefix = (process.env.HOME || '/home/agent') + '/.npm-global';

/** Map of tool name → npm package name */
const toolPackages: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  opencode: 'opencode-ai',
};

/**
 * @description Get custom binary path for a tool if configured via env var.
 * E.g. OPENCODE_BIN=/path/to/opencode for custom opencode binary.
 */
function getCustomBinaryPath(toolName: string): string | null {
  const envVar = `${toolName.toUpperCase()}_BIN`;
  const customPath = process.env[envVar];
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }
  return null;
}

/**
 * @description Check if a CLI tool is installed and available in PATH.
 * Also checks for custom binary path via TOOL_BIN env var.
 */
export function checkIsInstalled(toolName: string): boolean {
  // Check custom binary path first
  if (getCustomBinaryPath(toolName)) {
    return true;
  }
  
  try {
    execSync(`which ${toolName}`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * @description Get the command/path to run a tool.
 * Uses custom binary if TOOL_BIN env var is set.
 */
export function getToolCommand(toolName: string): string {
  const customPath = getCustomBinaryPath(toolName);
  if (customPath) {
    return customPath;
  }
  return toolName;
}

/**
 * @description Install a CLI tool via npm global install.
 * Installs to ~/.npm-global/bin/ which is persisted in docker volume.
 */
export async function installTool(toolName: string): Promise<void> {
  const packageName = toolPackages[toolName];
  if (!packageName) {
    throw new Error(`Unknown tool: ${toolName}. Available: ${Object.keys(toolPackages).join(', ')}`);
  }

  console.log(`[Install] Installing ${toolName} (${packageName})...`);

  return new Promise((resolve, reject) => {
    exec(
      `NPM_CONFIG_PREFIX=${npmPrefix} npm install -g ${packageName}`,
      { timeout: 120000, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[Install] Failed to install ${toolName}:`, stderr);
          reject(new Error(`Failed to install ${toolName}: ${error.message}`));
          return;
        }
        console.log(`[Install] ${toolName} installed successfully`);
        if (stdout.trim()) console.log(stdout.trim());
        resolve();
      },
    );
  });
}

/**
 * @description Ensure a tool is installed. Install if missing.
 * Returns true if tool was already installed, false if it had to be installed.
 */
export async function ensureInstalled(toolName: string): Promise<boolean> {
  if (checkIsInstalled(toolName)) {
    return true;
  }
  await installTool(toolName);
  return false;
}

// ═══════════════════════════════════════════
//  OpenCode server process management
// ═══════════════════════════════════════════

let openCodeProcess: ChildProcess | null = null;

/** Callback invoked when the OpenCode server process exits unexpectedly (not via stopOpenCodeServer) */
let onServerExitCallback: ((code: number | null, signal: string | null) => void) | null = null;
const intentionallyStoppedProcesses = new WeakSet<ChildProcess>();

/**
 * @description Register a callback for unexpected server process exits.
 * Called when the server crashes or is OOM-killed (e.g. exit code 137).
 * NOT called when stopOpenCodeServer() is used.
 */
export function onOpenCodeServerExit(callback: (code: number | null, signal: string | null) => void): void {
  onServerExitCallback = callback;
}

export async function checkIsOpenCodeServerRunning(): Promise<boolean> {
  return (await getOpenCodeServerHealth()).healthy;
}

interface OpenCodeServerHealth {
  healthy: boolean;
  /** Version the running server reports, or null if unreachable / field absent. */
  version: string | null;
}

/**
 * @description Extract a bare semver (`1.17.11`; drops a leading `v`) from a
 * version string — used for BOTH `opencode --version` output AND the
 * `/global/health` `version` field, so the two comparison sides are normalized
 * through the SAME rule. Without this, a future `v1.17.11` from one source vs
 * `1.17.11` from the other would read as a false mismatch and churn the server
 * once per boot. Returns null if no semver is present.
 */
export function extractOpenCodeVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/\d+\.\d+\.\d+\S*/);
  return match ? match[0] : null;
}

/**
 * @description Probe /global/health for liveness AND the version the running
 * server is actually executing. Detects a server still running an OLD binary
 * after opencode was updated on disk: replacing the binary file does not change
 * a live process (it keeps the old code in memory), and a newer opencode run
 * can migrate the shared opencode.db underneath the old server — which then
 * dies on every prompt (e.g. `no such column: replacement_seq`).
 */
async function getOpenCodeServerHealth(): Promise<OpenCodeServerHealth> {
  const url = process.env.OPENCODE_URL || 'http://localhost:4096';
  try {
    const response = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { healthy: false, version: null };
    const body = (await response.json().catch(() => null)) as { version?: string } | null;
    return { healthy: true, version: extractOpenCodeVersion(body?.version) };
  } catch {
    return { healthy: false, version: null };
  }
}

/** Cache so a boot-time reattach burst doesn't spawn `opencode --version` per call. */
let installedOpenCodeVersionCache: { value: string | null; at: number } | null = null;
const installedVersionCacheTtlMs = 10_000;

/**
 * @description Version of the opencode binary currently on disk
 * (`opencode --version`). Short-TTL cached to coalesce bursts. Returns null if
 * it can't be determined — an unknown version never forces a restart.
 */
function getInstalledOpenCodeVersion(): string | null {
  const now = Date.now();
  if (installedOpenCodeVersionCache && now - installedOpenCodeVersionCache.at < installedVersionCacheTtlMs) {
    return installedOpenCodeVersionCache.value;
  }
  let value: string | null = null;
  try {
    const out = execFileSync(getToolCommand('opencode'), ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, PATH: `${npmPrefix}/bin:${process.env.PATH}` },
    });
    value = extractOpenCodeVersion(out);
  } catch {
    value = null;
  }
  installedOpenCodeVersionCache = { value, at: now };
  return value;
}

/**
 * @description Stale IFF BOTH versions are known AND differ. An unknown running
 * or installed version is treated as "not stale" (adopt the server) so a
 * transient probe failure never churns a working server.
 */
export function checkIsOpenCodeServerStale(runningVersion: string | null, installedVersion: string | null): boolean {
  return !!runningVersion && !!installedVersion && runningVersion !== installedVersion;
}

/** Find the PID LISTENING on a TCP port (lsof, with an ss fallback). */
function getPidListeningOnPort(port: string): number | null {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 3000 }).trim();
    const pid = parseInt(out.split('\n')[0], 10);
    if (Number.isFinite(pid)) return pid;
  } catch {
    // lsof missing / no match — fall through to ss
  }
  try {
    const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', timeout: 3000 });
    const match = out.match(/pid=(\d+)/);
    if (match) return parseInt(match[1], 10);
  } catch {
    // give up — caller proceeds to spawn regardless
  }
  return null;
}

/** Stale-server kill: poll health every {@link staleServerKillPollMs}; escalate to
 * SIGKILL halfway, give up (and spawn anyway) after the full span. 16×500ms = 8s. */
const staleServerKillPollMs = 500;
const staleServerKillPollIterations = 16;
const staleServerSigkillAfterIterations = 8;

/**
 * @description Stop an OpenCode server that may have been ADOPTED at boot (so the
 * bot holds no child handle for it). Prefers the clean owned-process stop; else
 * signals the PID listening on the port. Waits for the port to stop answering
 * health, escalating SIGTERM → SIGKILL.
 */
async function stopAdoptedOpenCodeServer(port: string): Promise<void> {
  if (openCodeProcess && !openCodeProcess.killed) {
    stopOpenCodeServer();
  } else {
    const pid = getPidListeningOnPort(port);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
    }
  }
  for (let i = 0; i < staleServerKillPollIterations; i++) {
    await sleep(staleServerKillPollMs);
    if (!(await checkIsOpenCodeServerRunning())) return;
    if (i === staleServerSigkillAfterIterations) {
      const pid = getPidListeningOnPort(port);
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }
  console.warn(`[OpenCode] stale server on port ${port} did not exit after kill — spawning anyway`);
}

/**
 * @description Start opencode serve as a background process.
 * Waits until server responds to health check (up to 15s).
 *
 * If a server is already up but running an OUTDATED binary (version reported by
 * /global/health differs from the on-disk `opencode --version`), it is restarted
 * onto the current binary instead of being adopted — otherwise a stale server
 * lingers across bot restarts (boot would adopt it on a bare liveness check) and
 * keeps failing prompts after an opencode update.
 */
export async function ensureOpenCodeServer(): Promise<void> {
  const port = new URL(process.env.OPENCODE_URL || 'http://localhost:4096').port || '4096';

  const health = await getOpenCodeServerHealth();
  if (health.healthy) {
    const installedVersion = getInstalledOpenCodeVersion();
    if (checkIsOpenCodeServerStale(health.version, installedVersion)) {
      console.log(
        `[OpenCode] Adopted server is stale (running v${health.version}, on-disk v${installedVersion}) — restarting onto current binary`,
      );
      await stopAdoptedOpenCodeServer(port);
      // fall through to spawn a fresh server on the current binary
    } else {
      return; // healthy and current (or version unknown) → adopt as-is
    }
  } else if (openCodeProcess && !openCodeProcess.killed) {
    // Process exists but is not responding; stop only the process group we own.
    stopOpenCodeServer();
    await sleep(500);
  }

  const opencodeCmd = getToolCommand('opencode');
  console.log(`[OpenCode] Starting server on port ${port}... (${opencodeCmd})`);

  const child = spawn(opencodeCmd, ['serve', '--hostname', '127.0.0.1', '--port', port], {
    env: { ...process.env, PATH: `${npmPrefix}/bin:${process.env.PATH}` },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  openCodeProcess = child;

  child.stdout?.on('data', (data: Buffer) => {
    console.log(`[OpenCode Server] ${data.toString().trim()}`);
  });
  child.stderr?.on('data', (data: Buffer) => {
    console.error(`[OpenCode Server] ${data.toString().trim()}`);
  });
  child.on('exit', (code, signal) => {
    console.log(`[OpenCode Server] Process exited with code ${code}, signal ${signal}`);
    if (openCodeProcess === child) {
      openCodeProcess = null;
    }
    if (!intentionallyStoppedProcesses.has(child) && onServerExitCallback) {
      onServerExitCallback(code, signal);
    }
  });

  // Wait for server to become ready
  const healthUrl = `${process.env.OPENCODE_URL || 'http://localhost:4096'}/global/health`;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        console.log(`[OpenCode] Server ready`);
        return;
      }
    } catch {
      // not ready yet
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error('OpenCode server failed to start');
    }
  }

  throw new Error('OpenCode server did not become ready within 15 seconds');
}

export function stopOpenCodeServer(): void {
  const child = openCodeProcess;
  if (child && !child.killed) {
    console.log(`[OpenCode] Stopping server...`);
    intentionallyStoppedProcesses.add(child);
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, 'SIGTERM');
      } else {
        child.kill('SIGTERM');
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        console.warn(`[OpenCode] Failed to stop server:`, e instanceof Error ? e.message : e);
      }
    }
    openCodeProcess = null;
  }
}
