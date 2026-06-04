#!/usr/bin/env node

// Node 17+ defaults DNS resolution to `verbatim` order, which returns IPv6
// addresses first when both AAAA and A records exist. On hosts where IPv6
// advertises but isn't routed (common with consumer ISPs, many cloud VPCs,
// ARM Linux desktops), every outbound request to api.telegram.org /
// api.anthropic.com / mcp.* lands in a 60-second `ETIMEDOUT` before the IPv4
// fallback kicks in. `ipv4first` restores pre-Node-17 behaviour. See
// rationale comment in the previous `src/index.ts`.
import * as dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import { runBot } from './cli/bot';
import { runClaudeCli } from './cli/cliClaude';
import { runHot } from './cli/hot';

/**
 * @description Print top-level usage to stderr.
 *
 * Keeps the message short and copy-pastable. Detailed docs live in README;
 * we surface just enough here for someone running `telegramCode --help`
 * cold to know what to try next.
 */
function printUsage(): void {
  process.stderr.write(
    `Usage:\n` +
      `  telegramCode                  Start the bot (WORK_ROOT defaults to $PWD)\n` +
      `  telegramCode bot              Same as above\n` +
      `  telegramCode hot              Hot-reload dev mode: tsc -w + nodemon on dist/\n` +
      `                                  (rebuilds + restarts the bot on src/ edits;\n` +
      `                                   in-flight agent sessions are reattached)\n` +
      `  telegramCode cli claude [..]  Run 'claude --dangerously-skip-permissions' in $PWD\n` +
      `  telegramCode --help, -h       Show this help\n` +
      `\n` +
      `Environment:\n` +
      `  Loaded from ~/.config/telegram-code/.env (base) then $PWD/.env (override).\n` +
      `  Required for 'bot': TELEGRAM_BOT_TOKEN.\n` +
      `  Access = creator + admins of the served forum group (read live; no user list).\n` +
      `  ALLOWED_GROUP_ID is optional — leave it empty to auto-pair with your\n` +
      `  forum supergroup on first contact (or use /pair in the group).\n` +
      `  WORK_ROOT defaults to $PWD if unset.\n`,
  );
}

/**
 * @description Top-level dispatcher.
 *
 * Branches on `argv[2]`:
 *   - missing | `bot`  → start the Telegram bot
 *   - `cli <tool> ...` → forward to the matching CLI runner (currently only
 *     `claude`; `opencode` planned for iter 2 per
 *     `agent/tasks/actual/2026-05-16-telegramcode-cli-wrapper.md`)
 *   - `-h | --help | help` → usage
 *   - anything else → usage + exit 2
 *
 * Exit 2 (not 1) for unknown commands matches the convention used by most
 * Unix tools to distinguish "bad invocation" from "ran but failed".
 */
async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);

  if (sub === undefined || sub === 'bot') {
    await runBot();
    return;
  }

  if (sub === 'hot') {
    await runHot();
    return;
  }

  if (sub === 'cli') {
    const [tool, ...toolArgs] = rest;
    if (tool === 'claude') {
      await runClaudeCli(toolArgs);
      return;
    }
    process.stderr.write(
      `Unknown cli tool: ${tool ?? '(missing — try "claude")'}\n\n`,
    );
    printUsage();
    process.exit(2);
    return;
  }

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    printUsage();
    return;
  }

  process.stderr.write(`Unknown command: ${sub}\n\n`);
  printUsage();
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
