import { promises as fsp } from 'node:fs';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './state';
import { getHourBucketPath, pruneExpiredBuckets, retentionMs } from './utils/rotatingLogFile';
import { GENERAL_THREAD_ID } from './threadRouting';
import type { ThreadKey } from './types';
import { keyToString } from './types';

/**
 * @description Output-trace special mode: a JSONL record of what the bot
 * factually did versus what reached Telegram, so live verification can diff
 * `emit → sendTry → sendOk/sendErr` against `get_history` instead of guessing
 * from the controlling terminal (which is not capturable after the fact).
 *
 * Toggled at RUNTIME via the `/trace` command (no boot-time env var anymore):
 *  - `/trace on`     — trace THIS topic's events
 *  - `/trace on all` — trace every thread (cross-thread forensics)
 *  - `/trace off`    — stop tracing this topic
 *  - `/trace off all`— clear the all-threads flag AND the per-thread set
 * The toggle state is persisted in `state.json` and seeded back into this
 * module at boot via {@link setTraceConfig}, so it survives hot rebuilds.
 *
 * ON by default for ALL threads (always-on observability): a fresh state file
 * reads back `allThreads: true`, so every thread is recorded with zero setup.
 * `/trace off all` turns it off DURABLY. When tracing IS off (off-all + no
 * opted-in thread) every hook early-returns after one cheap boolean / `Set`
 * check (zero IO).
 *
 * When ON the writer is async-buffered: {@link appendTraceEntry} builds the
 * JSON line immediately and pushes it to an in-memory buffer; a single-flight
 * background flush (`fsp.appendFile`) drains the whole buffer at once, armed
 * by a {@link traceFlushIntervalMs} timer or a {@link traceFlushMaxEntries}
 * length threshold. A `process.on('exit')` hook does a best-effort SYNC flush
 * of the remainder. Entries land in an hourly bucket file
 * `DATA_DIR/output-trace-YYYYMMDDHH.jsonl` (size-capped per bucket with a single
 * `.1` rollover like `diagLog.ts`); buckets older than 6h are pruned by the
 * bot's janitor via {@link pruneTraceBuckets}.
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
/** Bucket file base + extension — `output-trace-YYYYMMDDHH.jsonl` per hour. */
const traceFileBase = 'output-trace';
const traceFileExt = 'jsonl';
/** Flush the buffer at least this often (ms) even if it never fills up. */
const traceFlushIntervalMs = 500;
/** Flush early once the buffer reaches this many lines (bounds memory + lag). */
const traceFlushMaxEntries = 200;
/** Unicode high-surrogate range — a lone leading half breaks JSON consumers. */
const highSurrogateMin = 0xd800;
const highSurrogateMax = 0xdbff;

// ─── runtime toggle state (seeded from state.json at boot via setTraceConfig) ───

/** When true every thread is traced (cross-thread forensics). */
let traceAllThreads = false;
/** ThreadKey strings (`"<chatId>:<threadId>"`) explicitly opted into tracing. */
const tracedThreadKeys = new Set<string>();

/**
 * @description Snapshot of the persisted trace toggle. Mirrors what is stored
 * in `state.json` so the bot can read the current config back for `/trace`
 * status replies and re-seed this module after a restart.
 */
export interface TraceConfig {
  allThreads: boolean;
  threadKeys: string[];
}

/**
 * @description Replace the in-memory trace toggle from persisted state. Called
 * once at boot (seed from `state.json`) and again on every `/trace` mutation so
 * the writer and the persisted record never drift. Lifecycle-independent: only
 * `/trace` touches it — session stop/new/quit/resume/unbind never do.
 */
export function setTraceConfig(config: TraceConfig): void {
  traceAllThreads = config.allThreads;
  tracedThreadKeys.clear();
  for (const keyStr of config.threadKeys) tracedThreadKeys.add(keyStr);
}

/** Current trace toggle as a plain snapshot — for `/trace` status + persistence. */
export function getTraceConfig(): TraceConfig {
  return { allThreads: traceAllThreads, threadKeys: [...tracedThreadKeys] };
}

