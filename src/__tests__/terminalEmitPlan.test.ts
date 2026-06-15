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
  buildTerminalEmitText,
  buildTerminalNewSessionArgs,
  terminalPaneCols,
  terminalPaneRows,
} from '../utils/terminalEmitPlan';
import { appendPendingOutput } from '../utils/outputFlushPlan';

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

test('buildTerminalEmitText: a continuation delta is prefixed with a single newline', () => {
  assert.equal(buildTerminalEmitText('stream line 2', true), '\nstream line 2');
});

test('buildTerminalEmitText: a fresh delta is emitted unchanged (no leading newline)', () => {
  assert.equal(buildTerminalEmitText('stream line 1', false), 'stream line 1');
});

test('buildTerminalEmitText: a fresh multi-line chunk keeps its interior newlines, no leading one', () => {
  const chunk = 'line a\nline b\nline c';
  const emitted = buildTerminalEmitText(chunk, false);
  assert.equal(emitted, chunk);
  assert.ok(!emitted.startsWith('\n'));
});

test('terminal continuation deltas join with EXACTLY one newline through the bare-concat path', () => {
  // End-to-end of the actual downstream join used by BOTH transports
  // (group `queueOutput` and DM `feedDraft` both funnel into
  // `appendPendingOutput`): a continuation emit concats bare onto the pending
  // buffer, so the leading `\n` carried in the emit text IS the separator.
  const first = buildTerminalEmitText('stream line 1', false); // fresh
  const second = buildTerminalEmitText('stream line 2', true); // continuation
  const third = buildTerminalEmitText('stream line 3', true); // continuation

  let pending = appendPendingOutput(null, first, false);
  pending = appendPendingOutput(pending, second, true);
  pending = appendPendingOutput(pending, third, true);

  assert.equal(pending, 'stream line 1\nstream line 2\nstream line 3');
  // No doubled newlines anywhere — exactly one between consecutive lines.
  assert.ok(!pending.includes('\n\n'));
});

test('a fresh terminal delta never starts the message with a newline (no leading blank line)', () => {
  // A fresh delta opens a new message; the buffer is empty, so
  // `appendPendingOutput(null, …)` returns it verbatim — must not be blank-led.
  const fresh = buildTerminalEmitText('first command output', false);
  const pending = appendPendingOutput(null, fresh, false);
  assert.equal(pending, 'first command output');
  assert.ok(!pending.startsWith('\n'));
});

test('a single-poll multi-line terminal chunk keeps interior newlines, no doubling', () => {
  // The whole output of a fast command lands in ONE poll → emitted FRESH with
  // its interior newlines intact; the join must not add or duplicate any.
  const chunk = '/home/me/projects/app\ntotal 8\ndrwxr-xr-x  2 me  staff   64';
  const emitted = buildTerminalEmitText(chunk, false);
  const pending = appendPendingOutput(null, emitted, false);
  assert.equal(pending, chunk);
  assert.ok(!pending.includes('\n\n'));
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
