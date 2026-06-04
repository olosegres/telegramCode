import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './state';
import type { ThreadKey } from './types';
import { keyToString } from './types';

/**
 * @description Output-trace special mode: a JSONL record of what the bot
 * factually did versus what reached Telegram, so live verification can diff
 * `emit → sendTry → sendOk/sendErr` against `get_history` instead of guessing
 * from the controlling terminal (which is not capturable after the fact).
 *
 * Enabled with `OUTPUT_TRACE=1`; off by default (every hook early-returns on
 * one env check). Entries land in `DATA_DIR/output-trace.jsonl`, size-capped
 * with a single `.1` rollover like `diagLog.ts`.
 *
 * Entry kinds:
 *  - `recv`    — incoming Telegram update (middleware): type, from, preview,
 *                latency vs the update's own timestamp
 *  - `emit`    — adapter `output`/`status` event entering the bot send path
 *  - `sendTry` / `sendOk` / `sendErr` — every outgoing Bot API call, recorded
 *                at the `callApi` chokepoint (i.e. AFTER queue/bucket waits;
 *                each 429 retry attempt is its own try/err pair)
 */
const maxTraceBytes = 10 * 1024 * 1024;
const previewLength = 120;
const traceFileName = 'output-trace.jsonl';

export function checkIsOutputTraceEnabled(): boolean {
  return process.env.OUTPUT_TRACE === '1';
}

function getTraceFilePath(): string {
  return path.join(resolveDataDir(), traceFileName);
}

/** Truncate multi-kilobyte payloads down to a greppable one-liner fragment. */
export function createTracePreview(text: string): string {
  return text.length <= previewLength ? text : `${text.slice(0, previewLength)}…`;
}

type TraceFieldValue = string | number | boolean | null | undefined;

function rotateIfOversized(filePath: string): void {
  if (!existsSync(filePath)) return;
  if (statSync(filePath).size <= maxTraceBytes) return;
  renameSync(filePath, `${filePath}.1`);
}

/**
 * @description Append one trace entry. Never throws — tracing must not be able
 * to take the bot down, so every IO error is swallowed (same contract as
 * `appendDiagLog`). `undefined` fields are dropped by `JSON.stringify`.
 */
function appendTraceEntry(kind: string, fields: Record<string, TraceFieldValue>): void {
  if (!checkIsOutputTraceEnabled()) return;
  try {
    const filePath = getTraceFilePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    rotateIfOversized(filePath);
    appendFileSync(filePath, `${JSON.stringify({ ts: new Date().toISOString(), kind, ...fields })}\n`);
  } catch {
    // Tracing is best-effort; a logging failure must never break the bot.
  }
}

export interface RecvTraceFields {
  updateType: string;
  updateId: number;
  fromId?: number;
  chatId?: number;
  threadId?: number;
  preview?: string;
  /** Telegram-side `message.date` in seconds — lets us compute receive latency. */
  tgDateSec?: number;
}

/** Record an incoming update the moment the first middleware sees it. */
export function traceRecvUpdate(fields: RecvTraceFields): void {
  const { tgDateSec, preview, ...rest } = fields;
  appendTraceEntry('recv', {
    ...rest,
    preview: preview === undefined ? undefined : createTracePreview(preview),
    latencyMs: tgDateSec === undefined ? undefined : Date.now() - tgDateSec * 1000,
  });
}

/** Record an adapter `output`/`status` event entering the bot's send path. */
export function traceAgentEmit(event: 'output' | 'status', key: ThreadKey, text: string): void {
  appendTraceEntry('emit', {
    event,
    key: keyToString(key),
    len: text.length,
    preview: createTracePreview(text),
  });
}

interface TelegramApiErrorLike {
  response?: {
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  };
  message?: string;
}

function extractTelegramErrorFields(err: unknown): Record<string, TraceFieldValue> {
  if (typeof err !== 'object' || err === null) {
    return { error: JSON.stringify(err) };
  }
  const e = err as TelegramApiErrorLike;
  return {
    errorCode: e.response?.error_code,
    description: e.response?.description,
    retryAfterSec: e.response?.parameters?.retry_after,
    error: typeof e.message === 'string' ? e.message : undefined,
  };
}

function getNumberField(source: Record<string, unknown>, field: string): number | undefined {
  const value = source[field];
  return typeof value === 'number' ? value : undefined;
}

function getStringField(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field];
  return typeof value === 'string' ? value : undefined;
}

function extractApiCallFields(method: string, payload: object): Record<string, TraceFieldValue> {
  const p = payload as Record<string, unknown>;
  const text = getStringField(p, 'text');
  return {
    method,
    chatId: getNumberField(p, 'chat_id'),
    threadId: getNumberField(p, 'message_thread_id'),
    messageId: getNumberField(p, 'message_id'),
    callbackQueryId: getStringField(p, 'callback_query_id'),
    len: text?.length,
    preview: text === undefined ? undefined : createTracePreview(text),
  };
}

/**
 * @description Structural view of `Telegram`/`ApiClient` — just enough to wrap
 * `callApi`. Method syntax keeps `Telegram` assignable (bivariant params), and
 * lets unit tests pass a plain fake instead of booting Telegraf.
 */
export interface CallApiHost {
  callApi(method: string, payload: object, options?: object): Promise<object | boolean | number | string>;
}

/**
 * @description Wrap `telegram.callApi` so every outgoing Bot API call is
 * traced with its outcome. Installed unconditionally at boot — when the mode
 * is off each call costs one env check. The wrap sits BELOW `enqueueSend`'s
 * queue/bucket/429-retry layers, so each real HTTP attempt traces separately.
 */
export function installCallApiTrace(host: CallApiHost): void {
  const originalCallApi = host.callApi.bind(host);
  host.callApi = async (method, payload, options) => {
    const callFields = extractApiCallFields(method, payload);
    appendTraceEntry('sendTry', callFields);
    const startedAt = Date.now();
    try {
      const result = await originalCallApi(method, payload, options);
      appendTraceEntry('sendOk', {
        ...callFields,
        durMs: Date.now() - startedAt,
        resultMessageId:
          typeof result === 'object' && result !== null
            ? getNumberField(result as Record<string, unknown>, 'message_id')
            : undefined,
      });
      return result;
    } catch (err) {
      appendTraceEntry('sendErr', {
        ...callFields,
        durMs: Date.now() - startedAt,
        ...extractTelegramErrorFields(err),
      });
      throw err;
    }
  };
}
