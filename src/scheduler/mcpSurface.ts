import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { StateStore } from '../state';
import { keyFromString, type ThreadKey } from '../types';
import { describeSchedule, validateScheduleSpec } from './recurrence';
import { createScheduleForThread } from './store';
import type { ScheduleRecord, ScheduleSpec } from './types';

/**
 * @description The bot-owned MCP server (plan S5). It exposes three agent-facing
 * tools — `schedule_create`, `schedule_list`, `schedule_cancel` — over streamable
 * HTTP on a loopback port, so both backends' bot-started sessions can manage
 * schedules in words. The server is INERT until S8 wires `createSchedulerMcpServer`
 * into `bot.ts`; this module imports nothing from `bot.ts` (every side effect is
 * injected via {@link SchedulerMcpDeps}).
 *
 * Transport: STATELESS streamable HTTP (`sessionIdGenerator: undefined`) — a
 * research-locked choice (plan S5) that dodges the SDK's session-loss bugs and
 * suits a single local host. The SDK binds one `McpServer` to one transport per
 * connection, so every request builds a FRESH `McpServer` + transport (see
 * {@link buildRequestServer}) that registers the same three handlers, and they
 * are closed when the response finishes.
 *
 * Auth/scoping: a request carries `Authorization: Bearer <token>`. The token is
 * self-describing — `<scopeB64url>.<hmacHex>` — so the bot need not know every
 * valid scope up front (an OpenCode directory scope is any bound folder). The
 * scope rides in cleartext (base64url) next to an HMAC-SHA256 signature over the
 * decoded scope string; {@link verifySchedulerMcpToken} recomputes the HMAC and
 * compares it timing-safely. A scope is one of:
 *   - `thread:<threadKey>` — a Claude session, pinned to its exact thread.
 *   - `dir:<directory>`    — an OpenCode instance, granular to a bound folder.
 * Every tool call resolves a single target thread from the scope (see
 * {@link resolveTargetThreadKey}) and can only touch that thread's jobs.
 */

/** Default loopback port for the scheduler MCP server; overridable via `SCHEDULER_MCP_PORT`. */
export const defaultSchedulerMcpPort = 4097;

/** HTTP path the streamable transport is served on (matches the injected `--mcp-config` url, S6). */
export const schedulerMcpPath = '/mcp';

/** Server identity reported in the MCP `initialize` handshake. */
const mcpServerName = 'telegram-bot-scheduler';
const mcpServerVersion = '1.0.0';

/** Max characters of a free-text job name / prompt accepted by a tool (defensive bound). */
const maxNameLength = 200;
const maxPromptLength = 8000;

// ─── scope + token ───────────────────────────────────────────────────

/**
 * @name SchedulerScope
 * @description The authorisation scope a token grants. `thread` pins to one exact
 * thread (Claude); `dir` grants the whole bound directory (OpenCode), where a
 * single bound thread is implicit and >1 forces an explicit `threadKey` arg.
 */
export type SchedulerScope =
  | { kind: 'thread'; threadKey: string }
  | { kind: 'dir'; directory: string };

/** Read the configured scheduler MCP port once, mirroring the OPENCODE_URL env read. */
export function getSchedulerMcpPort(): number {
  const raw = process.env.SCHEDULER_MCP_PORT;
  if (!raw) return defaultSchedulerMcpPort;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultSchedulerMcpPort;
}

/** Serialise a scope to its canonical cleartext form (the string the HMAC signs). */
export function serializeSchedulerScope(scope: SchedulerScope): string {
  return scope.kind === 'thread' ? `thread:${scope.threadKey}` : `dir:${scope.directory}`;
}

/** Parse the canonical cleartext scope string back into a {@link SchedulerScope}, or `null`. */
export function parseSchedulerScope(serialized: string): SchedulerScope | null {
  const sep = serialized.indexOf(':');
  if (sep <= 0) return null;
  const kind = serialized.slice(0, sep);
  const rest = serialized.slice(sep + 1);
  if (rest.length === 0) return null;
  if (kind === 'thread') return { kind: 'thread', threadKey: rest };
  if (kind === 'dir') return { kind: 'dir', directory: rest };
  return null;
}

/** HMAC-SHA256(secret, message) as lowercase hex. */
function computeHmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * @description Mint a bearer token for a scope: `<scopeB64url>.<hmacHex>`. The
 * scope rides in cleartext (base64url of the canonical scope string) so the
 * verifier can recover it without a lookup table; the HMAC over the DECODED
 * scope string is the unforgeable part. Document/keep in sync with
 * {@link verifySchedulerMcpToken}.
 */
