# `src/adapters/` — agent backends

Every backend implements the `AgentAdapter` seam (`../types.ts`); the bot never
talks to an agent directly. The root `CLAUDE.md` "Adapters" table is the per-file
map. This README documents the one thing that is NOT discoverable from the code
or public docs: the reverse-engineered stdio control protocol behind
`claudeJsonStreamAdapter`.

## `claude-json-stream` — driving the CLI over stream-json

An experimental alternative to the tmux `claude` backend: instead of
screen-scraping a TUI, it spawns the `claude` binary in headless streaming mode
and exchanges structured JSON over the child's stdio. Min version: `claude`
2.1.201.

### Invocation — the load-bearing flags

```
claude -p --input-format stream-json --output-format stream-json \
  --include-partial-messages --verbose --replay-user-messages \
  --dangerously-skip-permissions --permission-mode bypassPermissions \
  --permission-prompt-tool stdio \
  --session-id <uuid> [--resume <id>] --model … --effort … --mcp-config <file> -C <workDir>
```

- `--include-partial-messages --verbose` — WITHOUT BOTH, stream-json emits no
  token deltas (only settled `assistant` messages).
- `--permission-prompt-tool stdio` — **the lynchpin for interactive questions**:
  without it `AskUserQuestion` is not even in the tool list, and there is no
  channel to answer a permission over. Easy to miss; nothing else surfaces the
  need for it. It STAYS even under `bypassPermissions` — verified live on
  v2.1.201 that bypass does NOT drop `AskUserQuestion` from the tool list and
  still routes it through the control channel (and `apiKeySource` stays `none`).
- `--dangerously-skip-permissions --permission-mode bypassPermissions` — bypass
  ALL permission checks (tmux-backend parity: the operator trusts their own
  agent). Regular tool use (Bash/Read/…) never routes through the stdio prompt
  tool at all, so the agent never stalls waiting for an allow. WITHOUT these
  (the old `acceptEdits`) every non-edit tool DID route through the prompt tool
  — and any hiccup in the auto-allow reply silently blocked it. The residual
  circuit-breakers claude never bypasses (`rm -rf /`, `rm -rf ~`) still arrive
  as a `can_use_tool` and get a generic auto-allow.
- **Billing**: NEVER `--bare`, NEVER set `ANTHROPIC_API_KEY` — either one forces
  metered pay-per-token API billing. Non-`--bare` + the existing OAuth login runs
  on the **subscription**. Proof in the stream: `system/init` carries
  `apiKeySource:"none"` and a `rate_limit_event` with `rateLimitType:"seven_day"`
  (a subscription concept — the metered API has no such event). `total_cost_usd`
  in `result` is a NOTIONAL figure, not a charge.

### Output events (documented, stable)

Newline-delimited JSON, one object per line, parsed in
`../utils/claudeStreamJson.ts`:

- `system` — `subtype:"init"` carries `session_id`; `subtype:"api_retry"` for
  retryable provider errors (has an `error` category enum).
- `stream_event` — `event.type:"content_block_delta"` with
  `event.delta.type:"text_delta"` = live token deltas.
- `assistant` — the settled text of the turn.
- `result` — turn end (usage, cost, `session_id`).

### Multi-turn — one long-lived process

ONE process per topic. Feed each user turn as a line on stdin:

```
{"type":"user","message":{"role":"user","content":"…"}}
```

The process stays alive between turns and exits ONLY when stdin closes (a single
message + EOF makes it answer once and exit — that is not multi-turn).
`--replay-user-messages` echoes each input back as an ack.

### Process hosting — external tmux + FIFO + file tail (restart isolation)

The process is NOT a bot child (plan 2026-07-05-jsonstream-restart-isolation):
a generated `#!/bin/sh` wrapper (`utils/jsonStreamHost.buildWrapperScript`)
hosts it in a detached tmux session `cjson-<chatId>-<threadId>`, so bot
restarts — every hot reload — never touch it. Per-thread host dir
`DATA_DIR/jsonstream/<chatId>_<threadId>/`:

- `stdin.fifo` — the bot writes turns/control frames here. Claude holds the
  fifo **`0<>` (read-write on fd 0)**, so a writer (bot) dying never EOFs its
  stdin. The bot's write-open is `O_WRONLY|O_NONBLOCK` with an `ENXIO` retry
  loop — a plain blocking open on a reader-less fifo hangs forever (probe-
  proven); persistent `ENXIO` = the process is dead.
