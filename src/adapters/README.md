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
  --include-partial-messages --verbose \
  --permission-prompt-tool stdio --permission-mode acceptEdits \
  --session-id <uuid> [--resume <id>] --model … --effort … --mcp-config <file> -C <workDir>
```

- `--include-partial-messages --verbose` — WITHOUT BOTH, stream-json emits no
  token deltas (only settled `assistant` messages).
- `--permission-prompt-tool stdio` — **the lynchpin for interactive questions**:
  without it `AskUserQuestion` is not even in the tool list, and there is no
  channel to answer a permission over. Easy to miss; nothing else surfaces the
  need for it.
- `--permission-mode acceptEdits` — ordinary tool use is auto-approved
  (tmux-parity: the operator trusts their own agent), so only `AskUserQuestion`
  actually reaches the user.
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

## Switching it on (code-only)

No command, no button. `getThreadAdapter` honours env
`CLAUDE_JSON_STREAM_THREADS` — a comma-separated list of `ThreadKey`s
(`"<chatId>:<threadId>"`) forced onto this backend, overriding the
persisted/default pick. A reattach guard stops such a thread from re-adopting a
stale tmux-`claude` session at boot. `hiddenAdapterNames` (in `createAdapter.ts`)
keeps it out of `/start` and the agent-selection keyboard.

## Shared session store

Both Claude backends drive the same `claude` binary against
`~/.claude/projects/<slug>/…`, so `/sessions` reads the same transcripts (the
tmux adapter's readers are reused) and a session started in one backend is
resumable in the other.