export function buildSchedulerMcpToken(secret: string, scope: SchedulerScope): string {
  const serialized = serializeSchedulerScope(scope);
  const scopeB64 = Buffer.from(serialized, 'utf8').toString('base64url');
  const signature = computeHmacHex(secret, serialized);
  return `${scopeB64}.${signature}`;
}

/**
 * @description Verify a bearer token and recover its scope. Splits on the single
 * `.`, base64url-decodes the scope half, recomputes the HMAC over the decoded
 * scope string, and compares it to the token's signature with a constant-time
 * {@link timingSafeEqual} (equal-length hex buffers). Returns the parsed scope on
 * success, or `null` for any malformed / tampered token. A tampered scope half
 * changes the HMAC input so the recomputed signature won't match; a tampered
 * signature half fails the compare directly.
 */
export function verifySchedulerMcpToken(secret: string, token: string): SchedulerScope | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const scopeB64 = token.slice(0, dot);
  const providedSignature = token.slice(dot + 1);

  let serialized: string;
  try {
    serialized = Buffer.from(scopeB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const scope = parseSchedulerScope(serialized);
  if (!scope) return null;

  const expectedSignature = computeHmacHex(secret, serialized);
  // timingSafeEqual throws on length mismatch, so length-gate first (hex of a
  // SHA-256 is always 64 chars, but a tampered token could be any length).
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return null;
  if (!timingSafeEqual(expectedBuffer, providedBuffer)) return null;

  return scope;
}

/** Pull the bearer token out of an `Authorization` header value, or `null`. */
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// ─── deps + thread resolution ────────────────────────────────────────

/**
 * @name SchedulerMcpDeps
 * @description Everything the MCP server needs from the outside, injected so the
 * module stays free of `bot.ts` imports. `store` is the real {@link StateStore}
 * (schedule getters + the create path live on it / its store helper); `armJob`
 * and `disarmJob` are the engine's timer controls; `getThreadsForDirectory`
 * resolves a `dir` scope to the threads bound to that folder; `getThreadAdapterName`
 * snapshots the adapter to start after a rebind; `getSecret` returns the persisted
 * HMAC secret; `port` overrides the env-derived listen port (tests pass `0`).
 */
export interface SchedulerMcpDeps {
  store: StateStore;
  armJob: (record: ScheduleRecord) => void;
  disarmJob: (jobId: string) => void;
  /** Thread keys bound to a directory (OpenCode instance), serialised strings. */
  getThreadsForDirectory: (directory: string) => string[];
  /** Last-used adapter name for a thread, for the `lastAdapterName` snapshot. */
  getThreadAdapterName: (threadKey: string) => string | undefined;
  /**
   * Send 1..10 files/images from the thread's bound folder back into the topic.
   * Path-safety, type classification, and the album/size decision live in the
   * bot's `sendFilesToThread` (it owns Telegraf); this surface only routes the
   * resolved thread + args and relays the `{ ok }` summary/error to the agent.
   */
  sendFilesToThread: (
    threadKey: string,
    opts: { paths: string[]; caption?: string; asFile?: boolean },
  ) => Promise<{ ok: true; summary: string } | { ok: false; error: string }>;
  getSecret: () => Promise<string>;
  /** Listen port; defaults to {@link getSchedulerMcpPort}. Tests pass `0` for ephemeral. */
  port?: number;
}

/**
 * @name SchedulerMcpHandle
 * @description The running server's control surface. `port` is the actually-bound
 * port (resolved after `start`, important when the caller passed `0`).
 */
export interface SchedulerMcpHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The bound port, available after `start` resolves. */
  readonly port: number;
}

/**
 * @name ResolveThreadResult
 * @description Outcome of mapping a scope (+ optional `threadKey` arg) to a single
 * target thread. `error` carries a readable message surfaced as an MCP tool error.
 */
type ResolveThreadResult = { ok: true; threadKey: string } | { ok: false; error: string };

/**
 * @description Resolve the single thread a tool call targets, from its scope and
 * an optional caller-supplied `threadKey`:
 *  - `thread` scope → that exact thread; a supplied `threadKey` must match it.
 *  - `dir` scope → the threads bound to the directory: exactly 1 → implicit;
 *    >1 → `threadKey` REQUIRED and must be one of them; 0 → error.
 * Pure given the injected `getThreadsForDirectory`.
 */
