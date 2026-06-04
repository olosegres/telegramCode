import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { keyToString, type ThreadKey } from './types';

/**
 * @description On-disk state for the multi-thread telegram bot.
 *
 * Replaces the legacy `~/.telegram-bot-messages.json` (which only persisted
 * `messageIds` per user) with a richer per-`ThreadKey` schema:
 *
 *   - `bindings[key]`  → thread is attached to a subdir under `WORK_ROOT`
 *   - `agents[key]`    → which adapter the thread is using, model, session ids
 *   - `messages[key]`  → message ids tracked by `/clear`
 *
 * Schema source: plan §9. Field additions for D14 (`claudeSessionId`), §13.19
 * (`opencodeSessionId`) and D49 (`bindings[key].closed`) are inlined here.
 *
 * The file is rewritten atomically (`writeFile(tmp) → fsync(fd) → rename →
 * fsync(parentDir)`, plan §13.14, T4). Concurrent mutations to the same
 * `ThreadKey` are serialised by a per-key async lock (plan §13.15, E3).
 *
 * **This module is intentionally NOT yet imported from `bot.ts`.** Plan §11
 * Этап 2 wires state in only on the following commit (Этап 3) — keeping the
 * landing surgical.
 */

/** Current schema version stamped into `state.json`. Bump on breaking layout changes. */
export const STATE_SCHEMA_VERSION = 1;

/** Default debounce window (ms) for batched saves. Overridable via the store constructor for tests. */
const DEFAULT_SAVE_DEBOUNCE_MS = 500;

export interface BindingData {
  /** Subdirectory under `WORK_ROOT` this thread is attached to. */
  subdir: string;
  /** ISO timestamp the binding was first created. */
  createdAt: string;
  /**
   * Whether the forum topic is currently marked closed in Telegram.
   * Toggled by `forum_topic_closed` / `forum_topic_reopened` events
   * (plan §13.10, D49). Closed binding is preserved on purpose — closing
   * is reversible, deletion isn't.
   */
  closed?: boolean;
  /**
   * Telegram message id of the per-thread pinned status banner, if any.
   * Set on first `/bind`, edited on every agent state change, unpinned +
   * cleared on `/unbind`. Plan §11 Этап 7 / §20.5 / D52 area. Persisting
   * the id lets a bot restart re-find the pinned message instead of
   * pinning a fresh banner above it (which Telegram allows, producing a
   * stack of stale pins).
   */
  pinnedStatusMessageId?: number;
  /**
   * Last banner text we successfully sent/edited for {@link pinnedStatusMessageId}.
   * The in-memory `pinnedStatusTextCache` is rebuilt from this at boot so the
   * startup banner-refresh wave skips the `editMessageText` round-trip when the
   * computed banner equals what is already displayed (B8) — every restart
   * otherwise re-edits ~9 identical banners, each a wasted "message is not
   * modified" 400 burning the chat-wide send budget. Cleared whenever the
   * banner message is unpinned/deleted or its id is nulled, so a stale text
   * can never suppress a needed edit for a fresh banner message.
   */
  pinnedStatusText?: string;
}

export interface AgentData {
  /** Adapter name, e.g. `'claude'` or `'opencode'`. */
  name: string;
  /** Optional model override (e.g. `'sonnet'`, `'anthropic/claude-3-5-sonnet'`). */
  model?: string;
  /**
   * UUID we pass via `claude --session-id <uuid>` on a fresh start and via
   * `claude --resume <uuid>` on later attaches (plan §13.1, D14). Lets two
   * threads share one `workDir` without their histories cross-contaminating.
   */
  claudeSessionId?: string;
  /**
   * Server-assigned OpenCode session id. Used to re-attach the SSE stream
   * after a bot restart (plan §13.19).
   */
  opencodeSessionId?: string;
}

