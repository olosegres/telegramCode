import { execFileSync } from 'child_process';
import * as path from 'path';

/**
 * @description Locate the Claude CLI binary.
 *
 * Resolution order:
 *   1. `process.env.CLAUDE_BIN` (returned even if the file does not exist —
 *      preserves long-standing behaviour where setting `CLAUDE_BIN` was
 *      authoritative; downstream code surfaces the missing-file error itself).
 *   2. `which claude` (1.5 s timeout).
 *   3. `$HOME/.npm-global/bin/claude` fallback (also returned without
 *      existence check, by historical contract).
 *
 * Always returns a string — never `null`. This matches the prior in-adapter
 * helper at `claudeCliAdapter.ts:57-69`, which the `claude-cli` runtime path
 * depends on for module-load-time `const claudePath = resolveClaudeBinary()`.
 */
export function resolveClaudeBinary(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const which = execFileSync('which', ['claude'], {
      encoding: 'utf8',
      timeout: 1500,
      // Silence the "which: no claude in ..." noise on stderr when PATH is
      // empty or claude isn't installed. We only care about stdout; the
      // catch block handles the non-zero exit.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (which) return which;
  } catch {
    // PATH lookup failed; fall through.
  }
  return path.join(process.env.HOME || '/tmp', '.npm-global', 'bin', 'claude');
}