export function resolveTargetThreadKey(
  scope: SchedulerScope,
  suppliedThreadKey: string | undefined,
  getThreadsForDirectory: (directory: string) => string[],
): ResolveThreadResult {
  if (scope.kind === 'thread') {
    if (suppliedThreadKey && suppliedThreadKey !== scope.threadKey) {
      return {
        ok: false,
        error: `threadKey "${suppliedThreadKey}" does not match this session's thread (${scope.threadKey})`,
      };
    }
    return { ok: true, threadKey: scope.threadKey };
  }

  const bound = getThreadsForDirectory(scope.directory);
  if (bound.length === 0) {
    return { ok: false, error: `no thread is bound to directory "${scope.directory}"` };
  }
  if (bound.length === 1) {
    if (suppliedThreadKey && suppliedThreadKey !== bound[0]) {
      return {
        ok: false,
        error: `threadKey "${suppliedThreadKey}" is not bound to directory "${scope.directory}"`,
      };
    }
    return { ok: true, threadKey: bound[0] };
  }
  // >1 bound thread → an explicit, valid threadKey is mandatory.
  if (!suppliedThreadKey) {
    return {
      ok: false,
      error:
        `directory "${scope.directory}" has ${bound.length} bound threads; ` +
        `pass threadKey (one of: ${bound.join(', ')})`,
    };
  }
  if (!bound.includes(suppliedThreadKey)) {
    return {
      ok: false,
      error: `threadKey "${suppliedThreadKey}" is not bound to directory "${scope.directory}"`,
    };
  }
  return { ok: true, threadKey: suppliedThreadKey };
}

// ─── tool input schemas + spec building ──────────────────────────────

const scheduleCreateShape = {
  name: z.string().min(1).max(maxNameLength).describe('Short human name for the job (shown in announcements/lists).'),
  cron: z
    .string()
    .optional()
    .describe(
      '5-field host-local cron expression for a RECURRING job (e.g. "0 9 * * 1-5"). ' +
        'For a single future run use onceAt instead, NOT a cron (a cron has no year and would ' +
        'fire on the same date every year). Omit onceAt when you pass cron.',
    ),
  onceAt: z
    .string()
    .optional()
    .describe(
      'ISO 8601 instant for a ONE-SHOT run (e.g. "2026-06-07T09:00:00"). This is the right field for ' +
        '"run it once at <time>". Omit cron AND repeatCount when you pass onceAt — a one-shot always runs ' +
        'exactly once.',
    ),
  repeatCount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Number of CRON fires before the job auto-deletes (N-times recurring). ONLY for cron jobs. ' +
        'Do NOT set it for a one-shot (onceAt) — a one-shot already runs exactly once, so repeatCount ' +
        'is ignored there.',
    ),
  prompt: z
    .string()
    .min(1)
    .max(maxPromptLength)
    .describe(
      'The prompt forwarded to the agent at fire time. Make it SELF-CONTAINED — the future run starts ' +
        'with no memory of this conversation. Bake in everything it needs: the plan file path + scope, ' +
        'whether to delegate to a sub-agent, and any constraints. Put the WORK in the prompt; do the ' +
        'investigation later, when it fires.',
    ),
  isPinSilent: z
    .boolean()
    .optional()
    .describe('Pin the fire announcement silently (no member notification). Default false = notify all.'),
  threadKey: z
    .string()
    .optional()
    .describe('Target thread "<chatId>:<threadId>". Required when a directory scope has more than one bound thread.'),
};

const scheduleListShape = {
  threadKey: z
    .string()
    .optional()
    .describe('Target thread "<chatId>:<threadId>". Required when a directory scope has more than one bound thread.'),
};

const scheduleCancelShape = {
  id: z.string().min(1).describe('The schedule id to cancel (from schedule_list).'),
  threadKey: z
    .string()
    .optional()
    .describe('Target thread "<chatId>:<threadId>". Required when a directory scope has more than one bound thread.'),
};

const sendFileShape = {
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe(
      'Files to send, as 1..10 paths RELATIVE to this topic\'s bound folder (absolute paths are accepted ' +
        'only if they resolve inside it). A path outside the folder is rejected and nothing is sent. ' +
        '2..10 paths are delivered as ONE album.',
    ),
  caption: z
    .string()
    .optional()
    .describe('Optional caption (Telegram caps it at 1024 chars; longer is trimmed). For an album it rides the first file.'),
  as_file: z
    .boolean()
    .optional()
    .describe('Force "send as document" (original quality, no inline preview) even for images and gifs.'),
  threadKey: z
    .string()
    .optional()
    .describe('Target thread "<chatId>:<threadId>". Required when a directory scope has more than one bound thread.'),
};