/**
 * @description Whether ANY tracing is active (all-flag set OR at least one
 * thread opted in). The single fast-path gate every hook hits first — when it
 * returns false the hook does no work beyond this check.
 */
export function checkIsTracingActive(): boolean {
  return traceAllThreads || tracedThreadKeys.size > 0;
}

/**
 * @description Whether a specific thread's events should be recorded:
 * the all-flag covers everything, otherwise the thread must be opted in.
 */
export function checkIsThreadTraced(key: ThreadKey): boolean {
  return traceAllThreads || tracedThreadKeys.has(keyToString(key));
}

/**
 * @description Path of the CURRENT hour's trace bucket
 * (`DATA_DIR/output-trace-YYYYMMDDHH.jsonl`). Recomputed per flush so the writer
 * rolls into a fresh file every hour with no live-file trimming — old buckets
 * are pruned wholesale by {@link pruneTraceBuckets} (a writer never touches a
 * past bucket, so prune races nothing). The per-bucket 10MB `.1` rollover still
 * applies WITHIN an hour.
 */
function getTraceFilePath(): string {
  return getHourBucketPath(resolveDataDir(), traceFileBase, traceFileExt, Date.now());
}

/**
 * @description Delete trace buckets older than the shared 6h retention window
 * (the hourly `output-trace-*.jsonl` files + their `.1` siblings). Best-effort;
 * called at boot and on the file-sweep interval by the bot's janitor.
 */
export function pruneTraceBuckets(nowMs: number): Promise<void> {
  return pruneExpiredBuckets(resolveDataDir(), traceFileBase, traceFileExt, retentionMs, nowMs);
}

/**
 * @description Truncate `text` to a greppable one-liner without splitting a
 * UTF-16 surrogate pair. A naive `slice(0, 120)` can cut between the high and
 * low half of an emoji, leaving a lone high surrogate that serialises to an
 * unpaired `\ud83d` and breaks `jq` consumers of the trace file (observed in
 * the real trace). If the slice ends on a high surrogate we drop that trailing
 * half so only whole code points survive.
 */
export function createTracePreview(text: string): string {
  if (text.length <= previewLength) return text;
  let cut = previewLength;
  const lastCharCode = text.charCodeAt(cut - 1);
  if (lastCharCode >= highSurrogateMin && lastCharCode <= highSurrogateMax) {
    cut -= 1;
  }
  return `${text.slice(0, cut)}…`;
}

type TraceFieldValue = string | number | boolean | null | undefined;

// ─── async buffered writer (DI-able for tests via configureTraceWriter) ───

/**
 * @description Filesystem + timer seams the buffered writer depends on. Tests
 * inject fakes so they can assert flush ordering / threshold / rotation /
 * exit-flush deterministically without real IO or wall-clock timers.
 */