export interface StateV1 {
  version: number;
  bindings: Record<string, BindingData>;
  agents: Record<string, AgentData>;
  messages: Record<string, number[]>;
  /**
   * Numeric chat id of the forum supergroup discovered via auto-pairing,
   * persisted so the operator doesn't have to look up the `-100…` id by
   * hand. Only consulted when `ALLOWED_GROUP_ID` env is unset; a numeric
   * env value always wins and disables pairing.
   */
  pairedGroupId?: number;
  /**
   * Epoch milliseconds of the last successful heartbeat write — the bot
   * stamps this every ~10s while running. On boot we compare `now -
   * lastHeartbeatAt` against {@link HOT_RELOAD_THRESHOLD_MS}: small gaps
   * are a hot reload (quiet reattach, keep buffered updates), large gaps
   * (or `undefined` for fresh installs / older state files) are a cold
   * start (allow the per-thread "session reattached" notice, optionally
   * drop the stale update backlog).
   *
   * Optional so old `state.json` files (created before heartbeats existed)
   * remain valid — `loadStateFile`'s shape check doesn't require it, and
   * a missing value is interpreted as "treat as cold start", which is the
   * conservative default we want.
   */
  lastHeartbeatAt?: number;
}

/** Empty state used both for fresh installs and after a corruption-archive event. */
function emptyState(): StateV1 {
  return {
    version: STATE_SCHEMA_VERSION,
    bindings: {},
    agents: {},
    messages: {},
  };
}

/** Per-thread message-id cap — older ids beyond this are dropped to keep state small. */
const MESSAGE_ID_RING_CAP = 500;

/**
 * @description Promise-chain per-key lock. The map holds the tail of each
 * key's queue; new callers attach to the tail and append themselves. Errors
 * in one task don't poison followers — the chain only carries scheduling,
 * not values. See plan §13.15 (E3).
 *
 * Exported for unit tests (plan §11 Этап 7, R5).
 */
export class KeyLock {
  private chains = new Map<string, Promise<unknown>>();

  async withLock<T>(keyStr: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(keyStr);

    const run = async (): Promise<T> => {
      if (prev) {
        try {
          await prev;
        } catch {
          // Swallow predecessor failures — they shouldn't cascade to followers.
        }
      }
      return fn();
    };

    const current: Promise<T> = run();
    // Store a swallowed-error variant so this.chains.get() always resolves.
    const tracked = current.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(keyStr, tracked);

    try {
      return await current;
    } finally {
      // If no follower has overwritten our slot, drop the entry to avoid leaks.
      if (this.chains.get(keyStr) === tracked) {
        this.chains.delete(keyStr);
      }
    }
  }
}

/**
 * @description Best-effort atomic write of `content` to `finalPath`.
 *
 * Sequence: `writeFile(tmp)` → `fsync(tmp)` → `rename(tmp, final)` →
 * `fsync(parentDir)`. The last step is critical: without it, `rename`
 * survives crashes but the new directory entry can be lost on a power
 * cut on ext4 (plan §13.14, fix to T4).
 *
 * Tmp files are colocated with the final file so `rename` stays on the
 * same filesystem (cross-fs rename would degrade to copy+unlink and break
 * atomicity). Permissions on the tmp default to `0600` so a state file
 * containing model preferences / session ids isn't world-readable on a
 * shared host.
 *
 * Directory `fsync` is wrapped in a soft try/catch: on Windows opening a
 * directory for read isn't supported and would throw. Our deployment
 * target is Linux/Mac (plan §17.4 «Windows: not our case»), so logging
 * and continuing is the right trade.
 */