/**
 * The three valid call shapes, appended to structural errors so a bad first call
 * teaches the corrected next call (the model spirals when an error says only what
 * is wrong, not what shape to use instead — observed in the live transcript).
 */
const scheduleRecipes =
  'Recipes — one-shot: pass onceAt (ISO), omit cron and repeatCount. ' +
  'Recurring: pass cron, omit onceAt. ' +
  'Recurring N times: pass cron and repeatCount, omit onceAt.';

/**
 * @description Collapse an optional free-text field to `undefined` when it is
 * absent OR blank (empty / whitespace-only). MCP bridges can render an omitted
 * optional as an empty string (`cron=""` on a one-shot, `onceAt=""` on a cron),
 * and an empty string must NOT count as a supplied value for the exactly-one-of
 * check. Trimming also tolerates accidental surrounding whitespace.
 */
function normalizeOptionalArg(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @name BuildSpecResult
 * @description Outcome of turning the create-tool args into a {@link ScheduleSpec}.
 * `note` carries a non-fatal advisory surfaced alongside a successful create
 * (e.g. a `repeatCount` ignored on a one-shot). `error` is a readable validation
 * message (exactly-one-of, bad cron / past one-shot) surfaced as an MCP tool error.
 */
type BuildSpecResult = { ok: true; spec: ScheduleSpec; note?: string } | { ok: false; error: string };

/**
 * @description Validate the create args and build a {@link ScheduleSpec}: exactly
 * one of `cron`/`onceAt` (empty/whitespace fields normalised away first); then run
 * the shared {@link validateScheduleSpec} (cron parse + min-interval + past-one-shot).
 * `nowMs` is injected so the past-one-shot check is deterministic.
 *
 * A `repeatCount` supplied alongside `onceAt` is IGNORED (not rejected): a one-shot
 * is by definition a single run, so the count is meaningless there. The model
 * naturally reaches for `repeatCount: 1` to express "run once" and, when that was
 * a hard error, spiralled into absurd counts / a wrong-year cron workaround
 * (live transcript). Accepting the natural call removes that failure mode; the
 * returned `note` teaches the agent the field was redundant.
 */
export function buildSpecFromCreateArgs(
  args: { cron?: string; onceAt?: string; repeatCount?: number },
  nowMs: number,
): BuildSpecResult {
  const cron = normalizeOptionalArg(args.cron);
  const onceAt = normalizeOptionalArg(args.onceAt);
  const { repeatCount } = args;

  if (cron && onceAt) {
    return { ok: false, error: `Pass either cron OR onceAt, not both. ${scheduleRecipes}` };
  }
  if (!cron && !onceAt) {
    return { ok: false, error: `Pass exactly one of cron or onceAt. ${scheduleRecipes}` };
  }

  let note: string | undefined;
  if (onceAt && repeatCount !== undefined) {
    note = 'repeatCount was ignored — a one-shot (onceAt) always runs exactly once.';
  }

  const spec: ScheduleSpec = cron
    ? { kind: 'cron', cronExpr: cron, ...(repeatCount !== undefined ? { remainingRuns: repeatCount } : {}) }
    : { kind: 'once', onceAtIso: onceAt as string };

  const validationError = validateScheduleSpec(spec, nowMs);
  if (validationError) return { ok: false, error: validationError };
  return { ok: true, spec, note };
}

// ─── tool result helpers ─────────────────────────────────────────────

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Wrap text as a successful MCP tool result (plain text content block). */
function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Wrap a readable message as an MCP tool ERROR result the agent relays to the user. */
function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** One-line human summary of a record for `schedule_list` / create confirmations. */
function summarizeRecord(record: ScheduleRecord): string {
  const next = record.nextRunAt !== null ? new Date(record.nextRunAt).toISOString() : 'none';
  const pausedNote = record.isPaused ? ' [paused]' : '';
  return `${record.name} (id: ${record.id}) — ${describeSchedule(record.spec)}; next run: ${next}${pausedNote}`;
}

// ─── tool handlers (scope-bound) ─────────────────────────────────────

/**
 * @description Register the three scoped tools onto a fresh {@link McpServer}.
 * Every handler resolves the target thread from `scope` first (scope isolation),
 * then operates only on that thread's jobs. Bound to `deps` + the request's
 * verified `scope`.
 */
function registerSchedulerTools(server: McpServer, deps: SchedulerMcpDeps, scope: SchedulerScope): void {
  server.registerTool(
    'schedule_create',
    {
      title: 'Create a scheduled prompt',
      description:
        'Schedule a prompt to be delivered to this topic later. The bot announces, pins, and ' +
        'forwards the prompt to the agent at fire time.\n\n' +
        'Pick exactly ONE mode:\n' +
        '• one-shot (run once at a time): pass onceAt (ISO 8601); omit cron and repeatCount.\n' +
        '• recurring: pass cron (5-field); omit onceAt.\n' +
        '• recurring N times: pass cron AND repeatCount; omit onceAt.\n' +
        'For a single future run ALWAYS use onceAt — never a cron with repeatCount:1 ' +
        '(a cron has no year, so it would fire on that date every year). repeatCount counts CRON ' +
        'fires only and is ignored for a one-shot.\n\n' +
        'USE THIS whenever the user asks to schedule execution of a plan or task for later ' +
        "(e.g. \"schedule finishing plan X in 2h\", \"run this plan tomorrow morning\"). " +
        'Schedule IMMEDIATELY: write the request straight into `prompt` and create the job FIRST — ' +
        'do NOT read code, explore the repo, or deliberate before scheduling. Plan now, figure out the ' +
        'details at fire time. The future run does the investigation, not this call.',
      inputSchema: scheduleCreateShape,
    },
    async (args) => {
      const resolved = resolveTargetThreadKey(scope, args.threadKey, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);

      const nowMs = Date.now();
      const built = buildSpecFromCreateArgs(args, nowMs);
      if (!built.ok) return errorResult(built.error);

      let threadKey: ThreadKey;
      try {
        threadKey = keyFromString(resolved.threadKey);
      } catch {
        return errorResult(`invalid threadKey "${resolved.threadKey}"`);
      }

      const created = await createScheduleForThread(deps.store, {
        threadKey,
        name: args.name,
        spec: built.spec,
        prompt: args.prompt,
        createdBy: 'agent',
        nowMs,
        lastAdapterName: deps.getThreadAdapterName(resolved.threadKey),
        isPinSilent: args.isPinSilent,
      });
      if (!created.ok) {
        return errorResult(`cannot create: thread already has the maximum of ${created.limit} schedules`);
      }

      const record = created.record;
      deps.armJob(record);
      const noteSuffix = built.note ? `\n\nℹ️ ${built.note}` : '';
      return textResult(`Scheduled "${record.name}".\n${summarizeRecord(record)}${noteSuffix}`);
    },
  );

  server.registerTool(
    'schedule_list',
    {
      title: 'List scheduled prompts',
      description: 'List the scheduled prompts for this topic (id, name, schedule, next run, paused flag).',
      inputSchema: scheduleListShape,
    },
    async (args) => {
      const resolved = resolveTargetThreadKey(scope, args.threadKey, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);

      let threadKey: ThreadKey;
      try {
        threadKey = keyFromString(resolved.threadKey);
      } catch {
        return errorResult(`invalid threadKey "${resolved.threadKey}"`);
      }

      const records = deps.store.getThreadSchedules(threadKey);
      if (records.length === 0) {
        return textResult('No schedules for this topic.');
      }
      const lines = records.map((record, index) => `${index + 1}. ${summarizeRecord(record)}`);
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'schedule_cancel',
    {
      title: 'Cancel a scheduled prompt',
      description: 'Cancel (delete) a scheduled prompt by its id. Only schedules owned by this topic can be cancelled.',
      inputSchema: scheduleCancelShape,
    },
    async (args) => {
      const resolved = resolveTargetThreadKey(scope, args.threadKey, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);

      const record = deps.store.getSchedules()[args.id];
      // Scope isolation: the record must exist AND belong to the resolved thread.
      if (!record || record.threadKey !== resolved.threadKey) {
        return errorResult(`no schedule with id "${args.id}" in this topic`);
      }

      await deps.store.removeSchedule(args.id);
      deps.disarmJob(args.id);
      return textResult(`Cancelled "${record.name}" (id: ${record.id}).`);
    },
  );
}

/**
 * @description Register the agent→Telegram `send_file` tool onto a fresh
 * {@link McpServer}. Kept separate from {@link registerSchedulerTools} so the
 * scheduler tools stay cohesive. Like every tool here it resolves the target
 * thread from `scope` first (scope isolation — the agent can never name another
 * topic); the actual path-safety + Telegraf send live in `deps.sendFilesToThread`.
 */
function registerFileSendTool(server: McpServer, deps: SchedulerMcpDeps, scope: SchedulerScope): void {
  server.registerTool(
    'send_file',
    {
      title: 'Send a file or image to this topic',
      description:
        'Send one or more files/images from THIS topic\'s bound folder back to the user in the topic. ' +
        'Use it to deliver a generated chart, screenshot, report, etc. Paths are relative to the bound ' +
        'folder; a path outside it is rejected and nothing is sent. Images (.png/.jpg/.jpeg/.webp) preview ' +
        'inline, .gif autoplays, everything else arrives as a document — pass as_file:true to force document ' +
        '(full quality) even for images. 2..10 paths are delivered as one album (a mixed or gif-containing ' +
        'album falls back to documents). Caption is optional (trimmed to 1024 chars; on the first album item).',
      inputSchema: sendFileShape,
    },
    async (args) => {
      const resolved = resolveTargetThreadKey(scope, args.threadKey, deps.getThreadsForDirectory);
      if (!resolved.ok) return errorResult(resolved.error);

      const result = await deps.sendFilesToThread(resolved.threadKey, {
        paths: args.paths,
        caption: args.caption,
        asFile: args.as_file,
      });
      return result.ok ? textResult(result.summary) : errorResult(result.error);
    },
  );
}

// ─── server factory ──────────────────────────────────────────────────

/**
 * @description Build a fresh {@link McpServer} for one request, registering the
 * scope-bound scheduler tools plus the `send_file` tool. The SDK binds one server
 * per transport per connection, so a new instance is built (and closed) per
 * request in the stateless flow.
 */
function buildRequestServer(deps: SchedulerMcpDeps, scope: SchedulerScope): McpServer {
  const server = new McpServer({ name: mcpServerName, version: mcpServerVersion });
  registerSchedulerTools(server, deps, scope);
  registerFileSendTool(server, deps, scope);
  return server;
}

/** Read the whole request body into a string (the SDK wants the parsed JSON body). */
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Write a JSON-RPC error response (used for the 401 / not-found paths the SDK doesn't reach). */
function writeJsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * @description Create the bot-owned scheduler MCP server. Returns a handle with
 * `start`/`stop` and the bound `port`. The HTTP listener is plain `node:http`
 * (no web framework) on `127.0.0.1`; each request verifies the bearer token,
 * builds a fresh stateless transport + `McpServer`, and tears them down when the
 * response finishes. Invalid/missing tokens get a JSON-RPC 401 without touching
 * any tool.
 */
export function createSchedulerMcpServer(deps: SchedulerMcpDeps): SchedulerMcpHandle {
  const requestedPort = deps.port ?? getSchedulerMcpPort();
  let boundPort = requestedPort;
  let httpServer: Server | null = null;

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const secret = await deps.getSecret();
    const token = extractBearerToken(req.headers.authorization);
    const scope = token ? verifySchedulerMcpToken(secret, token) : null;
    if (!scope) {
      // -32001 (SDK's "unauthorized" convention) + HTTP 401, no tool touched.
      writeJsonRpcError(res, 401, -32001, 'Unauthorized: missing or invalid scheduler token');
      return;
    }

    const bodyText = await readRequestBody(req);
    let parsedBody: unknown;
    try {
      parsedBody = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    } catch {
      writeJsonRpcError(res, 400, -32700, 'Parse error: request body is not valid JSON');
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildRequestServer(deps, scope);
    // Stateless: the transport + server live only for this request; close both
    // when the response finishes so no connection state lingers.
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        if (req.url && req.url.split('?')[0] === schedulerMcpPath) {
          handleMcpRequest(req, res).catch((error) => {
            console.error('[scheduler-mcp] request handling failed:', error);
            if (!res.headersSent) {
              writeJsonRpcError(res, 500, -32603, 'Internal error');
            } else {
              res.end();
            }
          });
          return;
        }
        writeJsonRpcError(res, 404, -32601, 'Not found');
      });
      server.on('error', reject);
      server.listen(requestedPort, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') boundPort = address.port;
        httpServer = server;
        server.off('error', reject);
        resolve();
      });
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!httpServer) {
        resolve();
        return;
      }
      httpServer.close(() => {
        httpServer = null;
        resolve();
      });
    });
  }

  return {
    start,
    stop,
    get port() {
      return boundPort;
    },
  };
}