export interface TraceWriterDeps {
  appendFile(filePath: string, data: string): Promise<void>;
  appendFileSync(filePath: string, data: string): void;
  mkdir(dirPath: string): Promise<void>;
  /** File size in bytes, or null if the file does not exist. */
  getFileSize(filePath: string): Promise<number | null>;
  rename(fromPath: string, toPath: string): Promise<void>;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const defaultWriterDeps: TraceWriterDeps = {
  appendFile: (filePath, data) => fsp.appendFile(filePath, data),
  appendFileSync: (filePath, data) => appendFileSync(filePath, data),
  mkdir: async (dirPath) => {
    await fsp.mkdir(dirPath, { recursive: true });
  },
  getFileSize: async (filePath) => {
    try {
      return (await fsp.stat(filePath)).size;
    } catch {
      return null;
    }
  },
  rename: (fromPath, toPath) => fsp.rename(fromPath, toPath),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

let writerDeps: TraceWriterDeps = defaultWriterDeps;
/** Lines waiting to be flushed, in arrival order. */
let traceBuffer: string[] = [];
/** A flush is currently in flight — defer the next one (single-flight order). */
let isFlushing = false;
/** Armed flush timer handle (or null when none is pending). */
let flushTimerHandle: unknown = null;
/** mkdir is issued once per process, not per entry. */
let isTraceDirEnsured = false;

/**
 * @description Override the writer's fs/timer seams (tests only). Also resets
 * the buffer + flush state so each test starts clean. Returns a restore fn.
 */
export function configureTraceWriterForTests(deps: Partial<TraceWriterDeps>): () => void {
  writerDeps = { ...defaultWriterDeps, ...deps };
  traceBuffer = [];
  isFlushing = false;
  flushTimerHandle = null;
  isTraceDirEnsured = false;
  return () => {
    writerDeps = defaultWriterDeps;
    traceBuffer = [];
    isFlushing = false;
    flushTimerHandle = null;
    isTraceDirEnsured = false;
  };
}

function armFlushTimer(): void {
  if (flushTimerHandle !== null) return;
  flushTimerHandle = writerDeps.setTimer(() => {
    flushTimerHandle = null;
    void flushTraceBuffer();
  }, traceFlushIntervalMs);
}

/**
 * @description Rotate the trace file to `.1` if it has grown past the cap.
 * Checked once per flush (not per entry) to keep the hot path append-only.
 */
async function rotateIfOversized(filePath: string): Promise<void> {
  const size = await writerDeps.getFileSize(filePath);
  if (size === null || size <= maxTraceBytes) return;
  await writerDeps.rename(filePath, `${filePath}.1`);
}

/**
 * @description Drain the whole buffer into one `appendFile`. Single-flight: if
 * a flush is already running, we return and the in-flight flush re-checks the
 * buffer when it finishes, so lines are appended strictly in arrival order with
 * no interleaving. Never throws — tracing must not be able to take the bot down.
 */
async function flushTraceBuffer(): Promise<void> {
  if (isFlushing) return;
  if (traceBuffer.length === 0) return;
  isFlushing = true;
  try {
    const filePath = getTraceFilePath();
    if (!isTraceDirEnsured) {
      await writerDeps.mkdir(path.dirname(filePath));
      isTraceDirEnsured = true;
    }
    await rotateIfOversized(filePath);
    // Snapshot + clear BEFORE the await so concurrent pushes land in a fresh
    // buffer and are flushed by the re-check below, never lost or reordered.
    const pending = traceBuffer;
    traceBuffer = [];
    await writerDeps.appendFile(filePath, pending.join(''));
  } catch {
    // Tracing is best-effort; a logging failure must never break the bot.
  } finally {
    isFlushing = false;
    // A push (or another rotation-deferred chunk) may have arrived mid-flush.
    if (traceBuffer.length > 0) {
      if (traceBuffer.length >= traceFlushMaxEntries) void flushTraceBuffer();
      else armFlushTimer();
    }
  }
}

/**
 * @description Best-effort SYNCHRONOUS flush of whatever is still buffered.
 * Registered on `process.on('exit')` — exit handlers can only do sync work, so
 * the async writer would otherwise lose the final unflushed window on shutdown.
 */
export function flushTraceBufferSyncOnExit(): void {
  if (traceBuffer.length === 0) return;
  try {
    const filePath = getTraceFilePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    if (existsSync(filePath) && statSync(filePath).size > maxTraceBytes) {
      renameSync(filePath, `${filePath}.1`);
    }
    const pending = traceBuffer;
    traceBuffer = [];
    writerDeps.appendFileSync(filePath, pending.join(''));
  } catch {
    // Best-effort on shutdown; a failure here must not block the exit.
  }
}

/**
 * @description Build one trace entry and enqueue it for the buffered writer.
 * The JSON line is materialised immediately (the field object is not retained),
 * then a flush is triggered on the length threshold or armed on the timer.
 * `undefined` fields are dropped by `JSON.stringify`.
 */
function appendTraceEntry(kind: string, fields: Record<string, TraceFieldValue>): void {
  traceBuffer.push(`${JSON.stringify({ ts: new Date().toISOString(), kind, ...fields })}\n`);
  if (traceBuffer.length >= traceFlushMaxEntries) {
    void flushTraceBuffer();
  } else {
    armFlushTimer();
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

/**
 * @description Record an incoming update the moment the first middleware sees
 * it — only if the update's own thread is traced. The key is built the same way
 * routing does (`{chatId, threadId}`); a missing thread id maps to the General
 * topic's `threadId: 1` so it filters consistently. When `chatId` is absent
 * (rare service updates) we can't derive a key, so it records only under the
 * all-flag.
 */
export function traceRecvUpdate(fields: RecvTraceFields): void {
  if (!checkIsTracingActive()) return;
  const { tgDateSec, preview, chatId, threadId, ...rest } = fields;
  if (!checkIsRecvThreadTraced(chatId, threadId)) return;
  appendTraceEntry('recv', {
    ...rest,
    chatId,
    threadId,
    preview: preview === undefined ? undefined : createTracePreview(preview),
    latencyMs: tgDateSec === undefined ? undefined : Date.now() - tgDateSec * 1000,
  });
}

/**
 * @description Decide whether a recv update belongs to a traced thread. The
 * all-flag covers everything. Otherwise we need a chat id to build the key;
 * a thread-less message (no `message_thread_id`) is the General topic, which
 * routing keys under `GENERAL_THREAD_ID`.
 */
function checkIsRecvThreadTraced(chatId: number | undefined, threadId: number | undefined): boolean {
  if (traceAllThreads) return true;
  if (chatId === undefined) return false;
  return tracedThreadKeys.has(keyToString({ chatId, threadId: threadId ?? GENERAL_THREAD_ID }));
}

/** Record an adapter `output`/`status`/`thinking`/`toolResult` event entering the bot's send path. */
export function traceAgentEmit(event: 'output' | 'status' | 'thinking' | 'toolResult', key: ThreadKey, text: string): void {
  if (!checkIsThreadTraced(key)) return;
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

function getBooleanField(source: Record<string, unknown>, field: string): boolean | undefined {
  const value = source[field];
  return typeof value === 'boolean' ? value : undefined;
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
    // Whether a (un)pin / send suppresses the member notification — load-bearing
    // for the question-pin "one question = one notification" rule (first pin
    // notifies, repins are silent), so it must be visible in the trace.
    disableNotification: getBooleanField(p, 'disable_notification'),
    len: text?.length,
    preview: text === undefined ? undefined : createTracePreview(text),
  };
}

/**
 * @description Decide whether an outgoing Bot API call should be recorded.
 * A call WITH a derivable thread id (chat_id + the General-default thread)
 * filters like recv/emit. A call with NO derivable thread id (e.g.
 * `editMessageText` payloads carry only `message_id`) is recorded whenever ANY
 * tracing is active — over-inclusion beats silently losing edit records
 * (locked decision, plan S3).
 */
function checkIsApiCallTraced(fields: Record<string, TraceFieldValue>): boolean {
  if (traceAllThreads) return true;
  const chatId = typeof fields.chatId === 'number' ? fields.chatId : undefined;
  if (chatId === undefined) return true;
  const threadId = typeof fields.threadId === 'number' ? fields.threadId : GENERAL_THREAD_ID;
  return tracedThreadKeys.has(keyToString({ chatId, threadId }));
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
 * traced with its outcome. Installed unconditionally at boot — when tracing is
 * off each call costs one boolean check. The wrap sits BELOW `enqueueSend`'s
 * queue/bucket/429-retry layers, so each real HTTP attempt traces separately.
 */
export function installCallApiTrace(host: CallApiHost): void {
  const originalCallApi = host.callApi.bind(host);
  host.callApi = async (method, payload, options) => {
    if (!checkIsTracingActive()) return originalCallApi(method, payload, options);
    const callFields = extractApiCallFields(method, payload);
    if (!checkIsApiCallTraced(callFields)) return originalCallApi(method, payload, options);
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
