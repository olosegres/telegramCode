/**
 * @description Pure parser for the `claude` CLI's
 * `--output-format stream-json` protocol (the `claude-json-stream` adapter's
 * event core). Kept dependency-free and side-effect-free so it is unit-testable
 * against REAL captured stream-json samples (see `claudeStreamJson.test.ts`):
 * the adapter feeds every stdout chunk through {@link ClaudeStreamLineReader}
 * (partial-line buffering across chunks) and each complete line through
 * {@link classifyClaudeStreamMessage}, which maps ONE stream-json message to a
 * list of backend-neutral {@link ClaudeStreamAction}s the adapter then turns
 * into `AgentAdapter` events.
 *
 * The wire format was reverse-engineered from a live `claude -p
 * --input-format stream-json --output-format stream-json` run (v2.1.201) and
 * cross-read against `@anthropic-ai/claude-agent-sdk` `sdk.d.ts` /`sdk.mjs`.
 * Every event type below is backed by a captured sample.
 */

/** Narrow an untyped `JSON.parse` result to a plain object (parse-boundary
 *  pattern for untrusted process output; mirrors `checkIsRecord` elsewhere). */
export function checkIsStreamRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @description Newline-delimited-JSON reader with partial-line buffering. The
 * CLI writes one JSON object per line, but a stdout chunk can split a line at
 * any byte (a mid-line truncation), so a naive `chunk.split('\n')` would try to
 * `JSON.parse` half a line. {@link push} returns only the COMPLETE lines seen so
 * far and retains the trailing partial in {@link buffer} until its newline
 * arrives in a later chunk.
 */
export class ClaudeStreamLineReader {
  private buffer = '';

  /** Feed a stdout chunk; return every complete (newline-terminated) line it
   *  completed, retaining any trailing partial for the next call. Blank lines
   *  are dropped. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim()) lines.push(line);
    }
    return lines;
  }

  /** Any buffered, not-yet-terminated content (diagnostic only). */
  get pending(): string {
    return this.buffer;
  }
}

/** Parse one NDJSON line to a record, or `null` for blank / malformed
 *  (a torn line that slipped past the reader) — never throws. */
export function parseStreamJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return checkIsStreamRecord(parsed) ? parsed : null;
}

/**
 * @description Backend-neutral action produced from ONE stream-json message.
 * The adapter turns these into `AgentAdapter` events (accumulation / debounce /
 * control-channel handling stay in the adapter; classification stays pure here).
 */
export type ClaudeStreamAction =
  /** `system/init` — the session is up (first one carries the authoritative id). */
  | { kind: 'init'; sessionId: string | null; model: string | null; apiKeySource: string | null }
  /** A streamed answer-text delta (`content_block_delta` `text_delta`). */
  | { kind: 'textDelta'; text: string; isSubagent: boolean }
  /** A streamed reasoning delta (`content_block_delta` `thinking_delta`). */
  | { kind: 'thinkingDelta'; text: string; isSubagent: boolean }
  /** A settled assistant `tool_use` block → drives the transient tool status. */
  | { kind: 'toolUse'; tool: string; toolUseId: string; isSubagent: boolean }
  /** A `tool_result` fed back in a `user` message → the `toolResult` event. */
  | { kind: 'toolResult'; toolUseId: string; output: string }
  /** The turn ended (`result`); `resultText` is the final answer text. */
  | { kind: 'turnEnd'; isError: boolean; errorText: string | null; resultText: string | null }
  /** A control_request off stdout (permission / AskUserQuestion / dialog). */
  | {
      kind: 'controlRequest';
      requestId: string;
      subtype: string;
      toolName?: string;
      input?: Record<string, unknown>;
      toolUseId?: string;
      dialogKind?: string;
    }
  /** `system/api_retry` — a provider retry the CLI is performing. */
  | { kind: 'apiRetry'; text: string }
  /** `rate_limit_event` — subscription usage window signal (billing proof). */
  | { kind: 'rateLimit'; rateLimitType: string | null; utilization: number | null }
  /** `--replay-user-messages` echo — the input-ack signal. */
  | { kind: 'userEcho' };

/** Read a string field, or null. */
function readString(rec: Record<string, unknown>, key: string): string | null {
  const value = rec[key];
  return typeof value === 'string' ? value : null;
}

/** Concatenate the text of a tool_result `content` (string, or array of
 *  `{type:'text',text}` / `{type:'tool_result'…}` blocks). */
function extractToolResultOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (checkIsStreamRecord(block) && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * @description Map ONE parsed stream-json message to zero or more
 * {@link ClaudeStreamAction}s. Pure: no accumulation, no timers, no IO. An
 * unrecognized / uninteresting message (status, thinking_tokens, message_start,
 * content_block_start/stop, …) yields `[]`.
 */
export function classifyClaudeStreamMessage(msg: Record<string, unknown>): ClaudeStreamAction[] {
  const type = msg.type;
  const isSubagent = msg.parent_tool_use_id != null;

  if (type === 'system' && msg.subtype === 'init') {
    return [{
      kind: 'init',
      sessionId: readString(msg, 'session_id'),
      model: readString(msg, 'model'),
      apiKeySource: readString(msg, 'apiKeySource'),
    }];
  }

  if (type === 'system' && msg.subtype === 'api_retry') {
    // The retry carries an `error` description (documented category enum + text).
    const text = readString(msg, 'error') ?? readString(msg, 'message') ?? JSON.stringify(msg);
    return [{ kind: 'apiRetry', text }];
  }

  if (type === 'rate_limit_event') {
    const info = checkIsStreamRecord(msg.rate_limit_info) ? msg.rate_limit_info : {};
    return [{
      kind: 'rateLimit',
      rateLimitType: readString(info, 'rateLimitType'),
      utilization: typeof info.utilization === 'number' ? info.utilization : null,
    }];
  }

  if (type === 'stream_event') {
    const event = checkIsStreamRecord(msg.event) ? msg.event : null;
    if (!event || event.type !== 'content_block_delta') return [];
    const delta = checkIsStreamRecord(event.delta) ? event.delta : null;
    if (!delta) return [];
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return delta.text ? [{ kind: 'textDelta', text: delta.text, isSubagent }] : [];
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return delta.thinking ? [{ kind: 'thinkingDelta', text: delta.thinking, isSubagent }] : [];
    }
    return [];
  }

  if (type === 'assistant') {
    // The settled assistant message. Text/thinking already streamed via deltas;
    // here we only surface tool_use blocks (transient tool status).
    const message = checkIsStreamRecord(msg.message) ? msg.message : null;
    const content = message && Array.isArray(message.content) ? message.content : [];
    const actions: ClaudeStreamAction[] = [];
    for (const block of content) {
      if (!checkIsStreamRecord(block)) continue;
      if (block.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
        actions.push({ kind: 'toolUse', tool: block.name, toolUseId: block.id, isSubagent });
      }
    }
    return actions;
  }

  if (type === 'user') {
    // Either a `--replay-user-messages` echo OR a tool_result fed back to the model.
    const message = checkIsStreamRecord(msg.message) ? msg.message : null;
    const content = message ? message.content : undefined;
    if (Array.isArray(content)) {
      const actions: ClaudeStreamAction[] = [];
      for (const block of content) {
        if (checkIsStreamRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          actions.push({ kind: 'toolResult', toolUseId: block.tool_use_id, output: extractToolResultOutput(block.content) });
        }
      }
      if (actions.length > 0) return actions;
    }
    return [{ kind: 'userEcho' }];
  }

  if (type === 'result') {
    return [{
      kind: 'turnEnd',
      isError: msg.is_error === true,
      errorText: readString(msg, 'api_error_status') ?? (msg.is_error === true ? (readString(msg, 'result') ?? 'API error') : null),
      resultText: readString(msg, 'result'),
    }];
  }

  if (type === 'control_request') {
    const request = checkIsStreamRecord(msg.request) ? msg.request : null;
    const requestId = readString(msg, 'request_id');
    const subtype = request ? readString(request, 'subtype') : null;
    if (!request || !requestId || !subtype) return [];
    const action: Extract<ClaudeStreamAction, { kind: 'controlRequest' }> = { kind: 'controlRequest', requestId, subtype };
    const toolName = readString(request, 'tool_name');
    if (toolName) action.toolName = toolName;
    if (checkIsStreamRecord(request.input)) action.input = request.input;
    const toolUseId = readString(request, 'tool_use_id');
    if (toolUseId) action.toolUseId = toolUseId;
    const dialogKind = readString(request, 'dialog_kind');
    if (dialogKind) action.dialogKind = dialogKind;
    return [action];
  }

  return [];
}

/** The `response` payload of a `can_use_tool` control_response (allow / deny). */
export type CanUseToolResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; toolUseID?: string }
  | { behavior: 'deny'; message: string; toolUseID?: string };

/**
 * @description Build the `allow` body of a `can_use_tool` control_response.
 *
 * The CLI's control-response schema REQUIRES `updatedInput` to be a record on an
 * allow — omit it and the CLI rejects the whole response ("Tool permission
 * request failed: ZodError"), which silently blocks the tool it was meant to
 * permit. This builder makes that field impossible to forget: `input` is echoed
 * unchanged (`{}` when the request carried none). Used for the generic auto-allow
 * of ordinary tools and for the empty-question fast-path.
 */
export function buildCanUseToolAllow(input: Record<string, unknown> | undefined, toolUseId: string | undefined): CanUseToolResponse {
  const response: CanUseToolResponse = { behavior: 'allow', updatedInput: input ?? {} };
  if (toolUseId) response.toolUseID = toolUseId;
  return response;
}

/** Build the `deny` body of a `can_use_tool` control_response (schema requires
 *  `message`). Used when the user declines / abandons an AskUserQuestion. */
export function buildCanUseToolDeny(message: string, toolUseId: string | undefined): CanUseToolResponse {
  const response: CanUseToolResponse = { behavior: 'deny', message };
  if (toolUseId) response.toolUseID = toolUseId;
  return response;
}