export async function writeFileAtomic(
  finalPath: string,
  content: string,
  options: { mode?: number } = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const dir = path.dirname(finalPath);
  const tmp = path.join(
    dir,
    `.${path.basename(finalPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  // 1. write + fsync the tmp file
  const fh = await fsp.open(tmp, 'w', mode);
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }

  // 2. atomic rename
  try {
    await fsp.rename(tmp, finalPath);
  } catch (e) {
    // Try to clean up the tmp if rename fails so we don't litter the dir.
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }

  // 3. fsync the parent directory so the rename hits disk
  try {
    const dh = await fsp.open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch (e) {
    // EISDIR / ENOTSUP on Windows, AIX etc. We document Linux/Mac so this is benign.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EINVAL') {
      console.warn(`[state] parent dir fsync failed (${code}):`, e);
    }
  }
}

/**
 * @description Try to load the state file. On a successful parse return the
 * structured state. On parse failure archive the broken file to
 * `state.json.corrupted-<iso>` and return `null` so the caller can start fresh.
 *
 * Three cases the caller cares about:
 *
 *   1. File doesn't exist → `null`, no archive. Fresh install.
 *   2. File exists, parses → state object.
 *   3. File exists, parses fails → archived, `null` returned.
 *      We also handle EPERM / EACCES on read here for completeness — same
 *      treatment: archive (if possible) and start fresh.
 *
 * Exported for unit tests (plan §11 Этап 7, R6).
 */
export async function loadStateFile(filePath: string): Promise<
  | { ok: true; state: StateV1 }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'corrupted'; archivedTo: string | null; error: string }
> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing' };
    // Unreadable (perms, disk error) — treat like corruption so the bot can boot.
    return {
      ok: false,
      reason: 'corrupted',
      archivedTo: null,
      error: `read failed (${code}): ${(e as Error).message}`,
    };
  }

  try {
    const parsed = JSON.parse(raw) as StateV1;
    // Light shape validation — full migrations would land here on a version bump.
    if (
      typeof parsed === 'object' && parsed !== null &&
      typeof parsed.version === 'number' &&
      parsed.bindings && typeof parsed.bindings === 'object' &&
      parsed.agents && typeof parsed.agents === 'object' &&
      parsed.messages && typeof parsed.messages === 'object'
    ) {
      return { ok: true, state: parsed };
    }
    throw new Error('shape mismatch');
  } catch (e) {
    const archivedTo = await archiveCorruptedFile(filePath);
    return {
      ok: false,
      reason: 'corrupted',
      archivedTo,
      error: (e as Error).message,
    };
  }
}

/**
 * @description Rename a corrupted state file out of the way so the bot
 * can boot with a fresh state without losing forensic evidence.
 *
 * Returns the archive path on success, `null` if archival itself failed
 * (in which case we'll log and the caller proceeds with fresh state anyway).
 */
async function archiveCorruptedFile(filePath: string): Promise<string | null> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = `${filePath}.corrupted-${ts}`;
  try {
    await fsp.rename(filePath, archive);
    return archive;
  } catch (e) {
    console.error(`[state] failed to archive corrupted file ${filePath}:`, e);
    return null;
  }
}

/**
 * @description Migrate the legacy single-folder bot's message-id file.
 *
 * Old layout: `~/.telegram-bot-messages.json` keyed by raw user id.
 * The 2.0 release intentionally doesn't try to merge those ids into the
 * new `ThreadKey`-keyed schema — the routing model changed too much for
 * a clean mapping (plan §9). We just rename the file so it's preserved
 * for the user's records and so it stops being read on every boot.
 *
 * Returns the archive path if migration happened, `null` otherwise.
 */
export async function migrateLegacyMessageIdsFile(): Promise<string | null> {
  const legacy = path.join(os.homedir(), '.telegram-bot-messages.json');
  try {
    await fsp.access(legacy);
  } catch {
    return null;
  }
  const backup = `${legacy}.bak`;
  try {
    await fsp.rename(legacy, backup);
    return backup;
  } catch (e) {
    console.warn(`[state] failed to archive legacy ${legacy}:`, e);
    return null;
  }
}

export interface StateStoreOptions {
  /** Override the debounce window for tests. */
  saveDebounceMs?: number;
}

/**
 * @description Stateful, async-safe store for `state.json`.
 *
 * Construction is cheap (no I/O). Call `init()` once at boot before any
 * setters fire; init loads or initialises the file, performs the legacy
 * migration, and resolves. Setters return promises so callers can await
 * the resulting persisted state when correctness matters more than
 * throughput; non-critical writes are debounced.
 */
export class StateStore {
  private readonly dataDir: string;
  private readonly statePath: string;
  private readonly saveDebounceMs: number;

  private state: StateV1 = emptyState();
  /** True if the previous on-disk state file was unreadable / corrupt. */
  private corruptedOnLoad = false;
  /** Archive path if the previous on-disk state was corrupted. */
  private corruptedArchivePath: string | null = null;
  /** Backup path if the legacy file was migrated. */
  private legacyMigrationPath: string | null = null;

  private saveTimer: NodeJS.Timeout | null = null;
  /** Tail of the chained writes so two flushes don't try to rename simultaneously. */
  private writeChain: Promise<unknown> = Promise.resolve();

  private readonly keyLock = new KeyLock();

  constructor(dataDir: string, options: StateStoreOptions = {}) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, 'state.json');
    this.saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
  }

  /**
   * @description One-shot boot. Creates `dataDir` if missing, performs
   * legacy migration, loads the existing state file (or starts fresh on
   * corruption).
   */
  async init(): Promise<void> {
    await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    this.legacyMigrationPath = await migrateLegacyMessageIdsFile();

    const loaded = await loadStateFile(this.statePath);
    if (loaded.ok) {
      this.state = loaded.state;
      // Top up missing fields if loaded from an older v1 file.
      this.state.bindings ??= {};
      this.state.agents ??= {};
      this.state.messages ??= {};
    } else if (loaded.reason === 'missing') {
      this.state = emptyState();
      // No save: nothing yet to persist. First setter will trigger a debounce.
    } else {
      this.corruptedOnLoad = true;
      this.corruptedArchivePath = loaded.archivedTo;
      console.error(
        `[state] previous state.json was corrupted (${loaded.error}); ` +
          `archived to ${loaded.archivedTo ?? '(archive failed)'}, starting fresh`,
      );
      this.state = emptyState();
      await this.flush();
    }
  }

  /** Path of the live state file (for logging / docs / smoke-tests). */
  get stateFilePath(): string {
    return this.statePath;
  }

  /** True iff the previous boot's state file was unreadable on this start. */
  wasCorruptedOnLoad(): boolean {
    return this.corruptedOnLoad;
  }

  /** Where the previous corrupted file was moved, if archival succeeded. */
  getCorruptedArchivePath(): string | null {
    return this.corruptedArchivePath;
  }

  /** Where the legacy `~/.telegram-bot-messages.json` was archived, if it existed. */
  getLegacyMigrationPath(): string | null {
    return this.legacyMigrationPath;
  }

  // ── locking ──

  /**
   * @description Run `fn` while holding the per-key lock for `key`. Concurrent
   * calls for the SAME key are serialised; calls for different keys run in
   * parallel. Failure in one holder does NOT propagate to followers (the lock
   * is for serialisation only; error handling is each caller's job).
   */
  withLock<T>(key: ThreadKey, fn: () => Promise<T>): Promise<T> {
    return this.keyLock.withLock(keyToString(key), fn);
  }

  // ── bindings ──

  getBinding(key: ThreadKey): BindingData | null {
    return this.state.bindings[keyToString(key)] ?? null;
  }

  async setBinding(
    key: ThreadKey,
    subdir: string,
    options: { closed?: boolean } = {},
  ): Promise<void> {
    const k = keyToString(key);
    await this.withLock(key, async () => {
      const existing = this.state.bindings[k];
      // Audit S20 / #44: previous code path used `existing?.closed ? …`,
      // which falsy-collapsed an explicit `closed: false` and dropped
      // the field entirely. Now we carry `closed` through verbatim,
      // letting `false` and `true` round-trip independently.
      const next: BindingData = {
        subdir,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      if (options.closed !== undefined) {
        next.closed = options.closed;
      } else if (existing?.closed !== undefined) {
        next.closed = existing.closed;
      }
      if (existing?.pinnedStatusMessageId !== undefined) {
        next.pinnedStatusMessageId = existing.pinnedStatusMessageId;
      }
      this.state.bindings[k] = next;
      this.scheduleSave();
    });
  }

  async setBindingClosed(key: ThreadKey, closed: boolean): Promise<void> {
    const k = keyToString(key);
    await this.withLock(key, async () => {
      const existing = this.state.bindings[k];
      if (!existing) return;
      this.state.bindings[k] = { ...existing, closed };
      this.scheduleSave();
    });
  }

  /**
   * @description Persist the pinned status banner's message id for a thread,
   * or clear it (pass `null`). Skipped if the binding doesn't exist — we
   * don't ever want a pinned-message row dangling without a parent binding.
   *
   * Caller is expected to actually pin / unpin in Telegram around this
   * call; this method only updates the on-disk pointer. Plan §20.5.
   */
  async setBindingPinnedStatusMessageId(
    key: ThreadKey,
    messageId: number | null,
  ): Promise<void> {
    const k = keyToString(key);
    await this.withLock(key, async () => {
      const existing = this.state.bindings[k];
      if (!existing) return;
      if (messageId === null) {
        if (existing.pinnedStatusMessageId === undefined) return;
        const { pinnedStatusMessageId: _drop, ...rest } = existing;
        this.state.bindings[k] = rest;
      } else {
        if (existing.pinnedStatusMessageId === messageId) return;
        this.state.bindings[k] = { ...existing, pinnedStatusMessageId: messageId };
      }
      this.scheduleSave();
    });
  }

  /**
   * @description Persist the last banner text sent/edited for a thread, or
   * clear it (pass `null`). Mirrors {@link setBindingPinnedStatusMessageId}:
   * skipped if the binding doesn't exist, and a no-op (no save) when the value
   * is unchanged. Read back at boot to seed `pinnedStatusTextCache` so the
   * startup refresh wave skips identical-banner edits (B8).
   */
  async setBindingPinnedStatusText(
    key: ThreadKey,
    text: string | null,
  ): Promise<void> {
    const k = keyToString(key);
    await this.withLock(key, async () => {
      const existing = this.state.bindings[k];
      if (!existing) return;
      if (text === null) {
        if (existing.pinnedStatusText === undefined) return;
        const { pinnedStatusText: _drop, ...rest } = existing;
        this.state.bindings[k] = rest;
      } else {
        if (existing.pinnedStatusText === text) return;
        this.state.bindings[k] = { ...existing, pinnedStatusText: text };
      }
      this.scheduleSave();
    });
  }

  async removeBinding(key: ThreadKey): Promise<void> {
    const k = keyToString(key);
    await this.withLock(key, async () => {
      delete this.state.bindings[k];
      delete this.state.agents[k];
      delete this.state.messages[k];
      this.scheduleSave();
    });
  }

  listBindings(): Array<{ key: ThreadKey; data: BindingData }> {
    const out: Array<{ key: ThreadKey; data: BindingData }> = [];
    for (const [keyStr, data] of Object.entries(this.state.bindings)) {
      const key = parseKeyString(keyStr);
      if (key) out.push({ key, data });
    }
    return out;
  }

  /**
   * @description Find every thread currently bound to a given subdir.
   * Plan §10.6 names this for `/bind` UX warning «📁 уже работают треды: ...»
   * — one folder may be reached from several threads (D7).
   */
  listKeysForSubdir(subdir: string): ThreadKey[] {
    const out: ThreadKey[] = [];
    for (const [keyStr, data] of Object.entries(this.state.bindings)) {
      if (data.subdir === subdir) {
        const key = parseKeyString(keyStr);
        if (key) out.push(key);
      }
    }
    return out;
  }

  // ── agents ──

  getAgent(key: ThreadKey): AgentData | null {
    return this.state.agents[keyToString(key)] ?? null;
  }

  /**
   * @description Upsert agent state for a thread. `name` is required (we
   * don't keep an agent record without a backend choice); the rest of the
   * fields are patched onto whatever exists.
   */
  async setAgent(
    key: ThreadKey,
    data: { name: string } & Partial<Omit<AgentData, 'name'>>,
  ): Promise<void> {
    const k = keyToString(key);
    await this.withLock(key, async () => {
      const existing = this.state.agents[k];
      this.state.agents[k] = { ...existing, ...data };
      this.scheduleSave();
    });
  }

  async removeAgent(key: ThreadKey): Promise<void> {
    const k = keyToString(key);
    await this.withLock(key, async () => {
      delete this.state.agents[k];
      this.scheduleSave();
    });
  }

  getClaudeSessionId(key: ThreadKey): string | null {
    return this.state.agents[keyToString(key)]?.claudeSessionId ?? null;
  }

  /**
   * @description Persist the Claude `--session-id` UUID for `key`.
   *
   * If the thread already has an agent record, only the `claudeSessionId`
   * field is patched — we keep whatever `name` was previously chosen so a
   * thread currently set to `opencode` doesn't get silently flipped to
   * `claude` just because we recorded a UUID. The bot picks the adapter
   * via {@link setAgent} or `setThreadAdapter` — those are the right
   * places to change `name`.
   */
  async setClaudeSessionId(key: ThreadKey, uuid: string): Promise<void> {
    const k = keyToString(key);
    await this.withLock(key, async () => {
      const existing = this.state.agents[k];
      this.state.agents[k] = existing
        ? { ...existing, claudeSessionId: uuid }
        : { name: 'claude', claudeSessionId: uuid };
      this.scheduleSave();
    });
  }

  getOpenCodeSessionId(key: ThreadKey): string | null {
    return this.state.agents[keyToString(key)]?.opencodeSessionId ?? null;
  }

  /** Symmetric to {@link setClaudeSessionId} — does not flip `agent.name`. */
  async setOpenCodeSessionId(key: ThreadKey, id: string): Promise<void> {
    const k = keyToString(key);
    await this.withLock(key, async () => {
      const existing = this.state.agents[k];
      this.state.agents[k] = existing
        ? { ...existing, opencodeSessionId: id }
        : { name: 'opencode', opencodeSessionId: id };
      this.scheduleSave();
    });
  }

  // ── messages (`/clear` support) ──

  getMessageIds(key: ThreadKey): number[] {
    return this.state.messages[keyToString(key)]?.slice() ?? [];
  }

  /**
   * @description Append a message id to the per-thread tracking list and
   * trim to the most recent `MESSAGE_ID_RING_CAP`. Anything older falls off
   * the end — Telegram won't let `deleteMessages` touch messages older than
   * 48h anyway (plan §11 Этап 3, U2).
   */
  async pushMessageId(key: ThreadKey, msgId: number): Promise<void> {
    const k = keyToString(key);
    await this.withLock(key, async () => {
      const list = (this.state.messages[k] ??= []);
      list.push(msgId);
      if (list.length > MESSAGE_ID_RING_CAP) {
        this.state.messages[k] = list.slice(-MESSAGE_ID_RING_CAP);
      }
      this.scheduleSave();
    });
  }

  async clearMessageIds(key: ThreadKey): Promise<void> {
    const k = keyToString(key);
    await this.withLock(key, async () => {
      delete this.state.messages[k];
      this.scheduleSave();
    });
  }

  // ── heartbeat (hot-reload vs cold-start detection) ──

  /**
   * @description Stamp `lastHeartbeatAt = now` (ms) and schedule a debounced
   * save. Called by the bot on a ~10s interval while running so the next
   * boot can tell a hot reload (gap < threshold) from a real cold start
   * (gap large, or no stamp at all on a fresh install).
   *
   * Cheap by design: a one-field mutation that piggy-backs on the existing
   * debounced save loop. We don't `flush()` here — losing the last 10s
   * heartbeat on a hard crash just biases the next boot toward
   * "cold start", which is the conservative direction.
   */
  touchHeartbeat(now: number = Date.now()): void {
    this.state.lastHeartbeatAt = now;
    this.scheduleSave();
  }

  /**
   * @description Time since the last persisted heartbeat in ms, or `null`
   * if the state file has no heartbeat stamp (fresh install, or pre-feature
   * state file). `null` should be treated as "unknown → assume cold start".
   *
   * Read at boot to decide hot-vs-cold-start, ideally BEFORE the first
   * `touchHeartbeat()` call or `state.flush()` (otherwise the value
   * compares against ourselves and always looks like a hot reload).
   */
  getDowntimeMs(now: number = Date.now()): number | null {
    const last = this.state.lastHeartbeatAt;
    if (typeof last !== 'number' || !Number.isFinite(last)) return null;
    return Math.max(0, now - last);
  }

  // ── paired group id (auto-pairing) ──

  /** The auto-paired forum supergroup id, or `null` if never paired. */
  getPairedGroupId(): number | null {
    return this.state.pairedGroupId ?? null;
  }

  /**
   * @description Persist the auto-paired group id and flush immediately.
   *
   * Unlike per-thread mutations this is a rare, one-shot critical write:
   * if the process dies right after pairing we must not lose the id and
   * fall back into pairing mode on the next boot. So we `flush()` rather
   * than debounce.
   */
  async setPairedGroupId(groupId: number): Promise<void> {
    this.state.pairedGroupId = groupId;
    await this.flush();
  }

  // ── persistence ──

  /** Schedule a save in `saveDebounceMs`. Repeated calls reset the timer. */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // Errors are logged inside flush; we don't want to crash the timer chain.
      this.flush().catch(e => console.error('[state] background flush failed:', e));
    }, this.saveDebounceMs);
  }

  /**
   * @description Force a save right now and await on-disk persistence.
   *
   * Used by:
   *   - shutdown handlers — to guarantee no in-memory state is lost,
   *   - critical paths (initial corruption-archived fresh-start),
   *   - tests.
   *
   * Internally serialises against any in-flight write — only one rename
   * happens at a time per store.
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const snapshot = JSON.stringify(this.state, null, 2);
    const writeNow = () => writeFileAtomic(this.statePath, snapshot);
    const next = this.writeChain.then(writeNow, writeNow);
    this.writeChain = next.catch(() => {});
    await next;
  }
}

/**
 * @description Inverse of `keyToString` that doesn't throw on malformed
 * input — returns `null` so callers can skip rogue keys (e.g. a state file
 * hand-edited by the user).
 */
function parseKeyString(s: string): ThreadKey | null {
  const idx = s.indexOf(':');
  if (idx <= 0 || idx === s.length - 1) return null;
  const chatId = Number(s.slice(0, idx));
  const threadId = Number(s.slice(idx + 1));
  if (!Number.isFinite(chatId) || !Number.isFinite(threadId)) return null;
  return { chatId, threadId };
}

// ─── singleton wiring ────────────────────────────────────────────────

let singleton: StateStore | null = null;
let singletonInFlight: Promise<StateStore> | null = null;

/**
 * @description Resolve the default `DATA_DIR` for the running bot.
 *
 * Priority:
 *   1. `process.env.DATA_DIR` (set by the operator — required for the
 *      two-instance setup, plan §10.7).
 *   2. `~/.telegramCode` — single-instance default.
 *
 * Two bots on the same host MUST set distinct `DATA_DIR` values, otherwise
 * they'd silently share `state.json` and corrupt each other. Plan §16.2
 * adds a startup `.lock` check; that lives in `bot.ts` (Этап 3), not here.
 */
export function resolveDataDir(): string {
  return process.env.DATA_DIR || path.join(os.homedir(), '.telegramCode');
}

/**
 * @description Create-or-fetch the singleton store. The first call performs
 * `init()` and persists archival/migration side-effects; subsequent calls
 * just return the cached instance.
 *
 * The in-flight promise is cached to keep concurrent first-callers from
 * each constructing a separate `StateStore` (two stores → two competing
 * write chains → corrupted JSON). Production triggers only one call from
 * `startBot()`, but the cost of the guard is trivial.
 *
 * Tests should instantiate `new StateStore(...)` directly instead.
 */
export async function getStateStore(): Promise<StateStore> {
  if (singleton) return singleton;
  if (singletonInFlight) return singletonInFlight;
  singletonInFlight = (async () => {
    const store = new StateStore(resolveDataDir());
    await store.init();
    singleton = store;
    return store;
  })();
  try {
    return await singletonInFlight;
  } finally {
    singletonInFlight = null;
  }
}

/**
 * @description Reset the singleton — only for tests. Production code should
 * never call this; doing so would leak in-flight write promises.
 */
export function _resetStateStoreSingletonForTests(): void {
  singleton = null;
  singletonInFlight = null;
}

// Re-export `fs` flag used by tests to confirm the file ended up where we
// expect it; keeps the test surface from depending on `path` directly.
export { fs as _fsForTests };
