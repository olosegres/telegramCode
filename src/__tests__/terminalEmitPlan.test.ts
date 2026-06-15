/**
 * @description Tests for the terminal adapter's pure streaming helpers: the
 * "one rolling message per command" emit plan and the `tmux new-session` argv
 * builder. These pin the contract the adapter's poll loop and start path depend
 * on without booting tmux.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getTerminalEmitPlan,
  buildTerminalNewSessionArgs,
  terminalPaneCols,
  terminalPaneRows,
} from '../utils/terminalEmitPlan';

test('getTerminalEmitPlan: a fresh output is a new message, not a continuation', () => {
  assert.deepEqual(getTerminalEmitPlan(true), { isContinuation: false });
});

test('getTerminalEmitPlan: a non-fresh output continues the rolling message', () => {
  assert.deepEqual(getTerminalEmitPlan(false), { isContinuation: true });
});

test('getTerminalEmitPlan: fresh→continuation across a command, re-armed by the next command', () => {
  // Model the adapter's `nextOutputFresh` flag exactly: a submitted command
  // arms fresh; the first chunk clears it; later chunks of the SAME command
  // continue; the NEXT command (sendInput) re-arms fresh.
  let nextOutputFresh = true; // sendInput armed it for command #1

  // command #1, first output chunk → new message
  let plan = getTerminalEmitPlan(nextOutputFresh);
  nextOutputFresh = false;
  assert.equal(plan.isContinuation, false);

  // command #1, second output chunk → continuation
  plan = getTerminalEmitPlan(nextOutputFresh);
  nextOutputFresh = false;
  assert.equal(plan.isContinuation, true);

  // sendInput for command #2 re-arms fresh
  nextOutputFresh = true;

  // command #2, first output chunk → new message again
  plan = getTerminalEmitPlan(nextOutputFresh);
  nextOutputFresh = false;
  assert.equal(plan.isContinuation, false);
});

test('buildTerminalNewSessionArgs: includes the shell command, -c workDir and size flags', () => {
  const args = buildTerminalNewSessionArgs({
    sessionName: 'term--100-7',
    workDir: '/home/me/projects/app',
    shellCommand: `'/bin/zsh'`,
    cols: terminalPaneCols,
    rows: terminalPaneRows,
  });
  assert.deepEqual(args, [
    'new-session',
    '-d',
    '-s', 'term--100-7',
    '-x', terminalPaneCols.toString(),
    '-y', terminalPaneRows.toString(),
    '-c', '/home/me/projects/app',
    `'/bin/zsh'`,
  ]);
  // The shell command is the LAST argv element (tmux execs it via $SHELL -c).
  assert.equal(args[args.length - 1], `'/bin/zsh'`);
  // No --session-id / permission / MCP flags leak into a terminal's argv.
  assert.ok(!args.includes('--session-id'));
  assert.ok(!args.some(a => a.includes('--dangerously-skip-permissions')));
  assert.ok(!args.some(a => a.includes('--mcp-config')));
});