- `stdout.jsonl` — append-only event log replacing the stdout pipe. The
  adapter TAILS it (adaptive 300ms→1.5s cadence) and feeds the same line
  reader/classifier; deltas keep landing while the bot is down. The consumed
  line-boundary byte offset persists in `state.json` (`agents[key].jsonStreamTail`)
  but only once batched answer text has actually been EMITTED — an offset past
  un-emitted text would skip it on replay (live seam-loss 2026-07-05).
- `stderr.log` — passive; read only for spawn-fail / unexpected-exit
  diagnostics. `pid` / `exitcode` — written by the wrapper; the poll tick's
  exit detection (pid-alive + exitcode file) routes into the normal
  stopped/closed handling with the real code.
- `question.json` — the pending `AskUserQuestion` control_request, persisted
  when surfaced and removed when resolved: the blocked question's
  control_request line lies BEFORE the persisted tail offset, so an adopting
  bot restores it from this sidecar and can still answer over the fifo.

On boot, reattach ADOPTS a live `cjson-*` session (reopen fifo + resume the
tail from the persisted offset → the downtime gap replays through the normal
pipeline, in-flight turn delivered end-to-end, no recap posted); a released
session (`/quit`/`/new` cleared the persisted id) is killed as an orphan, and
a thread whose process died falls back to the old dead-process `--resume`
reopen (the only path that posts a recap). Explicit stop = SIGTERM + tmux
kill + host-dir removal. The wrapper runs `env -u ANTHROPIC_API_KEY`, keeping
subscription billing under tmux. tmux is therefore REQUIRED for BOTH Claude
backends.

## The control protocol (reverse-engineered — not public)

`canUseTool` / `AskUserQuestion` are documented only as an SDK-library concept;
the raw stdio wire format is not published. It was captured empirically and
cross-read against `anthropics/claude-agent-sdk-typescript`. The authoritative,
verified implementation is `claudeJsonStreamAdapter.ts` — this is the map, the
code is the exact bytes.

1. **Handshake first.** Before any turn, write a `control_request` with
   `request.subtype:"initialize"` (carrying `supportedDialogKinds`) to stdin; the
   CLI replies with a `control_response`. `AskUserQuestion` appears in the tool
   set ONLY after this ack — skip it and questions silently never fire.
2. **Request.** A question or a tool-approval arrives on stdout as a
   `control_request` with `request.subtype:"can_use_tool"`, a `tool_name`
   (`"AskUserQuestion"` or a real tool), the tool `input`, a `tool_use_id`, and
   `requires_user_interaction:true`. For `AskUserQuestion` the input is
   `{questions:[{question, header, options:[{label, description}], multiSelect}]}`.
3. **Response.** Write a `control_response` back to stdin, matched by
   `request_id`:
   - allow → `response.behavior:"allow"` with `updatedInput`. For
     `AskUserQuestion` the answer rides in `updatedInput.answers`, an object keyed
     by the question TEXT whose value is the chosen option `label` (or
     `"label1, label2"` for multi-select); for a plain tool, `updatedInput` is the
     (optionally modified) tool input.
   - deny/reject → `response.behavior:"deny"` with a `message`.

The adapter maps a `can_use_tool` request onto the bot's existing `question`
event (identical shape to OpenCode's), so the pin + one-at-a-time + inline-button
flow is reused verbatim; `answerQuestion` / `rejectQuestion` emit the matching
`control_response`.

## Selecting it (default + `/claude_mode`)

This is the **DEFAULT** Claude backend (`getDefaultAdapterName` /
`resolveClaudeBackendName`): ▶️ Claude / `/claude` open it unless the thread
explicitly picked tmux. `/claude_mode` switches a topic between the two backends
on the fly — the pick persists as the thread's adapter name and the switch
RESUMES the same conversation (see "Shared session store";
`switchThreadAdapter` keeps `claudeSessionId` for both backends). A reattach
guard stops a json-stream thread from re-adopting a stale tmux-`claude` session
at boot. `hiddenAdapterNames` (in `createAdapter.ts`) keeps it out of the generic
`/start` agent list — it is reached via the default + `/claude_mode`, not a start
entry. (The old `CLAUDE_JSON_STREAM_THREADS` env gate is RETIRED.)

## Shared session store

Both Claude backends drive the same `claude` binary against
`~/.claude/projects/<slug>/…`, so `/sessions` reads the same transcripts (the
tmux adapter's readers are reused) and a session started in one backend is
resumable in the other.
