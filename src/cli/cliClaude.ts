import { spawn } from 'child_process';
import { loadEnvFiles } from './envLoader';
import { resolveClaudeBinaryStrict } from '../utils/resolveBinary';

/**
 * @description Wrapper-entry for `telegramCode cli claude [...args]`.
 *
 * Behaviour: identical to invoking `claude --dangerously-skip-permissions
 * [args]` directly in the user's current shell. The wrapper exists so the
 * user gets:
 *
 *   - the same env-loading the bot enjoys (so `CLAUDE_BIN`,
 *     `ANTHROPIC_API_KEY` etc. from `~/.config/telegram-code/.env` apply);
 *   - a friendly error if the `claude` binary isn't installed, instead of an
 *     `ENOENT` thrown by `spawn`.
 *
 * Sessions naturally overlap with the bot's because both processes run on
 * the host and read/write the same `~/.claude/projects/<encoded-cwd>/` JSONL
 * transcripts (the bot itself runs claude via tmux on the host — verified
 * in `src/adapters/claudeCliAdapter.ts:548-556`).
 *
 * `stdio: 'inherit'` hands the user's TTY directly to claude. Exit code and
 * fatal signals are forwarded so shell scripting (`telegramCode cli claude
 * && yarn test`) behaves correctly.
 */
export async function runClaudeCli(args: string[]): Promise<void> {
  loadEnvFiles();

  const bin = resolveClaudeBinaryStrict();
  if (!bin) {
    process.stderr.write(
      `claude binary not found. Install it with:\n` +
        `  npm install -g @anthropic-ai/claude-code\n` +
        `Or set CLAUDE_BIN in your env to an absolute path.\n`,
    );
    process.exit(1);
    return;
  }

  const child = spawn(bin, ['--dangerously-skip-permissions', ...args], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  // Forward parent signals to claude so Ctrl-C in the wrapper terminates the
  // child cleanly. Without this, SIGINT delivered to the wrapper would be
  // ignored once stdio is inherited (parent's signal handler defaults differ
  // from claude's).
  const forwardedSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forward = (sig: NodeJS.Signals) => (): void => {
    if (!child.killed) child.kill(sig);
  };
  for (const sig of forwardedSignals) process.on(sig, forward(sig));

  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raise the same signal on ourselves so the parent shell sees the
      // canonical exit-by-signal status (e.g. 130 for SIGINT), not 0.
      //
      // CRITICAL: we must remove our own handler for that signal first,
      // otherwise `process.kill(self, signal)` just re-fires the
      // forward-to-child handler installed above (with `child.killed` true,
      // it's a no-op), the event loop drains, and the wrapper exits 0 —
      // exactly the bug this branch is trying to prevent. Removing every
      // forwarded-signal handler before re-raising lets Node fall through
      // to the default action (terminate with 128+signal).
      for (const s of forwardedSignals) process.removeAllListeners(s);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    process.stderr.write(`Failed to spawn claude: ${err.message}\n`);
    process.exit(1);
  });
}
