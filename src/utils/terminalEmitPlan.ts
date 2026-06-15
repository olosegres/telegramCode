/**
 * @description Pure decision helpers for the terminal adapter's streaming model.
 * Kept out of `adapters/terminalAdapter.ts` so the "one rolling message per
 * command" rule and the `tmux new-session` argv are unit-testable without
 * booting tmux.
 */

/**
 * @description Default terminal pane width in columns. Wide enough that normal
 * command output (builds, logs, `ls -la`, `git status`) doesn't wrap awkwardly,
 * matching the Claude adapter's pane sizing intent.
 */
export const terminalPaneCols = 200;

/** @description Default terminal pane height in rows. */
export const terminalPaneRows = 50;

/**
 * @description Tmux session-name prefix that namespaces terminal shells on the
 * tmux server, distinct from Claude's `claude-` prefix. Parsed back to a
 * `ThreadKey` via `utils/tmuxSessionName` with this prefix.
 */
export const terminalTmuxPrefix = 'term';

/** @description Shell to spawn for a terminal session — the operator's `$SHELL`, else bash. */
export const defaultShell = process.env.SHELL || '/bin/bash';

/**
 * @description Decide how a non-empty cleaned diff chunk should be emitted for a
 * terminal session, given whether the next output is "fresh" (a new command's
 * first output) or a continuation of the in-flight one.
 *
 * Mirrors OpenCode's streaming-reply contract: the FIRST chunk after a command
 * is a new message; every later chunk of the SAME command's output appends
 * (`isContinuation`). The `nextOutputFresh` flag is re-armed by `sendInput`
 * (every submitted command), so each command gets exactly one rolling message
 * that grows as its output streams.
 */
export function getTerminalEmitPlan(nextOutputFresh: boolean): { isContinuation: boolean } {
  return { isContinuation: !nextOutputFresh };
}

/**
 * @description Build the text actually emitted for one terminal poll-delta so the
 * downstream bare-concat continuation join (`appendPendingOutput`: `pending +
 * output`) keeps the inter-poll line break.
 *
 * Unlike OpenCode's token tails (cut mid-word, so they MUST concat bare), each
 * terminal poll-delta is a complete line/block of shell output, so consecutive
 * deltas of one command have to be SEPARATED by a `\n`. We carry that `\n` inside
 * the emitted text (rather than a `meta` flag) so it works identically for the
 * group `queueOutput` and the DM `feedDraft` paths without touching either.
 *
 * - CONTINUATION (`isContinuation` true) → prefix one `\n`, so the bare concat
 *   yields `pending\n delta`.
 * - FRESH (`isContinuation` false) → return the chunk unchanged: a fresh delta
 *   opens a new message and a message must never start blank.
 *
 * No doubling: the chunk is already trailing-`\n`-trimmed upstream
 * (`getNewPaneContent` trims, the adapter `.trim()`s again), so a single-poll
 * multi-line chunk keeps its OWN interior newlines and gains no extra blank.
 */
export function buildTerminalEmitText(chunk: string, isContinuation: boolean): string {
  return isContinuation ? `\n${chunk}` : chunk;
}

/**
 * @description Build the `tmux new-session` argv for a terminal shell. Pure so
 * the shell-command + `-c <workDir>` + size flags are unit-testable. tmux execs
 * the trailing `shellCommand` via `$SHELL -c`; the caller passes an already
 * shell-safe command string (the bare shell path needs no quoting, but routing
 * it through the same builder keeps one assembly point).
 *
 * No `--session-id`, no permission flags, no MCP — a terminal is just a shell.
 */
export function buildTerminalNewSessionArgs(input: {
  sessionName: string;
  workDir: string;
  shellCommand: string;
  cols: number;
  rows: number;
}): string[] {
  return [
    'new-session',
    '-d',
    '-s', input.sessionName,
    '-x', input.cols.toString(),
    '-y', input.rows.toString(),
    '-c', input.workDir,
    input.shellCommand,
  ];
}
