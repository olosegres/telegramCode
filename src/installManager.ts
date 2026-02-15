import { execSync, exec } from 'child_process';
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

export async function checkIsOpenCodeServerRunning(): Promise<boolean> {
  const url = process.env.OPENCODE_URL || 'http://localhost:4096';
  try {
    const response = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * @description Start opencode serve as a background process.
 * Waits until server responds to health check (up to 15s).
 */
export async function ensureOpenCodeServer(): Promise<void> {
  if (await checkIsOpenCodeServerRunning()) {
    return;
  }

  if (openCodeProcess && !openCodeProcess.killed) {
    // Process exists but not responding, kill and restart
    openCodeProcess.kill();
    openCodeProcess = null;
  }

  const port = new URL(process.env.OPENCODE_URL || 'http://localhost:4096').port || '4096';

  const opencodeCmd = getToolCommand('opencode');
  console.log(`[OpenCode] Starting server on port ${port}... (${opencodeCmd})`);

  openCodeProcess = exec(`${opencodeCmd} serve --hostname 127.0.0.1 --port ${port}`, {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${npmPrefix}/bin:${process.env.PATH}` },
  });

  openCodeProcess.stdout?.on('data', (data: string) => {
    console.log(`[OpenCode Server] ${data.trim()}`);
  });
  openCodeProcess.stderr?.on('data', (data: string) => {
    console.error(`[OpenCode Server] ${data.trim()}`);
  });
  openCodeProcess.on('exit', (code) => {
    console.log(`[OpenCode Server] Process exited with code ${code}`);
    openCodeProcess = null;
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
    if (openCodeProcess?.exitCode !== null && openCodeProcess?.exitCode !== undefined) {
      throw new Error('OpenCode server failed to start');
    }
  }

  throw new Error('OpenCode server did not become ready within 15 seconds');
}

export function stopOpenCodeServer(): void {
  if (openCodeProcess && !openCodeProcess.killed) {
    console.log(`[OpenCode] Stopping server...`);
    openCodeProcess.kill();
    openCodeProcess = null;
  }
}
